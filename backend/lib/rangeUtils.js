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
  const merged = [{ ...seed, sources: [seed.source], details: seed.detail ? [seed.detail] : [], blocked: seed.blocked === true }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    // Strictly less-than, matching rangesOverlap()'s own definition above —
    // ranges are half-open, so a checkout on day X and a new check-in on
    // that same day X (same-day turnover, very common) don't actually
    // overlap. Using <= here merged those genuinely separate, back-to-back
    // bookings into one, hiding that there were two different bookings
    // (sometimes from two different platforms) rather than one.
    if (cur.start < last.end) {
      if (cur.end > last.end) last.end = cur.end;
      last.sources = [...new Set([...(last.sources || [last.source]), cur.source])];
      if (cur.detail) last.details = [...new Set([...(last.details || []), cur.detail])];
      // Only an all-block overlap stays a block. If anything merged in is
      // a real reservation (or this platform's own confirmed booking),
      // the range represents a paying stay.
      last.blocked = last.blocked === true && cur.blocked === true;
    } else {
      merged.push({ ...cur, sources: [cur.source], details: cur.detail ? [cur.detail] : [], blocked: cur.blocked === true });
    }
  }
  return merged.map(({ start, end, sources, details, blocked }) => ({ start, end, sources, details, blocked }));
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
