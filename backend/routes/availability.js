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
    const result = units.map(u => byUnit[u.id] || {
      unitId: u.id,
      unitName: u.name,
      busyRanges: [],
      lastSyncedAt: null
    });

    res.json({ ok: true, units: result });
  } catch (err) {
    console.error("[availability] failed:", err);
    res.status(500).json({ ok: false, error: "Could not load availability" });
  }
});

module.exports = router;
