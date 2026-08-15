const express = require("express");
const router = express.Router();
const { units } = require("../config/units");
const { syncUnitAndSave } = require("../lib/availabilitySync");
const { requireAdmin } = require("./adminAuth");

// GET so Cloud Scheduler's HTTP target can call it directly with an OIDC
// token; protected by requireAdmin (Scheduler is configured to send the
// admin token as a header — see README).
router.get("/sync", requireAdmin, async (req, res) => {
  try {
    const results = [];
    for (const u of units) {
      const r = await syncUnitAndSave(u.id);
      if (r) results.push(r);
    }
    res.json({ ok: true, synced: results.map(r => ({ unit: r.unitId, ranges: r.busyRanges.length, at: r.lastSyncedAt })) });
  } catch (err) {
    console.error("[sync] failed:", err);
    res.status(500).json({ ok: false, error: "Sync failed" });
  }
});

module.exports = router;
