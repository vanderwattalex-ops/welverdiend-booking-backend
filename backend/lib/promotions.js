/**
 * Automatic discounts for direct bookings: the long-stay discount and
 * time-limited specials (e.g. the fuel relief price). Shared by the
 * server (routes/bookings.js recomputes every guest total) and, through
 * /api/config, by the booking page so the quote a guest sees matches the
 * total they are charged.
 *
 * Rules (owner's choices, Oct 2026):
 *   - discounts come off the nightly rate only, never off the extras
 *   - a stay gets ONE discount: whichever saves the guest more
 *   - long stay: the highest step the stay reaches (e.g. 5+ nights 7%)
 *   - a special counts only the nights that fall inside its dates, and
 *     needs the whole stay to be at least its minimum nights
 * Admin manual bookings don't use this; they keep their own discount field.
 */

const DEFAULT_PROMOTIONS = {
  longStay: {
    enabled: true,
    tiers: [
      { nights: 3, percent: 3 },
      { nights: 5, percent: 7 },
      { nights: 7, percent: 10 },
      { nights: 28, percent: 20 }
    ]
  },
  specials: [
    {
      id: "fuel-relief-2026",
      name: "Fuel relief price",
      percent: 10,
      minNights: 2,
      units: ["unit2"],
      stayFrom: "2026-10-24",
      stayTo: "2026-12-31",
      bookBy: "",
      active: true,
      reason: "Fuel is expensive, so we're giving road-trippers a break."
    }
  ]
};

const round2 = n => Math.round(Number(n) * 100) / 100;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

/** Cleans what the dashboard sends (or what is stored) into the shape used here. */
function normalisePromotions(p) {
  const src = p && typeof p === "object" ? p : DEFAULT_PROMOTIONS;
  const ls = src.longStay || {};
  const tiers = (Array.isArray(ls.tiers) ? ls.tiers : [])
    .map(t => ({ nights: Math.round(Number(t.nights)), percent: round2(t.percent) }))
    .filter(t => t.nights >= 2 && t.percent > 0 && t.percent <= 50)
    .sort((a, b) => a.nights - b.nights)
    .slice(0, 6);
  const specials = (Array.isArray(src.specials) ? src.specials : [])
    .map(s => ({
      id: String(s.id || "").slice(0, 60) || "special-" + Date.now(),
      name: String(s.name || "").trim().slice(0, 60),
      percent: round2(s.percent),
      minNights: Math.max(1, Math.round(Number(s.minNights) || 1)),
      units: (Array.isArray(s.units) ? s.units : []).map(String),
      stayFrom: isDate(s.stayFrom) ? s.stayFrom : "",
      stayTo: isDate(s.stayTo) ? s.stayTo : "",
      bookBy: isDate(s.bookBy) ? s.bookBy : "",
      active: s.active !== false,
      reason: String(s.reason || "").trim().slice(0, 240)
    }))
    .filter(s => s.name && s.percent > 0 && s.percent <= 50 && s.units.length)
    .slice(0, 10);
  return { longStay: { enabled: ls.enabled !== false && tiers.length > 0, tiers }, specials };
}

// Each night is named by its date (check-in night = checkIn date).
function nightDates(checkIn, nights) {
  const out = [];
  const d = new Date(checkIn + "T00:00:00Z");
  for (let i = 0; i < nights; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Specials that are switched on and not over yet (for banners and the booking page). */
function runningSpecials(promotions, today) {
  const t = today || new Date().toISOString().slice(0, 10);
  return (promotions.specials || []).filter(s =>
    s.active && (!s.stayTo || s.stayTo >= t) && (!s.bookBy || s.bookBy >= t));
}

/**
 * The single discount a direct booking gets, or null.
 * Returns { kind: "longStay"|"special", id, label, percent, amount }.
 */
function bestDiscount({ unitId, checkIn, nights, rate, promotions, today }) {
  const p = promotions || normalisePromotions(DEFAULT_PROMOTIONS);
  const options = [];
  const n = Math.round(Number(nights)) || 0;
  if (n < 1 || !(rate > 0)) return null;

  if (p.longStay && p.longStay.enabled) {
    const step = p.longStay.tiers.filter(t => n >= t.nights).pop();
    if (step) {
      options.push({
        kind: "longStay", id: "long-stay", percent: step.percent,
        label: `Long-stay discount (${step.nights}+ nights, ${step.percent}% off)`,
        amount: round2(rate * n * step.percent / 100)
      });
    }
  }

  const dates = isDate(checkIn) ? nightDates(checkIn, n) : [];
  for (const s of runningSpecials(p, today)) {
    if (!s.units.includes(unitId) || n < s.minNights) continue;
    const inside = dates.filter(d => (!s.stayFrom || d >= s.stayFrom) && (!s.stayTo || d <= s.stayTo)).length;
    if (!inside) continue;
    options.push({
      kind: "special", id: s.id, percent: s.percent,
      label: inside === n ? `${s.name} (${s.percent}% off)` : `${s.name} (${s.percent}% off ${inside} of ${n} nights)`,
      amount: round2(rate * inside * s.percent / 100)
    });
  }

  if (!options.length) return null;
  return options.reduce((best, o) => (o.amount > best.amount ? o : best));
}

module.exports = { DEFAULT_PROMOTIONS, normalisePromotions, runningSpecials, bestDiscount, nightDates };
