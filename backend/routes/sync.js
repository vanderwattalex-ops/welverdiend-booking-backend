const express = require("express");
const router = express.Router();
const { syncAllUnits } = require("../lib/icalSync");
const { availabilityCollection, bookingsCollection, overridesCollection } = require("../lib/db");
const { subtractRanges } = require("../lib/rangeUtils");
const { requireAdmin } = require("./adminAuth");

/**
 * Fetches this unit's CONFIRMED direct bookings from Firestore, as
 * {start, end, guestName} ranges, so they get folded into the merged
 * availability (and so a direct booking blocks the unit even before it
 * round-trips through Airbnb/Booking.com's own feeds). Carrying the
 * guest name lets the admin dashboard show who a direct block is for.
 */
async function getOwnConfirmedRanges(unitId) {
  const snap = await bookingsCollection
    .where("unitId", "==", unitId)
    .where("status", "==", "confirmed")
    .get();
  return snap.docs.map(d => {
    const b = d.data();
    return { start: b.checkIn, end: b.checkOut, guestName: b.guestName };
  });
}

/**
 * Fetches any manual "unblock this" overrides for a unit, as plain
 * {start, end} ranges.
 */
async function getOverrides(unitId) {
  const snap = await overridesCollection.where("unitId", "==", unitId).get();
  return snap.docs.map(d => {
    const o = d.data();
    return { start: o.start, end: o.end };
  });
}

// GET so Cloud Scheduler's HTTP target can call it directly with an OIDC
// token; protected by requireAdmin (Scheduler is configured to send the
// admin token as a header — see README).
router.get("/sync", requireAdmin, async (req, res) => {
  try {
    const results = await syncAllUnits(getOwnConfirmedRanges);
    for (const r of results) {
      const overrides = await getOverrides(r.unitId);
      if (overrides.length) r.busyRanges = subtractRanges(r.busyRanges, overrides);
    }
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
