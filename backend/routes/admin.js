const express = require("express");
const router = express.Router();
const { bookingsCollection, bucket, availabilityCollection, overridesCollection } = require("../lib/db");
const { requireAdmin } = require("./adminAuth");
const { units } = require("../config/units");
const { rangesOverlap, subtractRanges } = require("../lib/rangeUtils");
const { v4: uuidv4 } = require("uuid");
const {
  notifyGuestApproved, notifyGuestConfirmed, notifyGuestDeclined,
  notifyGuestBalanceDue, sendTestEmail
} = require("../lib/email");
const { getSettings, saveSettings } = require("../lib/settings");
const { generateInvoice } = require("../lib/invoice");

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
    if (booking.status !== "confirmed") {
      return res.status(409).json({ ok: false, error: "An invoice is only available once a booking is confirmed." });
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
    notifyGuestApproved(booking, unitName(booking.unitId)).catch(logEmailFail("approve"));
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin] approve failed:", err);
    res.status(500).json({ ok: false, error: "Could not approve booking" });
  }
});

// POST /api/admin/bookings/:id/decline   body: { reason? }
router.post("/admin/bookings/:id/decline", async (req, res) => {
  try {
    const ref = bookingsCollection.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: "Not found" });
    const booking = doc.data();

    await ref.update({ status: "rejected", decidedAt: new Date().toISOString(), declineReason: req.body.reason || "" });
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

    await ref.update({ status: "rejected", decidedAt: new Date().toISOString(), declineReason: req.body.reason || "" });
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
    await ref.update({ balanceStatus: "paid", balancePaidAt: new Date().toISOString() });
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
    await bookingsCollection.doc(req.params.id).delete();
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

module.exports = router;
