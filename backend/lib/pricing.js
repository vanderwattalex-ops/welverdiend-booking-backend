/**
 * The single place a booking's money is worked out — used by BOTH the
 * guest-facing request flow (routes/bookings.js) and the admin's manual
 * booking flow (routes/admin.js), so the two can never drift apart and
 * start quoting different totals for the same stay.
 *
 * Nothing here ever trusts a total sent by a client; a total is always
 * recomputed from the nightly rate, the extras catalog, and the number
 * of nights.
 */

// Anything that isn't a real number counts as zero. Without this a
// stray "abc" in a money field turns into NaN, and NaN spreads silently
// through the total, the deposit split, the invoice, and the stored
// record.
function round2(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

function nightsBetween(checkIn, checkOut) {
  const ms = new Date(checkOut) - new Date(checkIn);
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

/**
 * Recomputes the total server-side from the current prices, and splits
 * it into a deposit (due to secure the booking) and a balance (due
 * before check-in).
 *
 * `options` only ever comes from the admin's manual booking form — a
 * guest request passes none of it, so the guest flow always gets the
 * standard rate and a straight 50/50 split:
 *   ratePerNight   — a negotiated rate for this one booking, instead of
 *                    the unit's configured nightly rate
 *   discount       — rand amount off the total, shown as its own line
 *                    item on the invoice so the guest sees the reduction
 *   depositAmount  — an agreed deposit other than 50% (e.g. a guest
 *                    paying in full up front, or a smaller holding fee)
 */
function calculateTotal(unit, nights, selectedExtras, extrasCatalog, options = {}) {
  // A blank rate means "not specified" and falls back to the unit's
  // configured price — only an explicit 0 makes a stay free. Without
  // that distinction an empty rate field would quietly produce a R0
  // booking and a R0 invoice.
  const rateGiven = options.ratePerNight !== undefined && options.ratePerNight !== null && String(options.ratePerNight).trim() !== "";
  const rate = rateGiven && Number.isFinite(Number(options.ratePerNight)) && Number(options.ratePerNight) >= 0
    ? Number(options.ratePerNight)
    : unit.pricePerNight;

  const base = round2(rate * nights);
  const lineItems = [{ label: `${unit.name} — ${nights} night${nights === 1 ? "" : "s"}`, amount: base }];

  let extrasTotal = 0;
  for (const sel of selectedExtras) {
    const def = extrasCatalog.find(e => e.id === sel.id);
    if (!def) continue;
    if (def.type === "flat") {
      extrasTotal += def.price;
      lineItems.push({ label: def.label, amount: def.price });
    } else if (def.type === "qty") {
      const qty = Math.max(0, Math.min(def.max || 99, Number(sel.qty) || 0));
      if (qty > 0) {
        const amount = def.price * qty;
        extrasTotal += amount;
        lineItems.push({ label: `${def.label} × ${qty}`, amount });
      }
    }
  }

  // Capped at the running subtotal so a mistyped discount can never
  // produce a negative total (which would then flow into the deposit
  // split, the invoice, and the income figures).
  const discount = Math.min(Math.max(0, round2(options.discount)), base + extrasTotal);
  if (discount > 0) lineItems.push({ label: "Discount", amount: -discount });

  const total = round2(base + extrasTotal - discount);

  const depositAmount = Number.isFinite(Number(options.depositAmount))
    ? Math.min(Math.max(0, round2(options.depositAmount)), total)
    : round2(total / 2);
  const balanceAmount = round2(total - depositAmount);

  return { total, lineItems, depositAmount, balanceAmount, ratePerNight: rate, discount };
}

module.exports = { round2, nightsBetween, calculateTotal };
