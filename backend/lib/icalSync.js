const ical = require("node-ical");
const { units } = require("../config/units");
const { mergeRanges } = require("./rangeUtils");

/**
 * Fetches one .ics feed. Returns both the busy ranges AND a health
 * status — a broken feed (dead token, revoked link, network error)
 * never takes the whole sync down, but it's reported back so the admin
 * dashboard can warn about it instead of silently showing an
 * incomplete calendar.
 */
async function fetchFeed(url, sourceLabel) {
  if (!url) return { ranges: [], health: { ok: true, skipped: true, error: null } };

  // Try twice with a short pause before declaring a feed genuinely
  // broken — a single failed attempt could just be a brief network
  // hiccup or the platform being momentarily slow, not a dead link.
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
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
      return { ranges, health: { ok: true, skipped: false, error: null } };
    } catch (err) {
      lastErr = err;
      if (attempt === 1) await new Promise(r => setTimeout(r, 2000));
    }
  }
  console.error(`[icalSync] Failed to fetch ${sourceLabel} feed after 2 attempts:`, lastErr.message);
  // A single broken feed should never take the whole sync down.
  return { ranges: [], health: { ok: false, skipped: false, error: lastErr.message } };
}

function toDateOnly(d) {
  const dt = new Date(d);
  return dt.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Pulls all three external feeds for a single unit + adds this platform's
 * own confirmed direct bookings (passed in separately), then returns one
 * merged, deduplicated list of busy ranges for that unit, each tagged
 * with which source(s) caused it, plus a health report per feed.
 */
async function syncUnit(unitConfig, ownConfirmedRanges = []) {
  const { sources } = unitConfig;
  const [airbnb, booking, lekkeslaap] = await Promise.all([
    fetchFeed(sources.airbnb, "airbnb"),
    fetchFeed(sources.booking, "booking.com"),
    fetchFeed(sources.lekkeslaap, "lekkeslaap")
  ]);

  const own = ownConfirmedRanges.map(r => ({ ...r, source: "direct", detail: r.guestName }));
  const merged = mergeRanges([...airbnb.ranges, ...booking.ranges, ...lekkeslaap.ranges, ...own]);

  return {
    unitId: unitConfig.id,
    unitName: unitConfig.name,
    busyRanges: merged,
    lastSyncedAt: new Date().toISOString(),
    feedHealth: {
      airbnb: airbnb.health,
      "booking.com": booking.health,
      lekkeslaap: lekkeslaap.health
    }
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

module.exports = { syncAllUnits, syncUnit };
