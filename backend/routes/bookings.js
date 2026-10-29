const express = require("express");
const multer = require("multer");
const { randomUUID: uuidv4 } = require("crypto"); // same random IDs as the old uuid package
const router = express.Router();
const { bookingsCollection, bucket, availabilityCollection } = require("../lib/db");
const { getSettings } = require("../lib/settings");
const { rangesOverlap } = require("../lib/rangeUtils");
const { nightsBetween, calculateTotal } = require("../lib/pricing");
const { bestDiscount } = require("../lib/promotions");
const { findBlock } = require("../lib/blocklist");
const { notifyOwnerNewRequest, notifyGuestReceived, notifyOwnerProofUploaded, notifyOwnerBalanceProofUploaded } = require("../lib/email");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.mimetype);
    cb(ok ? null : new Error("Proof of payment must be an image or PDF"), ok);
  }
});

// File extension from the (already checked) file type, never from the
// uploaded file's name.
function proofExt(file) {
  return { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" }[file.mimetype] || "bin";
}

// excludeOwnRange lets a booking's own hold (which the sync already wrote
// into busyRanges the moment it was approved, so a second guest can't be
// approved for the same dates) be ignored when THAT SAME booking re-checks
// itself — otherwise it always "conflicts" with its own hold. Only one
// direct booking can ever hold an exact date range at a time (this same
// check enforces that at request time), so an exact-range match whose
// sources are all "direct" can only be this booking's own hold, never a
// different booking or an external one.
async function isRangeFree(unitId, checkIn, checkOut, excludeOwnRange) {
  const availDoc = await availabilityCollection.doc(unitId).get();
  const busyRanges = availDoc.exists ? availDoc.data().busyRanges || [] : [];
  return !busyRanges.some(r => {
    if (
      excludeOwnRange &&
      r.start === excludeOwnRange.checkIn &&
      r.end === excludeOwnRange.checkOut &&
      (r.sources || []).every(s => s === "direct")
    ) {
      return false;
    }
    return rangesOverlap(checkIn, checkOut, r.start, r.end);
  });
}

// ---------------------------------------------------------------------
// STEP 1 — Guest submits a booking request (no file yet).
// Status starts as "requested" — you review it and either approve
// (dates genuinely available) or decline before any payment happens.
// POST /api/bookings  (application/json)
// ---------------------------------------------------------------------
router.post("/bookings", express.json(), async (req, res) => {
  try {
    const {
      unitId, checkIn, checkOut, guestName, email, phone,
      adults, children, childrenAges, hasPets, petDetails, arrivalTime, notes, extras: extrasBody
    } = req.body;

    const { units, extras, promotions } = await getSettings();
    const unit = units.find(u => u.id === unitId);
    if (!unit) return res.status(400).json({ ok: false, error: "Unknown unit" });
    // Real calendar dates only (YYYY-MM-DD). Anything else is refused: these
    // strings are stored, compared and shown in the dashboard.
    const isDate = d => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d;
    const todaySA = new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10); // South African date
    if (!isDate(checkIn) || !isDate(checkOut) || checkIn >= checkOut) {
      return res.status(400).json({ ok: false, error: "Please pick a check-in date and a later check-out date." });
    }
    if (checkIn < todaySA) {
      return res.status(400).json({ ok: false, error: "That check-in date has already passed. Please pick new dates." });
    }
    if (nightsBetween(checkIn, checkOut) > 120) {
      return res.status(400).json({ ok: false, error: "For stays longer than 120 nights, please contact us directly." });
    }
    const text = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
    if (!text(guestName, 120) || !text(email, 200) || !text(phone, 40)) {
      return res.status(400).json({ ok: false, error: "Name, email and phone are required" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(email, 200))) {
      return res.status(400).json({ ok: false, error: "That email address doesn't look right. Please check it." });
    }
    const count = (v, min, max, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
    // Each unit sleeps 4 (babies under 2 don't count and go in the notes).
    if (count(adults, 1, 10, 1) + count(children, 0, 10, 0) > 4) {
      return res.status(400).json({ ok: false, error: "Each unit sleeps up to 4 guests. Babies under 2 don't count, so please mention them under special requests." });
    }
    // Check-in is from 14:00 (the form sends HH:MM).
    if (typeof arrivalTime === "string" && /^\d{2}:\d{2}$/.test(arrivalTime) && arrivalTime < "14:00") {
      return res.status(400).json({ ok: false, error: "Check-in is from 14:00. Please choose an arrival time of 14:00 or later." });
    }

    // Blocked by the owner (nuisance requests, fake proof of payment): no
    // request is stored, and no email goes to the owner or to the address.
    if (await findBlock(email, phone)) {
      return res.status(403).json({ ok: false, error: "Sorry, we're unable to accept this booking request online." });
    }

    // Same person, same unit, same dates, request still open: don't make a
    // second one (a guest who didn't notice the first went through). They get
    // the same "received" answer and the owner isn't notified twice.
    const digits = s => String(s || "").replace(/\D/g, "").slice(-9);
    const sameGuest = b => (email && b.email && b.email.trim().toLowerCase() === String(email).trim().toLowerCase())
      || (digits(phone).length >= 9 && digits(b.phone) === digits(phone));
    const openSnap = await bookingsCollection.where("unitId", "==", unitId).where("checkIn", "==", checkIn).get();
    const existing = openSnap.docs.map(d => d.data())
      .find(b => b.checkOut === checkOut && ["requested", "awaiting_payment", "submitted"].includes(b.status) && sameGuest(b));
    if (existing) {
      return res.json({
        ok: true,
        duplicate: true,
        bookingId: existing.id,
        totalAmount: existing.totalAmount,
        depositAmount: existing.depositAmount,
        balanceAmount: existing.balanceAmount,
        lineItems: existing.lineItems,
        message: existing.status === "requested"
          ? "We already have your request for these dates, so there's no need to send it again. We'll email you as soon as they're approved."
          : "We already have your booking for these dates. Please check your email for the payment details, or WhatsApp us on 079 118 3173."
      });
    }

    const free = await isRangeFree(unitId, checkIn, checkOut);
    if (!free) {
      return res.status(409).json({ ok: false, error: "Those dates were just booked elsewhere — please pick different dates." });
    }

    const selectedExtras = Array.isArray(extrasBody) ? extrasBody : [];
    const nights = nightsBetween(checkIn, checkOut);
    // Long-stay discount or running special, worked out here (never trusted from the page)
    const promo = bestDiscount({ unitId, checkIn, nights, rate: unit.pricePerNight, promotions });
    const { total, lineItems, depositAmount, balanceAmount } = calculateTotal(unit, nights, selectedExtras, extras, { promo });

    const bookingId = uuidv4();
    const booking = {
      id: bookingId,
      unitId,
      checkIn,
      checkOut,
      nights,
      guestName: text(guestName, 120),
      email: text(email, 200),
      phone: text(phone, 40),
      adults: count(adults, 1, 10, 1),
      children: count(children, 0, 10, 0),
      childrenAges: text(childrenAges, 120),
      hasPets: !!hasPets,
      petDetails: text(petDetails, 300),
      arrivalTime: text(arrivalTime, 60),
      notes: text(notes, 2000),
      extras: selectedExtras,
      lineItems,
      totalAmount: total,
      depositAmount,
      balanceAmount,
      proofOfPaymentPath: null, // deposit proof
      balanceProofPath: null,
      balanceStatus: "unpaid", // unpaid -> submitted -> paid (only relevant once confirmed)
      // requested -> awaiting_payment -> submitted -> confirmed
      //                               -> rejected (from any stage)
      status: "requested",
      createdAt: new Date().toISOString()
    };
    await bookingsCollection.doc(bookingId).set(booking);
    notifyOwnerNewRequest(booking, unit.name).catch(err => console.error("[bookings] owner notification failed:", err));
    notifyGuestReceived(booking, unit.name).catch(err => console.error("[bookings] guest receipt failed:", err));

    res.json({
      ok: true,
      bookingId,
      totalAmount: total,
      depositAmount,
      balanceAmount,
      lineItems,
      message: `We'll check these dates and email you as soon as they're approved, with instructions to pay the R${depositAmount.toFixed(2)} deposit. We've also emailed you a copy of your request.`
    });
  } catch (err) {
    console.error("[bookings] request failed:", err);
    res.status(500).json({ ok: false, error: "Could not submit booking request" });
  }
});

// ---------------------------------------------------------------------
// Public summary for the guest's "upload proof of payment" page — only
// the fields needed to show context, nothing sensitive about the guest.
// GET /api/bookings/:id/summary
// ---------------------------------------------------------------------
router.get("/bookings/:id/summary", async (req, res) => {
  try {
    const doc = await bookingsCollection.doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: "Booking not found" });
    const b = doc.data();
    const { units } = await getSettings();
    const unit = units.find(u => u.id === b.unitId);
    res.json({
      ok: true,
      unitName: unit ? unit.name : b.unitId,
      checkIn: b.checkIn,
      checkOut: b.checkOut,
      nights: b.nights,
      totalAmount: b.totalAmount,
      depositAmount: b.depositAmount,
      balanceAmount: b.balanceAmount,
      balanceStatus: b.balanceStatus,
      lineItems: b.lineItems,
      status: b.status
    });
  } catch (err) {
    console.error("[bookings] summary failed:", err);
    res.status(500).json({ ok: false, error: "Could not load booking details" });
  }
});

// ---------------------------------------------------------------------
// STEP 2 — Guest uploads DEPOSIT proof of payment, reached via the link
// in the approval email. Only works once you've approved (status =
// "awaiting_payment"); moves the booking to "submitted" for your final
// confirmation.
// POST /api/bookings/:id/proof  (multipart/form-data, field "proof")
// ---------------------------------------------------------------------
router.post("/bookings/:id/proof", upload.single("proof"), async (req, res) => {
  try {
    const ref = bookingsCollection.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: "Booking not found" });
    const booking = doc.data();

    if (booking.status !== "awaiting_payment") {
      return res.status(409).json({ ok: false, error: "This booking isn't waiting for proof of payment right now." });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Please attach your proof of payment." });
    }

    // Defensive re-check — in case something else got confirmed for an
    // overlapping date since you approved this request. Exclude this
    // booking's own hold, which the approval sync already wrote into
    // busyRanges — without that it always "conflicts" with itself.
    const free = await isRangeFree(booking.unitId, booking.checkIn, booking.checkOut, {
      checkIn: booking.checkIn,
      checkOut: booking.checkOut
    });
    if (!free) {
      return res.status(409).json({ ok: false, error: "Sorry — these dates were booked elsewhere in the meantime. Please contact us directly." });
    }

    const ext = proofExt(req.file);
    const objectPath = `proof-of-payment/${booking.id}-deposit.${ext}`;
    await bucket.file(objectPath).save(req.file.buffer, {
      contentType: req.file.mimetype,
      metadata: { metadata: { bookingId: booking.id } }
    });

    await ref.update({ proofOfPaymentPath: objectPath, status: "submitted", proofUploadedAt: new Date().toISOString() });

    const unit = (await getSettings()).units.find(u => u.id === booking.unitId);
    notifyOwnerProofUploaded(booking, unit ? unit.name : booking.unitId).catch(err => console.error("[bookings] owner notification failed:", err));

    res.json({ ok: true, message: "Thanks — your deposit proof of payment has been received. We'll send your final confirmation once the payment reflects in our bank account." });
  } catch (err) {
    console.error("[bookings] proof upload failed:", err);
    res.status(500).json({ ok: false, error: "Could not upload proof of payment" });
  }
});

// ---------------------------------------------------------------------
// STEP 3 — Guest uploads the BALANCE (final 50%) proof of payment,
// reached via the same upload link, once the booking is "confirmed"
// and the balance hasn't been paid yet.
// POST /api/bookings/:id/balance-proof  (multipart/form-data, field "proof")
// ---------------------------------------------------------------------
router.post("/bookings/:id/balance-proof", upload.single("proof"), async (req, res) => {
  try {
    const ref = bookingsCollection.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: "Booking not found" });
    const booking = doc.data();

    if (booking.status !== "confirmed") {
      return res.status(409).json({ ok: false, error: "This booking isn't confirmed yet, so there's no balance payment to make." });
    }
    if (booking.balanceStatus === "paid") {
      return res.status(409).json({ ok: false, error: "The balance for this booking has already been paid." });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Please attach your proof of payment." });
    }

    const ext = proofExt(req.file);
    const objectPath = `proof-of-payment/${booking.id}-balance.${ext}`;
    await bucket.file(objectPath).save(req.file.buffer, {
      contentType: req.file.mimetype,
      metadata: { metadata: { bookingId: booking.id } }
    });

    await ref.update({ balanceProofPath: objectPath, balanceStatus: "submitted", balanceUploadedAt: new Date().toISOString() });

    const unit = (await getSettings()).units.find(u => u.id === booking.unitId);
    notifyOwnerBalanceProofUploaded(booking, unit ? unit.name : booking.unitId).catch(err => console.error("[bookings] owner notification failed:", err));

    res.json({ ok: true, message: "Thanks — your final payment proof has been received." });
  } catch (err) {
    console.error("[bookings] balance proof upload failed:", err);
    res.status(500).json({ ok: false, error: "Could not upload proof of payment" });
  }
});

module.exports = router;
