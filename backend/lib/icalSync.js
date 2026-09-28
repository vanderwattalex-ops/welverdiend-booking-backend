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
          source: sourceLabel,
          blocked: isOwnerBlock(sourceLabel, ev.summary)
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
 * True when a feed entry is the owner blocking dates out rather than a
 * guest reservation — maintenance, building work, personal use, or a
 * booking taken directly and blocked here so the platform can't sell it
 * twice. Those dates earn nothing through the platform, so reporting
 * them as that platform's bookings invents income that was never made.
 *
 * Only Airbnb states this unambiguously: "Reserved" for a real booking,
 * "Airbnb (Not available)" for an owner block. Booking.com labels EVERY
 * entry "CLOSED - Not available", reservations included, so nothing in
 * that feed can be classified — and Lekkeslaap's convention is unknown.
 * Both therefore stay treated as bookings: wrongly hiding a real booking
 * is far worse than showing an owner block as one. The match is
 * positive (look for the block wording) rather than "anything that
 * isn't Reserved", so a feed that stops sending SUMMARY doesn't
 * silently turn every booking into a block.
 */
function isOwnerBlock(sourceLabel, summary) {
  if (sourceLabel !== "airbnb") return false;
  return /not available|blocked/i.test(String(summary || ""));
}

/**
 * Our own export feed (routes/icalExport.js) is imported by Airbnb,
 * Booking.com and Lekkeslaap, and they then list those dates in THEIR
 * feeds as blocked — which we import straight back. Left in, a direct
 * booking's own dates come back tagged "airbnb" as well as "direct", and
 * then:
 *  - the deposit-proof upload re-check (routes/bookings.js isRangeFree)
 *    no longer recognises the range as the booking's own hold and tells
 *    the guest "these dates were booked elsewhere" — the same bug fixed
 *    in 02b3fe5, returning a few hours after approval;
 *  - Booking.com's echo ("CLOSED - Not available", indistinguishable from
 *    a reservation) would count as Booking.com income in the stats.
 * So an external range with EXACTLY the dates of one of our own holding
 * bookings is treated as the echo and dropped. A genuine platform
 * booking on precisely those dates would already be a double booking;
 * the direct booking still blocks the dates either way.
 */
function dropEchoes(externalRanges, ownRanges) {
  const ownKeys = new Set(ownRanges.map(r => `${r.start}|${r.end}`));
  return externalRanges.filter(r => !ownKeys.has(`${r.start}|${r.end}`));
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
  const external = dropEchoes([...airbnb.ranges, ...booking.ranges, ...lekkeslaap.ranges], own);
  const merged = mergeRanges([...external, ...own]);

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

module.exports = { syncAllUnits, syncUnit, dropEchoes };
