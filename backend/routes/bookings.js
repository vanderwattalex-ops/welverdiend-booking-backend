const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const router = express.Router();
const { bookingsCollection, bucket, availabilityCollection } = require("../lib/db");
const { units, extras } = require("../config/units");
const { notifyOwnerNewRequest, notifyOwnerProofUploaded } = require("../lib/email");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.mimetype);
    cb(ok ? null : new Error("Proof of payment must be an image or PDF"), ok);
  }
});

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function nightsBetween(checkIn, checkOut) {
  const ms = new Date(checkOut) - new Date(checkIn);
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

/**
 * Recomputes the total server-side from the config's current prices —
 * never trusts a total the client might send.
 */
function calculateTotal(unit, nights, selectedExtras) {
  const base = unit.pricePerNight * nights;
  const lineItems = [{ label: `${unit.name} — ${nights} night${nights === 1 ? "" : "s"}`, amount: base }];

  let extrasTotal = 0;
  for (const sel of selectedExtras) {
    const def = extras.find(e => e.id === sel.id);
    if (!def) continue;
    if (def.type === "flat") {
      extrasTotal += def.price;
      lineItems.push({ label: def.label, amount: def.price });
    } else if (def.type === "qty") {
      const qty = Math.max(0, Math.min(def.max || 99, Number(sel.qty) || 0));
      if (qty > 0) {
        const amount = def.price * qty;
        extrasTotal += amount;
        lineItems.push({ label: `${def.label} × ${qty}`, amount });
      }
    }
  }

  return { total: base + extrasTotal, lineItems };
}

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
    const { total, lineItems } = calculateTotal(unit, nights, selectedExtras);

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
      proofOfPaymentPath: null,
      // requested -> awaiting_payment -> submitted -> confirmed
      //                               -> rejected (from any stage)
      status: "requested",
      createdAt: new Date().toISOString()
    };
    await bookingsCollection.doc(bookingId).set(booking);
    notifyOwnerNewRequest(booking, unit.name); // fire-and-forget, never blocks the response

    res.json({
      ok: true,
      bookingId,
      totalAmount: total,
      lineItems,
      message: "Request received — we'll check these dates and email you as soon as they're approved, with instructions to pay and confirm."
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
  const doc = await bookingsCollection.doc(req.params.id).get();
  if (!doc.exists) return res.status(404).json({ ok: false, error: "Booking not found" });
  const b = doc.data();
  const unit = units.find(u => u.id === b.unitId);
  res.json({
    ok: true,
    unitName: unit ? unit.name : b.unitId,
    checkIn: b.checkIn,
    checkOut: b.checkOut,
    nights: b.nights,
    totalAmount: b.totalAmount,
    lineItems: b.lineItems,
    status: b.status
  });
});

// ---------------------------------------------------------------------
// STEP 2 — Guest uploads proof of payment, reached via the link in the
// approval email. Only works once you've approved (status =
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
    const objectPath = `proof-of-payment/${booking.id}.${ext}`;
    await bucket.file(objectPath).save(req.file.buffer, {
      contentType: req.file.mimetype,
      metadata: { metadata: { bookingId: booking.id } }
    });

    await ref.update({ proofOfPaymentPath: objectPath, status: "submitted", proofUploadedAt: new Date().toISOString() });

    const unit = units.find(u => u.id === booking.unitId);
    notifyOwnerProofUploaded(booking, unit ? unit.name : booking.unitId);

    res.json({ ok: true, message: "Thanks — your proof of payment has been received. We'll send final confirmation shortly." });
  } catch (err) {
    console.error("[bookings] proof upload failed:", err);
    res.status(500).json({ ok: false, error: "Could not upload proof of payment" });
  }
});

module.exports = router;
