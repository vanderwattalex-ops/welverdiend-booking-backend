const { firestore, settingsCollection } = require("./db");
const { rangesOverlap } = require("./rangeUtils");

// -----------------------------------------------------------------
// A permanent record of every Airbnb / Booking.com / Lekkeslaap stay the
// sync has ever seen. The iCal feeds are a live view only — Airbnb drops a
// reservation from its feed around check-in — and `availability` is
// overwritten on every sync, so without this the booking-stats app loses a
// stay the moment the guest arrives.
//
//   bookingHistory   one doc per range, id = `${unitId}_${start}_${end}`
//
// status:
//   live       in the feed as of the last sync
//   kept       left the feed on/after its check-in date — a real stay
//   cancelled  left the feed before its check-in date
//   replaced   left the feed while an overlapping range is live (dates
//              changed, or a later sync re-merged it differently)
//
// Direct bookings aren't recorded — they live in `bookings` for good.
// Nothing here blocks dates or feeds the calendar.
// -----------------------------------------------------------------

const bookingHistoryCollection = firestore.collection("bookingHistory");
const BACKFILL_DOC = settingsCollection.doc("bookingHistory");

function todaySA() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" });
}

function historyKey(unitId, r) {
  return `${unitId}_${r.start}_${r.end}`;
}

/**
 * Works out what to write for one unit, given this sync's busy ranges and
 * the unit's existing history docs ({ id, ...data }). Pure, so it can be
 * tested without Firestore. Returns [{ id, data }] to merge-write.
 */
function planHistoryWrites(unitId, busyRanges, existing, today, nowIso) {
  const current = (busyRanges || []).filter(r => !(r.sources || []).includes("direct"));
  const currentKeys = new Set(current.map(r => historyKey(unitId, r)));
  const byId = new Map(existing.map(d => [d.id, d]));
  const writes = [];

  for (const r of current) {
    const id = historyKey(unitId, r);
    const prev = byId.get(id);
    const data = { unitId, start: r.start, end: r.end, sources: r.sources || [], blocked: r.blocked === true, status: "live", lastSeenAt: nowIso };
    if (!prev) data.firstSeenAt = nowIso;
    if (!prev || prev.status !== "live" || prev.blocked !== data.blocked || String(prev.sources) !== String(data.sources)) {
      writes.push({ id, data });
    } else {
      // Unchanged — only refresh lastSeenAt once a day to keep writes low.
      if (String(prev.lastSeenAt || "").slice(0, 10) !== nowIso.slice(0, 10)) writes.push({ id, data: { lastSeenAt: nowIso } });
    }
  }

  for (const d of existing) {
    if (currentKeys.has(d.id)) continue;
    if (d.status !== "live" && d.status !== "kept") continue;
    const overlapsLive = current.some(r => rangesOverlap(r.start, r.end, d.start, d.end));
    let status;
    if (overlapsLive) status = "replaced";
    else if (d.status === "kept") continue;
    else status = d.start <= today ? "kept" : "cancelled";
    writes.push({ id: d.id, data: { status, leftFeedAt: nowIso } });
  }

  return writes;
}

/**
 * Called after every sync of a unit. Never allowed to fail the sync.
 */
async function recordBookingHistory(unitId, busyRanges) {
  const snap = await bookingHistoryCollection.where("unitId", "==", unitId).get();
  const existing = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const writes = planHistoryWrites(unitId, busyRanges, existing, todaySA(), new Date().toISOString());
  if (!writes.length) return;
  const batch = firestore.batch();
  writes.forEach(w => batch.set(bookingHistoryCollection.doc(w.id), w.data, { merge: true }));
  await batch.commit();
}

/**
 * One-off: the Reviews tab has remembered every started OTA stay since
 * 23 Sep 2026 (`reviewStays`). Those are exactly the stays the feed has
 * since dropped, so bring them into the history once.
 */
async function backfillFromReviewStays() {
  const flag = await BACKFILL_DOC.get();
  if (flag.exists && flag.data().reviewStaysImportedAt) return;
  const [staysSnap, histSnap] = await Promise.all([
    firestore.collection("reviewStays").get(),
    bookingHistoryCollection.get()
  ]);
  const have = new Set(histSnap.docs.map(d => d.id));
  const batch = firestore.batch();
  let n = 0;
  staysSnap.docs.forEach(doc => {
    const s = doc.data();
    if (!s.unitId || !s.start || !s.end) return;
    const id = historyKey(s.unitId, s);
    if (have.has(id)) return;
    batch.set(bookingHistoryCollection.doc(id), {
      unitId: s.unitId, start: s.start, end: s.end, sources: s.sources || [], blocked: false,
      status: "kept", firstSeenAt: s.firstSeenAt || null, importedFrom: "reviewStays"
    });
    n++;
  });
  batch.set(BACKFILL_DOC, { reviewStaysImportedAt: new Date().toISOString(), reviewStaysImported: n }, { merge: true });
  await batch.commit();
}

/** Stays that have left the feed but really happened. */
async function getKeptStays() {
  await backfillFromReviewStays()
    .catch(err => console.error("[bookingHistory] reviewStays backfill failed:", err.message));
  const snap = await bookingHistoryCollection.where("status", "==", "kept").get();
  return snap.docs.map(d => d.data());
}

module.exports = { recordBookingHistory, getKeptStays, planHistoryWrites, historyKey };
