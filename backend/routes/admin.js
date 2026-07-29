const express = require("express");
const router = express.Router();
const { bookingsCollection, bucket, availabilityCollection } = require("../lib/db");
const { requireAdmin } = require("./adminAuth");
const { units } = require("../config/units");
const { notifyGuestApproved, notifyGuestConfirmed, notifyGuestDeclined } = require("../lib/email");

router.use(requireAdmin);
router.use(express.json());

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function unitName(unitId) {
  const u = units.find(x => x.id === unitId);
  return u ? u.name : unitId;
}

// GET /api/admin/bookings?status=requested
router.get("/admin/bookings", async (req, res) => {
  try {
    let q = bookingsCollection.orderBy("createdAt", "desc");
    if (req.query.status) q = q.where("status", "==", req.query.status);
    const snap = await q.get();
    const bookings = snap.docs.map(d => d.data());
    res.json({ ok: true, bookings });
  } catch (err) {
    console.error("[admin] list bookings failed:", err);
    res.status(500).json({ ok: false, error: "Could not load bookings" });
  }
});

// GET /api/admin/bookings/:id/proof  -> short-lived signed URL to view the file
router.get("/admin/bookings/:id/proof", async (req, res) => {
  try {
    const doc = await bookingsCollection.doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: "Not found" });
    const { proofOfPaymentPath } = doc.data();
    if (!proofOfPaymentPath) return res.status(404).json({ ok: false, error: "No proof of payment uploaded yet" });
    const [url] = await bucket.file(proofOfPaymentPath).getSignedUrl({
      action: "read",
      expires: Date.now() + 15 * 60 * 1000 // 15 min
    });
    res.json({ ok: true, url });
  } catch (err) {
    console.error("[admin] signed url failed:", err);
    res.status(500).json({ ok: false, error: "Could not get file link" });
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
    notifyGuestApproved(booking, unitName(booking.unitId));
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
    notifyGuestDeclined(booking, unitName(booking.unitId), req.body.reason);
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin] decline failed:", err);
    res.status(500).json({ ok: false, error: "Could not decline booking" });
  }
});

// -----------------------------------------------------------------
// STAGE 2 — final confirm/reject, after the guest has uploaded proof
// of payment. Confirming is what actually blocks the dates on the
// calendar (via the "confirmed" status feeding into /api/sync).
// -----------------------------------------------------------------

// POST /api/admin/bookings/:id/confirm
router.post("/admin/bookings/:id/confirm", async (req, res) => {
  try {
    const ref = bookingsCollection.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: "Not found" });
    const booking = doc.data();
    if (booking.status !== "submitted") {
      return res.status(409).json({ ok: false, error: `This booking is "${booking.status}" — proof of payment hasn't been uploaded yet.` });
    }

    await ref.update({ status: "confirmed", decidedAt: new Date().toISOString() });
    // Note: the dates block as soon as the next /api/sync run picks up
    // this "confirmed" status (every 5 minutes) — or trigger /api/sync
    // manually for it to take effect immediately.
    notifyGuestConfirmed(booking, unitName(booking.unitId));
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
    notifyGuestDeclined(booking, unitName(booking.unitId), req.body.reason);
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin] reject failed:", err);
    res.status(500).json({ ok: false, error: "Could not reject booking" });
  }
});

module.exports = router;
