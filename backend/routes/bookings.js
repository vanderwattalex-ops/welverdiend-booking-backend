const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const router = express.Router();
const { bookingsCollection, bucket, availabilityCollection } = require("../lib/db");
const { getSettings } = require("../lib/settings");
const { rangesOverlap } = require("../lib/rangeUtils");
const { nightsBetween, calculateTotal } = require("../lib/pricing");
const { notifyOwnerNewRequest, notifyOwnerProofUploaded, notifyOwnerBalanceProofUploaded } = require("../lib/email");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.mimetype);
    cb(ok ? null : new Error("Proof of payment must be an image or PDF"), ok);
  }
});

async function isRangeFree(unitId, checkIn, checkOut) {
  const availDoc = await availabilityCollection.doc(unitId).get();
  const busyRanges = availDoc.exists ? availDoc.data().busyRanges || [] : [];
  return !busyRanges.some(r => rangesOverlap(checkIn, checkOut, r.start, r.end));
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

    const { units, extras } = await getSettings();
    const unit = units.find(u => u.id === unitId);
    if (!unit) return res.status(400).json({ ok: false, error: "Unknown unit" });
    if (!checkIn || !checkOut || checkIn >= checkOut) {
      return res.status(400).json({ ok: false, error: "Invalid date range" });
    }
    if (!guestName || !email || !phone) {
      return res.status(400).json({ ok: false, error: "Name, email and phone are required" });
    }

    const free = await isRangeFree(unitId, checkIn, checkOut);
    if (!free) {
      return res.status(409).json({ ok: false, error: "Those dates were just booked elsewhere — please pick different dates." });
    }

    const selectedExtras = Array.isArray(extrasBody) ? extrasBody : [];
    const nights = nightsBetween(checkIn, checkOut);
    const { total, lineItems, depositAmount, balanceAmount } = calculateTotal(unit, nights, selectedExtras, extras);

    const bookingId = uuidv4();
    const booking = {
      id: bookingId,
      unitId,
      checkIn,
      checkOut,
      nights,
      guestName,
      email,
      phone,
      adults: adults ? Number(adults) : 1,
      children: children ? Number(children) : 0,
      childrenAges: childrenAges || "",
      hasPets: !!hasPets,
      petDetails: petDetails || "",
      arrivalTime: arrivalTime || "",
      notes: notes || "",
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

    res.json({
      ok: true,
      bookingId,
      totalAmount: total,
      depositAmount,
      balanceAmount,
      lineItems,
      message: `Request received — we'll check these dates and email you as soon as they're approved, with instructions to pay a R${depositAmount.toFixed(2)} deposit.`
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
    // overlapping date since you approved this request.
    const free = await isRangeFree(booking.unitId, booking.checkIn, booking.checkOut);
    if (!free) {
      return res.status(409).json({ ok: false, error: "Sorry — these dates were booked elsewhere in the meantime. Please contact us directly." });
    }

    const ext = (req.file.originalname.split(".").pop() || "jpg");
    const objectPath = `proof-of-payment/${booking.id}-deposit.${ext}`;
    await bucket.file(objectPath).save(req.file.buffer, {
      contentType: req.file.mimetype,
      metadata: { metadata: { bookingId: booking.id } }
    });

    await ref.update({ proofOfPaymentPath: objectPath, status: "submitted", proofUploadedAt: new Date().toISOString() });

    const unit = (await getSettings()).units.find(u => u.id === booking.unitId);
    notifyOwnerProofUploaded(booking, unit ? unit.name : booking.unitId).catch(err => console.error("[bookings] owner notification failed:", err));

    res.json({ ok: true, message: "Thanks — your deposit proof of payment has been received. We'll send final confirmation shortly." });
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

    const ext = (req.file.originalname.split(".").pop() || "jpg");
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
