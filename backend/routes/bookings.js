const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const router = express.Router();
const { bookingsCollection, bucket, availabilityCollection } = require("../lib/db");
const { units, extras } = require("../config/units");

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
 * never trusts a total the client might send. `selectedExtras` is an
 * array of { id, qty } (qty ignored/forced to 1 for "flat" extras).
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

// POST /api/bookings  (multipart/form-data)
// Core fields: unitId, checkIn, checkOut, guestName, email, phone
// Guest details: adults, children, childrenAges, hasPets, petDetails, arrivalTime, notes
// extras: JSON string, e.g. '[{"id":"cleaning"},{"id":"firewood","qty":2}]'
// file field "proof"
router.post("/bookings", upload.single("proof"), async (req, res) => {
  try {
    const {
      unitId, checkIn, checkOut, guestName, email, phone,
      adults, children, childrenAges, hasPets, petDetails, arrivalTime, notes
    } = req.body;

    const unit = units.find(u => u.id === unitId);
    if (!unit) {
      return res.status(400).json({ ok: false, error: "Unknown unit" });
    }
    if (!checkIn || !checkOut || checkIn >= checkOut) {
      return res.status(400).json({ ok: false, error: "Invalid date range" });
    }
    if (!guestName || !email || !phone) {
      return res.status(400).json({ ok: false, error: "Name, email and phone are required" });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Proof of payment file is required" });
    }

    // Re-check availability server-side (never trust the client's calendar state).
    const availDoc = await availabilityCollection.doc(unitId).get();
    const busyRanges = availDoc.exists ? availDoc.data().busyRanges || [] : [];
    const conflict = busyRanges.some(r => rangesOverlap(checkIn, checkOut, r.start, r.end));
    if (conflict) {
      return res.status(409).json({ ok: false, error: "Those dates were just booked elsewhere — please pick different dates." });
    }

    let selectedExtras = [];
    if (req.body.extras) {
      try { selectedExtras = JSON.parse(req.body.extras); } catch { selectedExtras = []; }
    }
    const nights = nightsBetween(checkIn, checkOut);
    const { total, lineItems } = calculateTotal(unit, nights, selectedExtras);

    const bookingId = uuidv4();
    const ext = req.file.originalname.split(".").pop();
    const objectPath = `proof-of-payment/${bookingId}.${ext}`;
    await bucket.file(objectPath).save(req.file.buffer, {
      contentType: req.file.mimetype,
      metadata: { metadata: { bookingId } }
    });

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
      hasPets: hasPets === "true" || hasPets === true,
      petDetails: petDetails || "",
      arrivalTime: arrivalTime || "",
      notes: notes || "",
      extras: selectedExtras,
      lineItems,
      totalAmount: total,
      proofOfPaymentPath: objectPath,
      status: "pending", // pending | confirmed | rejected
      createdAt: new Date().toISOString()
    };
    await bookingsCollection.doc(bookingId).set(booking);

    res.json({
      ok: true,
      bookingId,
      totalAmount: total,
      lineItems,
      message: `Booking request received — total due R${total.toFixed(2)}. We'll confirm by email once your proof of payment has been checked.`
    });
  } catch (err) {
    console.error("[bookings] failed:", err);
    res.status(500).json({ ok: false, error: "Could not submit booking" });
  }
});

module.exports = router;
