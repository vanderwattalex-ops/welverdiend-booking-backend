// Shared helpers for working with busy-date ranges. Every range is
// { start, end } as YYYY-MM-DD strings, half-open: start is included,
// end is not (matches iCal's own convention for all-day events).

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Merges overlapping/adjacent busy ranges into a minimal set, combining
 * their `source` labels into a `sources` array so the calendar can show
 * "booked via Airbnb + Direct" for a range covered by more than one.
 */
function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start.localeCompare(b.start));
  const seed = sorted[0];
  const merged = [{ ...seed, sources: [seed.source], details: seed.detail ? [seed.detail] : [] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start <= last.end) {
      if (cur.end > last.end) last.end = cur.end;
      last.sources = [...new Set([...(last.sources || [last.source]), cur.source])];
      if (cur.detail) last.details = [...new Set([...(last.details || []), cur.detail])];
    } else {
      merged.push({ ...cur, sources: [cur.source], details: cur.detail ? [cur.detail] : [] });
    }
  }
  return merged.map(({ start, end, sources, details }) => ({ start, end, sources, details }));
}

/**
 * Removes `overrides` (manual "unblock this" ranges) from `busyRanges`,
 * splitting a busy range in two if an override falls in the middle of
 * it. Used so a manual unblock survives the next automatic sync instead
 * of being immediately re-blocked.
 */
function subtractRanges(busyRanges, overrides) {
  let result = busyRanges;
  for (const ov of overrides) {
    const next = [];
    for (const r of result) {
      if (!rangesOverlap(r.start, r.end, ov.start, ov.end)) {
        next.push(r);
        continue;
      }
      // Keep whatever part of r falls outside the override.
      if (r.start < ov.start) next.push({ ...r, end: ov.start });
      if (r.end > ov.end) next.push({ ...r, start: ov.end });
    }
    result = next;
  }
  return result;
}

module.exports = { rangesOverlap, mergeRanges, subtractRanges };
