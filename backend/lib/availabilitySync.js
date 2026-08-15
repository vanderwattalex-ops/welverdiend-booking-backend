const { syncUnit } = require("./icalSync");
const { units } = require("../config/units");
const { availabilityCollection, bookingsCollection, overridesCollection } = require("./db");
const { subtractRanges } = require("./rangeUtils");

/**
 * A booking blocks the calendar as soon as you APPROVE it — not only
 * once it's fully confirmed. This is what makes an approval take dates
 * off the table immediately, instead of leaving a window (between
 * approval and the guest actually paying) where the same dates could
 * still be requested and approved for someone else.
 */
async function getOwnBusyRanges(unitId) {
  const snap = await bookingsCollection
    .where("unitId", "==", unitId)
    .where("status", "in", ["awaiting_payment", "submitted", "confirmed"])
    .get();
  return snap.docs.map(d => {
    const b = d.data();
    return { start: b.checkIn, end: b.checkOut, guestName: b.guestName };
  });
}

async function getOverrides(unitId) {
  const snap = await overridesCollection.where("unitId", "==", unitId).get();
  return snap.docs.map(d => {
    const o = d.data();
    return { start: o.start, end: o.end };
  });
}

/**
 * Re-syncs and persists availability for a single unit. Used both by
 * the periodic /api/sync cron job (every unit, every 5 minutes) and by
 * anywhere a booking's status changes in a way that should block or
 * release dates right away — approving, declining, rejecting, deleting,
 * or auto-expiring a booking — instead of waiting up to 5 minutes for
 * the next scheduled sync to catch up.
 */
async function syncUnitAndSave(unitId) {
  const unitConfig = units.find(u => u.id === unitId);
  if (!unitConfig) return null;
  const own = await getOwnBusyRanges(unitId);
  const result = await syncUnit(unitConfig, own);
  const overrides = await getOverrides(unitId);
  if (overrides.length) result.busyRanges = subtractRanges(result.busyRanges, overrides);
  await availabilityCollection.doc(unitId).set(result);
  return result;
}

module.exports = { getOwnBusyRanges, getOverrides, syncUnitAndSave };
