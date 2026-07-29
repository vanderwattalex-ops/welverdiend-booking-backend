const express = require("express");
const router = express.Router();
const { bookingsCollection, bucket } = require("../lib/db");
const { requireAdmin } = require("./adminAuth");

router.use(requireAdmin);

// GET /api/admin/bookings?status=pending
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

// POST /api/admin/bookings/:id/confirm
router.post("/admin/bookings/:id/confirm", async (req, res) => {
  await bookingsCollection.doc(req.params.id).update({ status: "confirmed", decidedAt: new Date().toISOString() });
  // Note: trigger a /api/sync call after this (or wait up to 10 min) so the
  // confirmed dates are folded into the merged availability calendar.
  res.json({ ok: true });
});

// POST /api/admin/bookings/:id/reject
router.post("/admin/bookings/:id/reject", async (req, res) => {
  await bookingsCollection.doc(req.params.id).update({ status: "rejected", decidedAt: new Date().toISOString() });
  res.json({ ok: true });
});

module.exports = router;
