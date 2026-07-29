const express = require("express");
const router = express.Router();
const { availabilityCollection } = require("../lib/db");
const { units } = require("../config/units");

// GET /api/availability  -> both units at once (used by the widget on load)
router.get("/availability", async (req, res) => {
  try {
    const snap = await availabilityCollection.get();
    const byUnit = {};
    snap.forEach(doc => (byUnit[doc.id] = doc.data()));

    // Always return an entry per configured unit, even before the first sync.
    // "details" (e.g. a direct-booking guest's name) is admin-only — strip
    // it here so this public endpoint never leaks a guest's identity to
    // other site visitors. "sources" (which platform) is fine to show.
    const result = units.map(u => {
      const data = byUnit[u.id] || { unitId: u.id, unitName: u.name, busyRanges: [], lastSyncedAt: null };
      return {
        ...data,
        busyRanges: (data.busyRanges || []).map(({ start, end, sources }) => ({ start, end, sources }))
      };
    });

    res.json({ ok: true, units: result });
  } catch (err) {
    console.error("[availability] failed:", err);
    res.status(500).json({ ok: false, error: "Could not load availability" });
  }
});

module.exports = router;
