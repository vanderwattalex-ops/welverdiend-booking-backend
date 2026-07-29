const express = require("express");
const router = express.Router();
const { syncAllUnits } = require("../lib/icalSync");
const { availabilityCollection, bookingsCollection } = require("../lib/db");
const { requireAdmin } = require("./adminAuth");

/**
 * Fetches this unit's CONFIRMED direct bookings from Firestore, as
 * {start, end} ranges, so they get folded into the merged availability
 * (and so a direct booking blocks the unit even before it round-trips
 * through Airbnb/Booking.com's own feeds).
 */
async function getOwnConfirmedRanges(unitId) {
  const snap = await bookingsCollection
    .where("unitId", "==", unitId)
    .where("status", "==", "confirmed")
    .get();
  return snap.docs.map(d => {
    const b = d.data();
    return { start: b.checkIn, end: b.checkOut };
  });
}

// GET so Cloud Scheduler's HTTP target can call it directly with an OIDC
// token; protected by requireAdmin (Scheduler is configured to send the
// admin token as a header — see README).
router.get("/sync", requireAdmin, async (req, res) => {
  try {
    const results = await syncAllUnits(getOwnConfirmedRanges);
    const batch = availabilityCollection.firestore.batch();
    for (const r of results) {
      batch.set(availabilityCollection.doc(r.unitId), r);
    }
    await batch.commit();
    res.json({ ok: true, synced: results.map(r => ({ unit: r.unitId, ranges: r.busyRanges.length, at: r.lastSyncedAt })) });
  } catch (err) {
    console.error("[sync] failed:", err);
    res.status(500).json({ ok: false, error: "Sync failed" });
  }
});

module.exports = router;
