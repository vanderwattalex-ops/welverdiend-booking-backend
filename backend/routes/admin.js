const express = require("express");
const router = express.Router();
const { bookingsCollection, bucket, siteAssetsBucket, availabilityCollection, overridesCollection } = require("../lib/db");
const { requireAdmin } = require("./adminAuth");
const { units } = require("../config/units");
const { rangesOverlap, subtractRanges } = require("../lib/rangeUtils");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const sharp = require("sharp");
const {
  notifyGuestApproved, notifyGuestConfirmed, notifyGuestDeclined,
  notifyGuestBalanceDue, notifyGuestPaidInFull, sendTestEmail
} = require("../lib/email");
const { getSettings, saveSettings } = require("../lib/settings");
const { generateInvoice } = require("../lib/invoice");
const { syncUnitAndSave } = require("../lib/availabilitySync");
const {
  getSiteContent,
  saveAboutParagraphs, addGalleryPhoto, removeGalleryPhoto, movePhoto, setPhotoSection,
  addGallerySection, renameGallerySection, removeGallerySection,
  setHeroPhoto, addReview, removeReview, addFaq, removeFaq, addRecommendation, removeRecommendation,
  GALLERY_IDS, SECTIONED_GALLERY_IDS
} = require("../lib/siteContent");
const { getAnalyticsSummary } = require("../lib/analytics");

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB — generous, since every upload gets auto-compressed below anyway
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Please upload a JPG, PNG, or WebP image"), ok);
  }
});

/**
 * Resizes and compresses an uploaded photo before it's stored — so
 * nobody ever has to manually shrink a photo before uploading it.
 * Caps width at 1600px (plenty for a website gallery) and re-encodes
 * as a reasonably-compressed JPEG.
 */
async function compressPhoto(buffer) {
  return sharp(buffer)
    .rotate() // respects the photo's original orientation (important for phone photos)
    .resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
}

router.use(requireAdmin);
router.use(express.json());

function unitName(unitId) {
  const u = units.find(x => x.id === unitId);
  return u ? u.name : unitId;
}

function logEmailFail(label) {
  return err => console.error(`[admin] ${label} email failed to send:`, err);
}

// GET /api/admin/bookings?status=requested
router.get("/admin/bookings", async (req, res) => {
  try {
    // Filtering by status AND sorting by date in the same Firestore query
    // needs a manually-created composite index. Simpler and just as fast
    // at this scale: filter in Firestore, sort here instead.
    let q = bookingsCollection;
    if (req.query.status) q = q.where("status", "==", req.query.status);
    const snap = await q.get();
    const bookings = snap.docs.map(d => d.data()).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    res.json({ ok: true, bookings });
  } catch (err) {
    console.error("[admin] list bookings failed:", err);
    res.status(500).json({ ok: false, error: "Could not load bookings" });
  }
});

// GET /api/admin/booking-stats
// A unified, read-only list of confirmed bookings across all four sources
// (Airbnb, Booking.com, Lekkeslaap, Direct), for external reporting tools
// (the booking-stats app). Direct bookings come from `bookings` with full
// detail; OTA bookings only ever exist as anonymized busy ranges in
// `availability` (iCal feeds carry no price or guest identity), so those
// come back with guestName/totalAmount left null — the caller is expected
// to apply its own per-source nightly rate, same as the admin calendar
// already treats these sources as date-only.
router.get("/admin/booking-stats", async (req, res) => {
  try {
    const bookingsSnap = await bookingsCollection.where("status", "==", "confirmed").get();
    const direct = bookingsSnap.docs.map(d => {
      const b = d.data();
      return {
        id: b.id,
        unitId: b.unitId,
        source: "direct",
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        nights: b.nights,
        guestName: b.guestName || "",
        totalAmount: typeof b.totalAmount === "number" ? b.totalAmount : null
      };
    });

    const availSnap = await availabilityCollection.get();
    const ota = [];
    availSnap.docs.forEach(doc => {
      const unitId = doc.id;
      const busyRanges = doc.data().busyRanges || [];
      busyRanges.forEach(range => {
        // A single stay can block more than one platform's calendar at once
        // (e.g. a channel-manager sync, or a host-side block mirrored across
        // sites) — mergeRanges() already folds that overlap into one range
        // with multiple `sources`. Counting one income entry per source in
        // that array would double- (or triple-) count the same stay, so
        // this only ever emits ONE entry per range, using its first
        // non-direct source.
        const nonDirectSources = (range.sources || []).filter(s => s !== "direct");
        if (nonDirectSources.length === 0) return; // direct-only range, already covered above
        const source = nonDirectSources[0];
        ota.push({
          id: `${range.start}_${unitId}_${source}`,
          unitId,
          source,
          checkIn: range.start,
          checkOut: range.end,
          nights: null,
          guestName: "",
          totalAmount: null
        });
      });
    });

    const bookings = [...direct, ...ota].sort((a, b) => (a.checkIn || "").localeCompare(b.checkIn || ""));
    res.json({ ok: true, bookings });
  } catch (err) {
    console.error("[admin] booking-stats failed:", err);
    res.status(500).json({ ok: false, error: "Could not load booking stats" });
  }
});

/**
 * Streams a proof-of-payment file straight from Cloud Storage through
 * the backend, rather than generating a Cloud Storage "signed URL" —
 * signed URLs need an extra IAM permission (signBlob) that Cloud Run's
 * default service account doesn't have by default, which is what was
 * causing "could not get file link" errors. Streaming it ourselves only
 * needs the read permission the service already has.
 */
async function streamProof(req, res, pathField) {
  try {
    const doc = await bookingsCollection.doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: "Booking not found" });
    const booking = doc.data();
    const objectPath = booking[pathField];
    if (!objectPath) return res.status(404).json({ ok: false, error: "No proof of payment uploaded yet" });

    const file = bucket.file(objectPath);
    const [exists] = await file.exists();
    if (!exists) return res.status(404).json({ ok: false, error: "That file couldn't be found in storage — it may not have finished uploading." });

    const [meta] = await file.getMetadata();
    res.setHeader("Content-Type", meta.contentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${objectPath.split("/").pop()}"`);
    file.createReadStream()
      .on("error", err => {
        console.error("[admin] proof stream failed:", err);
        if (!res.headersSent) res.status(500).json({ ok: false, error: "Could not read that file from storage" });
      })
      .pipe(res);
  } catch (err) {
    console.error("[admin] proof download failed:", err);
    if (!res.headersSent) res.status(500).json({ ok: false, error: "Could not load that file" });
  }
}

// GET /api/admin/bookings/:id/proof  -> the deposit proof file
router.get("/admin/bookings/:id/proof", (req, res) => streamProof(req, res, "proofOfPaymentPath"));

// GET /api/admin/bookings/:id/balance-proof  -> the final-payment proof file
router.get("/admin/bookings/:id/balance-proof", (req, res) => streamProof(req, res, "balanceProofPath"));

// GET /api/admin/bookings/:id/invoice  -> the invoice PDF, generated fresh each time
router.get("/admin/bookings/:id/invoice", async (req, res) => {
  try {
    const doc = await bookingsCollection.doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: "Not found" });
    const booking = doc.data();
    if (!["awaiting_payment", "submitted", "confirmed"].includes(booking.status)) {
      return res.status(409).json({ ok: false, error: "An invoice is only available once a booking has been approved." });
    }
    const buffer = await generateInvoice(booking, unitName(booking.unitId));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="invoice-${booking.id.slice(0, 8)}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error("[admin] invoice generation failed:", err);
    res.status(500).json({ ok: false, error: "Could not generate invoice" });
  }
});

// -----------------------------------------------------------------
// STAGE 1 — approve or decline the initial request, before any
// payment happens. Approving re-checks live availability first, so a
// sync gap (e.g. a same-day Airbnb booking that hasn't synced yet)
// gets caught here instead of double-booking a unit.
// -----------------------------------------------------------------

// POST /api/admin/bookings/:id/approve
router.post("/admin/bookings/:id/approve", async (req, res) => {
  try {
    const ref = bookingsCollection.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: "Not found" });
    const booking = doc.data();
    if (booking.status !== "requested") {
      return res.status(409).json({ ok: false, error: `This booking is already "${booking.status}", not awaiting approval.` });
    }

    // Re-check against the latest synced availability — this is the
    // moment that catches a sync problem before the guest ever pays.
    const availDoc = await availabilityCollection.doc(booking.unitId).get();
    const busyRanges = availDoc.exists ? availDoc.data().busyRanges || [] : [];
    const conflict = busyRanges.some(r => rangesOverlap(booking.checkIn, booking.checkOut, r.start, r.end));
    if (conflict) {
      return res.status(409).json({
        ok: false,
        error: "These dates now show as booked elsewhere (likely a sync update since the request came in). Decline this request and ask the guest to pick different dates."
      });
    }

    await ref.update({ status: "awaiting_payment", approvedAt: new Date().toISOString() });
    // Approving is what actually blocks the dates — re-sync this unit's
    // availability right away so the calendar reflects it immediately,
    // instead of waiting up to 5 minutes for the next scheduled sync.
    syncUnitAndSave(booking.unitId).catch(err => console.error("[admin] immediate sync after approve failed:", err));
    const uName = unitName(booking.unitId);
    generateInvoice({ ...booking, status: "awaiting_payment" }, uName)
      .then(invoiceBuffer => notifyGuestApproved(booking, uName, invoiceBuffer))
      .catch(logEmailFail("approve"));
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin] approve failed:", err);
    res.status(500).json({ ok: false, error: "Could not approve booking" });
  }
});

// POST /api/admin/bookings/:id/mark-deposit-received
// For when payment was confirmed some other way (bank statement,
// WhatsApp, cash) and there's no proof-of-payment file to wait for.
// Skips straight to "submitted" — the same state a guest's own proof
// upload would put it in — so it shows up ready for final confirmation.
router.post("/admin/bookings/:id/mark-deposit-received", async (req, res) => {
  try {
    const ref = bookingsCollection.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: "Not found" });
    const booking = doc.data();
    if (booking.status !== "awaiting_payment") {
      return res.status(409).json({ ok: false, error: `This booking is "${booking.status}" — only bookings awaiting a deposit can be marked this way.` });
    }

    await ref.update({ status: "submitted", proofUploadedAt: new Date().toISOString(), depositManuallyMarked: true });
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin] mark-deposit-received failed:", err);
    res.status(500).json({ ok: false, error: "Could not mark deposit as received" });
  }
});

// POST /api/admin/bookings/:id/decline   body: { reason? }
router.post("/admin/bookings/:id/decline", async (req, res) => {
  try {
    const ref = bookingsCollection.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: "Not found" });
    const booking = doc.data();
    if (booking.status !== "requested" && booking.status !== "awaiting_payment") {
      return res.status(409).json({ ok: false, error: `This booking is "${booking.status}" — decline is only for requests that haven't been confirmed yet.` });
    }

    await ref.update({ status: "rejected", decidedAt: new Date().toISOString(), declineReason: req.body.reason || "" });
    // If this was already "awaiting_payment", it was holding the dates —
    // release them immediately rather than waiting for the next sync.
    syncUnitAndSave(booking.unitId).catch(err => console.error("[admin] immediate sync after decline failed:", err));
    notifyGuestDeclined(booking, unitName(booking.unitId), req.body.reason).catch(logEmailFail("decline"));
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin] decline failed:", err);
    res.status(500).json({ ok: false, error: "Could not decline booking" });
  }
});

// -----------------------------------------------------------------
// STAGE 2 — final confirm/reject, after the guest has uploaded DEPOSIT
// proof of payment. Confirming is what actually blocks the dates on
// the calendar (via the "confirmed" status feeding into /api/sync),
// and starts the balance (final 50%) tracking.
// -----------------------------------------------------------------

// POST /api/admin/bookings/:id/confirm
router.post("/admin/bookings/:id/confirm", async (req, res) => {
  try {
    const ref = bookingsCollection.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: "Not found" });
    const booking = doc.data();
    if (booking.status !== "submitted") {
      return res.status(409).json({ ok: false, error: `This booking is "${booking.status}" — deposit proof of payment hasn't been uploaded yet.` });
    }

    await ref.update({ status: "confirmed", decidedAt: new Date().toISOString(), balanceStatus: booking.balanceStatus || "unpaid" });
    // Note: the dates block as soon as the next /api/sync run picks up
    // this "confirmed" status (every 5 minutes) — or trigger /api/sync
    // manually for it to take effect immediately.
    const uName = unitName(booking.unitId);
    generateInvoice({ ...booking, status: "confirmed" }, uName)
      .then(invoiceBuffer => notifyGuestConfirmed(booking, uName, invoiceBuffer))
      .catch(logEmailFail("confirm"));
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin] confirm failed:", err);
    res.status(500).json({ ok: false, error: "Could not confirm booking" });
  }
});

// POST /api/admin/bookings/:id/reject   body: { reason? }
router.post("/admin/bookings/:id/reject", async (req, res) => {
  try {
    const ref = bookingsCollection.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: "Not found" });
    const booking = doc.data();
    if (booking.status !== "submitted") {
      return res.status(409).json({ ok: false, error: `This booking is "${booking.status}" — reject is only for bookings awaiting final confirmation.` });
    }

    await ref.update({ status: "rejected", decidedAt: new Date().toISOString(), declineReason: req.body.reason || "" });
    // This booking was "submitted" — i.e. still holding its dates —
    // release them immediately rather than waiting for the next sync.
    syncUnitAndSave(booking.unitId).catch(err => console.error("[admin] immediate sync after reject failed:", err));
    notifyGuestDeclined(booking, unitName(booking.unitId), req.body.reason).catch(logEmailFail("reject"));
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin] reject failed:", err);
    res.status(500).json({ ok: false, error: "Could not reject booking" });
  }
});

// -----------------------------------------------------------------
// STAGE 3 — the balance (final 50%), due before check-in. You can
// manually mark it paid (e.g. confirmed by phone/cash) or send the
// guest a reminder email with the same upload link.
// -----------------------------------------------------------------

// POST /api/admin/bookings/:id/balance/remind
router.post("/admin/bookings/:id/balance/remind", async (req, res) => {
  try {
    const doc = await bookingsCollection.doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: "Not found" });
    const booking = doc.data();
    if (booking.status !== "confirmed") {
      return res.status(409).json({ ok: false, error: "This booking isn't confirmed yet." });
    }
    await notifyGuestBalanceDue(booking, unitName(booking.unitId));
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin] balance reminder failed:", err);
    res.status(500).json({ ok: false, error: "Could not send the reminder email" });
  }
});

// POST /api/admin/bookings/:id/balance/mark-paid
router.post("/admin/bookings/:id/balance/mark-paid", async (req, res) => {
  try {
    const ref = bookingsCollection.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: "Not found" });
    const booking = doc.data();
    if (booking.status !== "confirmed") {
      return res.status(409).json({ ok: false, error: "This booking isn't confirmed yet — there's no balance to mark paid." });
    }
    await ref.update({ balanceStatus: "paid", balancePaidAt: new Date().toISOString() });
    const uName = unitName(booking.unitId);
    generateInvoice({ ...booking, balanceStatus: "paid" }, uName)
      .then(invoiceBuffer => notifyGuestPaidInFull(booking, uName, invoiceBuffer))
      .catch(logEmailFail("balance-paid"));
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin] mark balance paid failed:", err);
    res.status(500).json({ ok: false, error: "Could not update the balance status" });
  }
});

// DELETE /api/admin/bookings/:id
// For cleaning up test bookings or ones you never want to see again —
// this only removes the record itself, no emails are sent.
router.delete("/admin/bookings/:id", async (req, res) => {
  try {
    const ref = bookingsCollection.doc(req.params.id);
    const doc = await ref.get();
    const booking = doc.exists ? doc.data() : null;
    await ref.delete();
    // If this booking was holding dates (awaiting_payment/submitted/
    // confirmed), releasing them immediately avoids a stale block
    // sitting there until the next scheduled sync.
    if (booking) syncUnitAndSave(booking.unitId).catch(err => console.error("[admin] immediate sync after delete failed:", err));
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin] delete booking failed:", err);
    res.status(500).json({ ok: false, error: "Could not delete that booking" });
  }
});

// -----------------------------------------------------------------
// Calendar view — every unit's busy ranges with source/guest detail,
// so you can see WHY a day is blocked and WHO it's for, plus any
// manual unblocks currently in effect.
// -----------------------------------------------------------------

// GET /api/admin/calendar
router.get("/admin/calendar", async (req, res) => {
  try {
    const availSnap = await availabilityCollection.get();
    const overridesSnap = await overridesCollection.get();
    const overridesByUnit = {};
    overridesSnap.forEach(doc => {
      const o = { id: doc.id, ...doc.data() };
      (overridesByUnit[o.unitId] = overridesByUnit[o.unitId] || []).push(o);
    });

    const unitsOut = units.map(u => {
      const avail = availSnap.docs.find(d => d.id === u.id);
      return {
        unitId: u.id,
        unitName: u.name,
        busyRanges: avail ? avail.data().busyRanges || [] : [],
        lastSyncedAt: avail ? avail.data().lastSyncedAt : null,
        feedHealth: avail ? avail.data().feedHealth || {} : {},
        overrides: overridesByUnit[u.id] || []
      };
    });
    res.json({ ok: true, units: unitsOut });
  } catch (err) {
    console.error("[admin] calendar failed:", err);
    res.status(500).json({ ok: false, error: "Could not load calendar" });
  }
});

// POST /api/admin/overrides   body: { unitId, start, end, reason }
// Manually unblocks a date range (e.g. a cancelled booking, or a stale
// sync). Takes effect immediately on the stored availability, and
// survives future syncs because /api/sync re-applies all overrides
// every run.
router.post("/admin/overrides", async (req, res) => {
  try {
    const { unitId, start, end, reason } = req.body;
    if (!units.find(u => u.id === unitId)) return res.status(400).json({ ok: false, error: "Unknown unit" });
    if (!start || !end || start >= end) return res.status(400).json({ ok: false, error: "Invalid date range" });

    const id = uuidv4();
    await overridesCollection.doc(id).set({ id, unitId, start, end, reason: reason || "", createdAt: new Date().toISOString() });

    // Apply immediately rather than waiting for the next sync run.
    const availDoc = await availabilityCollection.doc(unitId).get();
    if (availDoc.exists) {
      const data = availDoc.data();
      data.busyRanges = subtractRanges(data.busyRanges || [], [{ start, end }]);
      await availabilityCollection.doc(unitId).set(data);
    }

    res.json({ ok: true, id });
  } catch (err) {
    console.error("[admin] create override failed:", err);
    res.status(500).json({ ok: false, error: "Could not unblock those dates" });
  }
});

// DELETE /api/admin/overrides/:id
// Removes a manual unblock — the range goes back to whatever the next
// sync determines (blocked again if the source booking is still there).
router.delete("/admin/overrides/:id", async (req, res) => {
  try {
    await overridesCollection.doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin] delete override failed:", err);
    res.status(500).json({ ok: false, error: "Could not remove override" });
  }
});

// -----------------------------------------------------------------
// Settings — pricing, extras, bank details, and the notification
// email, editable from the admin dashboard's Settings tab. Unit names
// and iCal source links stay fixed in the codebase; everything here is
// stored in Firestore and takes effect immediately, no redeploy needed.
// -----------------------------------------------------------------

// GET /api/admin/settings
router.get("/admin/settings", async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ ok: true, settings });
  } catch (err) {
    console.error("[admin] get settings failed:", err);
    res.status(500).json({ ok: false, error: "Could not load settings" });
  }
});

// POST /api/admin/settings
// body: { units: [{id, pricePerNight, description, beds, bathrooms, amenities, photo}],
//         extras: [{id, label, description, price, type, max}], bankDetails, ownerNotificationEmail }
router.post("/admin/settings", async (req, res) => {
  try {
    const { units: unitsBody, extras, bankDetails, ownerNotificationEmail } = req.body;
    if (unitsBody && !Array.isArray(unitsBody)) return res.status(400).json({ ok: false, error: "units must be a list" });
    if (extras && !Array.isArray(extras)) return res.status(400).json({ ok: false, error: "extras must be a list" });
    await saveSettings({ units: unitsBody, extras, bankDetails, ownerNotificationEmail });
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin] save settings failed:", err);
    res.status(500).json({ ok: false, error: "Could not save settings" });
  }
});

// POST /api/admin/test-email   body: { to? } — defaults to the current
// ownerNotificationEmail. Use this to verify email delivery directly,
// without needing to submit a real booking.
router.post("/admin/test-email", async (req, res) => {
  try {
    const { ownerNotificationEmail } = await getSettings();
    const to = req.body.to || ownerNotificationEmail;
    const result = await sendTestEmail(to);
    if (result.sent) res.json({ ok: true, to });
    else res.status(500).json({ ok: false, error: result.reason || "Email could not be sent — check EMAIL_USER / EMAIL_APP_PASSWORD are set on Cloud Run.", to });
  } catch (err) {
    console.error("[admin] test email failed:", err);
    res.status(500).json({ ok: false, error: "Could not send test email" });
  }
});

// -----------------------------------------------------------------
// Website content — About text and unit photo galleries for the
// marketing site, editable from the admin dashboard's Website tab.
// Photos upload straight to a public Cloud Storage bucket so the
// public site pages load them directly and fast, no backend involved
// per page view.
// -----------------------------------------------------------------

// POST /api/admin/site-content/about   body: { aboutParagraphs: [string, string] }
router.post("/admin/site-content/about", async (req, res) => {
  try {
    const { aboutParagraphs } = req.body;
    if (!Array.isArray(aboutParagraphs)) return res.status(400).json({ ok: false, error: "aboutParagraphs must be a list" });
    await saveAboutParagraphs(aboutParagraphs);
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin] save about text failed:", err);
    res.status(500).json({ ok: false, error: "Could not save About text" });
  }
});

// POST /api/admin/site-content/photos   multipart/form-data: gallery ('unit1'|'unit2'|'wildlife'), section (optional, unit1/unit2 only), file "photo"
router.post("/admin/site-content/photos", photoUpload.single("photo"), async (req, res) => {
  try {
    const { gallery, section } = req.body;
    if (!GALLERY_IDS.includes(gallery)) return res.status(400).json({ ok: false, error: `gallery must be one of: ${GALLERY_IDS.join(", ")}` });
    if (!req.file) return res.status(400).json({ ok: false, error: "No photo attached" });

    const objectPath = `gallery-photos/${gallery}/${uuidv4()}.jpg`;
    const compressed = await compressPhoto(req.file.buffer);
    await siteAssetsBucket.file(objectPath).save(compressed, {
      contentType: "image/jpeg"
    });
    const publicUrl = `https://storage.googleapis.com/${siteAssetsBucket.name}/${objectPath}`;
    const updated = await addGalleryPhoto(gallery, publicUrl, section);
    res.json({ ok: true, url: publicUrl, gallery: updated });
  } catch (err) {
    console.error("[admin] photo upload failed:", err);
    res.status(500).json({ ok: false, error: "Could not upload photo — check the site-assets bucket exists and allows public objects." });
  }
});

// DELETE /api/admin/site-content/photos   body: { gallery, identifier }
// identifier is a photo id for unit1/unit2, or the raw url for wildlife.
router.delete("/admin/site-content/photos", async (req, res) => {
  try {
    const { gallery, identifier } = req.body;
    if (!GALLERY_IDS.includes(gallery)) return res.status(400).json({ ok: false, error: `gallery must be one of: ${GALLERY_IDS.join(", ")}` });
    if (!identifier) return res.status(400).json({ ok: false, error: "identifier is required" });
    const updated = await removeGalleryPhoto(gallery, identifier);
    res.json({ ok: true, gallery: updated });
  } catch (err) {
    console.error("[admin] photo remove failed:", err);
    res.status(500).json({ ok: false, error: "Could not remove photo" });
  }
});

// POST /api/admin/site-content/photos/move   body: { gallery, photoId, direction: 'up'|'down' }
router.post("/admin/site-content/photos/move", async (req, res) => {
  try {
    const { gallery, photoId, direction } = req.body;
    if (!SECTIONED_GALLERY_IDS.includes(gallery)) return res.status(400).json({ ok: false, error: "Reordering is only available for unit1/unit2 galleries" });
    if (!["up", "down"].includes(direction)) return res.status(400).json({ ok: false, error: "direction must be up or down" });
    const updated = await movePhoto(gallery, photoId, direction);
    res.json({ ok: true, gallery: updated });
  } catch (err) {
    console.error("[admin] photo move failed:", err);
    res.status(500).json({ ok: false, error: "Could not reorder photo" });
  }
});

// POST /api/admin/site-content/photos/section   body: { gallery, photoId, section }
router.post("/admin/site-content/photos/section", async (req, res) => {
  try {
    const { gallery, photoId, section } = req.body;
    if (!SECTIONED_GALLERY_IDS.includes(gallery)) return res.status(400).json({ ok: false, error: "Sections are only available for unit1/unit2 galleries" });
    if (!section) return res.status(400).json({ ok: false, error: "section is required" });
    const updated = await setPhotoSection(gallery, photoId, section);
    res.json({ ok: true, gallery: updated });
  } catch (err) {
    console.error("[admin] set photo section failed:", err);
    res.status(500).json({ ok: false, error: "Could not update the photo's section" });
  }
});

// POST /api/admin/site-content/sections   body: { unitId, name }
router.post("/admin/site-content/sections", async (req, res) => {
  try {
    const { unitId, name } = req.body;
    if (!SECTIONED_GALLERY_IDS.includes(unitId)) return res.status(400).json({ ok: false, error: "Sections are only available for unit1/unit2" });
    if (!name || !name.trim()) return res.status(400).json({ ok: false, error: "A section name is required" });
    const sections = await addGallerySection(unitId, name.trim());
    res.json({ ok: true, sections });
  } catch (err) {
    console.error("[admin] add section failed:", err);
    res.status(500).json({ ok: false, error: "Could not add section" });
  }
});

// PUT /api/admin/site-content/sections   body: { unitId, oldName, newName }
router.put("/admin/site-content/sections", async (req, res) => {
  try {
    const { unitId, oldName, newName } = req.body;
    if (!SECTIONED_GALLERY_IDS.includes(unitId)) return res.status(400).json({ ok: false, error: "Sections are only available for unit1/unit2" });
    if (!newName || !newName.trim()) return res.status(400).json({ ok: false, error: "A new name is required" });
    const existing = await getSiteContent();
    if (!(existing.gallerySections[unitId] || []).includes(oldName)) {
      return res.status(404).json({ ok: false, error: `"${oldName}" isn't a current section — nothing to rename.` });
    }
    const result = await renameGallerySection(unitId, oldName, newName.trim());
    res.json({ ok: true, sections: result.sections, gallery: result.photos });
  } catch (err) {
    console.error("[admin] rename section failed:", err);
    res.status(500).json({ ok: false, error: "Could not rename section" });
  }
});

// DELETE /api/admin/site-content/sections   body: { unitId, name }
router.delete("/admin/site-content/sections", async (req, res) => {
  try {
    const { unitId, name } = req.body;
    if (!SECTIONED_GALLERY_IDS.includes(unitId)) return res.status(400).json({ ok: false, error: "Sections are only available for unit1/unit2" });
    if (!name) return res.status(400).json({ ok: false, error: "name is required" });
    const result = await removeGallerySection(unitId, name);
    res.json({ ok: true, sections: result.sections, gallery: result.photos });
  } catch (err) {
    console.error("[admin] remove section failed:", err);
    res.status(500).json({ ok: false, error: "Could not remove section" });
  }
});

// POST /api/admin/site-content/hero-photo   multipart/form-data: slot ('homeTop'|'homeSecond'), file "photo"
// A single-slot replace, not a gallery add — uploading here REPLACES
// that specific named photo on the Home page.
router.post("/admin/site-content/hero-photo", photoUpload.single("photo"), async (req, res) => {
  try {
    const { slot } = req.body;
    if (!["homeTop", "homeSecond", "aboutPhoto"].includes(slot)) return res.status(400).json({ ok: false, error: "slot must be homeTop, homeSecond, or aboutPhoto" });
    if (!req.file) return res.status(400).json({ ok: false, error: "No photo attached" });

    const objectPath = `hero-photos/${slot}/${uuidv4()}.jpg`;
    const compressed = await compressPhoto(req.file.buffer);
    await siteAssetsBucket.file(objectPath).save(compressed, { contentType: "image/jpeg" });
    const publicUrl = `https://storage.googleapis.com/${siteAssetsBucket.name}/${objectPath}`;
    const heroPhotos = await setHeroPhoto(slot, publicUrl);
    res.json({ ok: true, url: publicUrl, heroPhotos });
  } catch (err) {
    console.error("[admin] hero photo upload failed:", err);
    res.status(500).json({ ok: false, error: "Could not upload photo" });
  }
});

// POST /api/admin/site-content/reviews   body: { name, rating, text }
router.post("/admin/site-content/reviews", async (req, res) => {
  try {
    const { name, rating, text } = req.body;
    if (!name || !text) return res.status(400).json({ ok: false, error: "Name and review text are required" });
    const reviews = await addReview({ name, rating, text });
    res.json({ ok: true, reviews });
  } catch (err) {
    console.error("[admin] add review failed:", err);
    res.status(500).json({ ok: false, error: "Could not add review" });
  }
});

// DELETE /api/admin/site-content/reviews   body: { id }
router.delete("/admin/site-content/reviews", async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ ok: false, error: "id is required" });
    const reviews = await removeReview(id);
    res.json({ ok: true, reviews });
  } catch (err) {
    console.error("[admin] remove review failed:", err);
    res.status(500).json({ ok: false, error: "Could not remove review" });
  }
});

// POST /api/admin/site-content/faqs   body: { question, answer }
router.post("/admin/site-content/faqs", async (req, res) => {
  try {
    const { question, answer } = req.body;
    if (!question || !answer) return res.status(400).json({ ok: false, error: "Both question and answer are required" });
    const faqs = await addFaq({ question, answer });
    res.json({ ok: true, faqs });
  } catch (err) {
    console.error("[admin] add faq failed:", err);
    res.status(500).json({ ok: false, error: "Could not add FAQ" });
  }
});

// DELETE /api/admin/site-content/faqs   body: { id }
router.delete("/admin/site-content/faqs", async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ ok: false, error: "id is required" });
    const faqs = await removeFaq(id);
    res.json({ ok: true, faqs });
  } catch (err) {
    console.error("[admin] remove faq failed:", err);
    res.status(500).json({ ok: false, error: "Could not remove FAQ" });
  }
});

// POST /api/admin/site-content/recommendations   body: { name, category, description, mapLink, distance }
router.post("/admin/site-content/recommendations", async (req, res) => {
  try {
    const { name, category, description, mapLink, distance } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: "A name is required" });
    const recommendations = await addRecommendation({ name, category, description, mapLink, distance });
    res.json({ ok: true, recommendations });
  } catch (err) {
    console.error("[admin] add recommendation failed:", err);
    res.status(500).json({ ok: false, error: "Could not add recommendation" });
  }
});

// DELETE /api/admin/site-content/recommendations   body: { id }
router.delete("/admin/site-content/recommendations", async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ ok: false, error: "id is required" });
    const recommendations = await removeRecommendation(id);
    res.json({ ok: true, recommendations });
  } catch (err) {
    console.error("[admin] remove recommendation failed:", err);
    res.status(500).json({ ok: false, error: "Could not remove recommendation" });
  }
});

// GET /api/admin/analytics
router.get("/admin/analytics", async (req, res) => {
  try {
    const summary = await getAnalyticsSummary(30);
    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error("[admin] analytics failed:", err);
    res.status(500).json({ ok: false, error: "Could not load analytics" });
  }
});

module.exports = router;
