const { syncUnit } = require("./icalSync");
const { units } = require("../config/units");
const { availabilityCollection, bookingsCollection, overridesCollection } = require("./db");
const { subtractRanges, mergeRanges } = require("./rangeUtils");
const { recordStartedStays } = require("./reviews");
const { recordBookingHistory } = require("./bookingHistory");

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
/**
 * When Airbnb, Booking.com or Lekkeslaap can't be reached (both attempts
 * failed), that feed contributes nothing to this sync. Saving that as-is
 * would wipe its reservations from the calendar until the next good sync,
 * showing booked nights as open. Instead, its ranges from the last saved
 * calendar are carried over until the feed loads again.
 */
function keepFailedFeeds(result, previous) {
  const failed = Object.entries(result.feedHealth || {}).filter(([, h]) => h && h.ok === false).map(([k]) => k);
  if (!failed.length || !previous || !Array.isArray(previous.busyRanges)) return result;
  const carried = previous.busyRanges
    .filter(r => (r.sources || []).some(s => failed.includes(s)))
    .map(r => ({ start: r.start, end: r.end, source: (r.sources || []).find(s => failed.includes(s)), blocked: r.blocked === true }));
  if (!carried.length) return result;
  const flat = [];
  for (const r of result.busyRanges) {
    (r.sources || []).forEach(s => flat.push({ start: r.start, end: r.end, source: s, blocked: r.blocked === true }));
    (r.details || []).forEach(d => flat.push({ start: r.start, end: r.end, source: "direct", detail: d, blocked: false }));
  }
  return { ...result, busyRanges: mergeRanges([...flat, ...carried]), carriedFromLastSync: failed };
}

async function syncUnitAndSave(unitId) {
  const unitConfig = units.find(u => u.id === unitId);
  if (!unitConfig) return null;
  const own = await getOwnBusyRanges(unitId);
  const previousDoc = await availabilityCollection.doc(unitId).get();
  const result = keepFailedFeeds(await syncUnit(unitConfig, own), previousDoc.exists ? previousDoc.data() : null);
  const overrides = await getOverrides(unitId);
  if (overrides.length) result.busyRanges = subtractRanges(result.busyRanges, overrides);
  await availabilityCollection.doc(unitId).set(result);
  // Remember OTA stays for the Reviews tab before the feed forgets them.
  // Never allowed to fail the sync itself.
  await recordStartedStays(unitId, result.busyRanges)
    .catch(err => console.error("[availabilitySync] recording stays for reviews failed:", err.message));
  // Same for booking stats: keep every OTA stay after the feed drops it.
  await recordBookingHistory(unitId, result.busyRanges)
    .catch(err => console.error("[availabilitySync] recording booking history failed:", err.message));
  return result;
}

module.exports = { getOwnBusyRanges, getOverrides, syncUnitAndSave, keepFailedFeeds };
