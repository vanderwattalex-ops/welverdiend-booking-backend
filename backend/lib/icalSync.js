const ical = require("node-ical");
const { units } = require("../config/units");

/**
 * Fetches one .ics feed and returns an array of { start, end, source } busy ranges.
 * Dates are normalized to YYYY-MM-DD (calendar days), inclusive of start,
 * exclusive of end — matching iCal's own convention for all-day events.
 */
async function fetchFeed(url, sourceLabel) {
  if (!url) return [];
  try {
    const data = await ical.async.fromURL(url);
    const ranges = [];
    for (const key in data) {
      const ev = data[key];
      if (ev.type !== "VEVENT" || !ev.start || !ev.end) continue;
      ranges.push({
        start: toDateOnly(ev.start),
        end: toDateOnly(ev.end),
        source: sourceLabel
      });
    }
    return ranges;
  } catch (err) {
    console.error(`[icalSync] Failed to fetch ${sourceLabel} feed:`, err.message);
    // A single broken feed should never take the whole sync down.
    return [];
  }
}

function toDateOnly(d) {
  const dt = new Date(d);
  return dt.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Merges overlapping/adjacent busy ranges into a minimal set, so the
 * frontend calendar doesn't have to reason about overlaps from three
 * different platforms.
 */
function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start.localeCompare(b.start));
  const merged = [{ ...sorted[0], sources: [sorted[0].source] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start <= last.end) {
      if (cur.end > last.end) last.end = cur.end;
      last.sources = [...new Set([...(last.sources || [last.source]), cur.source])];
    } else {
      merged.push({ ...cur, sources: [cur.source] });
    }
  }
  return merged.map(({ start, end, sources }) => ({ start, end, sources }));
}

/**
 * Pulls all three external feeds for a single unit + adds this platform's
 * own confirmed direct bookings (passed in separately), then returns one
 * merged, deduplicated list of busy ranges for that unit.
 */
async function syncUnit(unitConfig, ownConfirmedRanges = []) {
  const { sources } = unitConfig;
  const [airbnb, booking, lekkeslaap] = await Promise.all([
    fetchFeed(sources.airbnb, "airbnb"),
    fetchFeed(sources.booking, "booking.com"),
    fetchFeed(sources.lekkeslaap, "lekkeslaap")
  ]);

  const own = ownConfirmedRanges.map(r => ({ ...r, source: "direct" }));
  const merged = mergeRanges([...airbnb, ...booking, ...lekkeslaap, ...own]);

  return {
    unitId: unitConfig.id,
    unitName: unitConfig.name,
    busyRanges: merged,
    lastSyncedAt: new Date().toISOString()
  };
}

async function syncAllUnits(getOwnConfirmedRangesForUnit) {
  const results = [];
  for (const unit of units) {
    const own = getOwnConfirmedRangesForUnit
      ? await getOwnConfirmedRangesForUnit(unit.id)
      : [];
    results.push(await syncUnit(unit, own));
  }
  return results;
}

module.exports = { syncAllUnits, syncUnit, mergeRanges };
