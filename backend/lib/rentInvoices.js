const { firestore, settingsCollection, rentInvoicesCollection } = require("./db");
const { computeLines, round2 } = require("./rentInvoicePdf");

const SETTINGS_DOC = "rentInvoicing";

// Defaults hold nothing private — the repo is public, so the owner's
// bank account and the tenant's details only ever live in Firestore,
// entered through the dashboard.
const DEFAULT_SETTINGS = {
  nextNumber: 1,
  terms: "Payment is due on or before 1st of every month.",
  bankDetails: "",
  popLine: "Please email POP to bookings@welverdiendaccommodation.com"
};

async function getRentSettings() {
  const doc = await settingsCollection.doc(SETTINGS_DOC).get();
  const saved = doc.exists ? doc.data() : {};
  return {
    nextNumber: Number.isInteger(saved.nextNumber) && saved.nextNumber > 0 ? saved.nextNumber : DEFAULT_SETTINGS.nextNumber,
    terms: typeof saved.terms === "string" ? saved.terms : DEFAULT_SETTINGS.terms,
    bankDetails: typeof saved.bankDetails === "string" ? saved.bankDetails : DEFAULT_SETTINGS.bankDetails,
    popLine: typeof saved.popLine === "string" ? saved.popLine : DEFAULT_SETTINGS.popLine
  };
}

async function saveRentSettings({ nextNumber, terms, bankDetails, popLine }) {
  const payload = { updatedAt: new Date().toISOString() };
  if (nextNumber !== undefined) {
    const n = Number(nextNumber);
    if (!Number.isInteger(n) || n < 1) {
      const err = new Error("The next invoice number must be a whole number of 1 or more.");
      err.userFacing = true;
      throw err;
    }
    payload.nextNumber = n;
  }
  if (terms !== undefined) payload.terms = String(terms);
  if (bankDetails !== undefined) payload.bankDetails = String(bankDetails);
  if (popLine !== undefined) payload.popLine = String(popLine);
  await settingsCollection.doc(SETTINGS_DOC).set(payload, { merge: true });
}

/**
 * Hands out the next invoice number inside a transaction, so two
 * invoices created at the same moment can never share a number. If the
 * counter has been set to a number that's already on an invoice (e.g.
 * typed back to an old value in Settings), it skips past it rather than
 * issuing a duplicate.
 */
async function claimInvoiceNumber() {
  const ref = settingsCollection.doc(SETTINGS_DOC);
  return firestore.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const saved = snap.exists ? snap.data() : {};
    let n = Number.isInteger(saved.nextNumber) && saved.nextNumber > 0 ? saved.nextNumber : DEFAULT_SETTINGS.nextNumber;
    for (let tries = 0; tries < 500; tries++) {
      const taken = await tx.get(rentInvoicesCollection.where("number", "==", n).limit(1));
      if (taken.empty) break;
      n++;
    }
    tx.set(ref, { nextNumber: n + 1 }, { merge: true });
    return n;
  });
}

const isDate = d => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d).getTime());

/**
 * Validates and normalises what the dashboard sends. Returns
 * { value } or { error } — never throws for bad input.
 */
function cleanInvoiceInput(body) {
  const { date, billTo = {}, lines, reference } = body || {};
  if (!isDate(date)) return { error: "Pick an invoice date." };
  const name = String(billTo.name || "").trim();
  if (!name) return { error: "Enter who the invoice is for." };
  const email = String(billTo.email || "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "That email address doesn't look right — check it, or leave it blank." };
  }
  if (!Array.isArray(lines) || lines.length === 0) return { error: "Add at least one line to the invoice." };
  if (lines.length > 200) return { error: "That's more lines than one invoice can hold (200)." };

  for (const [i, l] of lines.entries()) {
    if (!String((l && l.description) || "").trim()) return { error: `Line ${i + 1} needs a description.` };
    // Blank or non-numeric input must be caught here rather than quietly
    // becoming 0 — a missing quantity on a rent line would otherwise
    // silently knock R16,000 off the total.
    if (l.qty === "" || l.qty === null || l.qty === undefined || !Number.isFinite(Number(l.qty))) {
      return { error: `Line ${i + 1} ("${String(l.description).trim()}") needs a quantity.` };
    }
    if (l.unitPrice === "" || l.unitPrice === null || l.unitPrice === undefined || !Number.isFinite(Number(l.unitPrice))) {
      return { error: `Line ${i + 1} ("${String(l.description).trim()}") needs a unit price.` };
    }
  }

  const computed = computeLines(lines);
  return {
    value: {
      date,
      billTo: {
        name,
        phone: String(billTo.phone || "").trim(),
        email,
        unit: String(billTo.unit || "").trim()
      },
      lines: computed.lines,
      total: computed.total,
      reference: String(reference || "").trim()
    }
  };
}

const PAYMENT_LINE = /^\s*payment\b/i;
const RENT_LINE = /\brent\b/i;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

// "September 2026 Rent" -> "October 2026 Rent"; "December 2026" rolls
// over to "January 2027". Text without a month and year is left alone.
function bumpMonth(text) {
  return text.replace(new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{4})\\b`, "i"), (_, mon, yr) => {
    const i = MONTHS.findIndex(m => m.toLowerCase() === mon.toLowerCase());
    return i === 11 ? `January ${Number(yr) + 1}` : `${MONTHS[i + 1]} ${yr}`;
  });
}

/**
 * The new month's lines, based on last month's charges. Rent is fixed,
 * so it carries over with its month moved on. Everything else
 * (electricity, water, cleaning, wood) changes every month, so it comes
 * in with the quantity BLANK and last month's period text stripped —
 * the server refuses a blank quantity, which makes it impossible to
 * send last month's usage again by accident.
 */
// A month name or abbreviation standing on its own — "28July" and
// "24 Aug)" count, but the "Mar" in "Maria" and the "May" in "Maybe"
// don't.
const MONTH_TOKEN = /(?<![a-z])(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)(?![a-z])/i;

// Drops a trailing "(28 July - 24 Aug)" but keeps "(20 bags)" and
// "(Maria)" — only brackets that name a month are period text.
function stripPeriod(text) {
  const m = /\s*\(([^)]*)\)\s*$/.exec(text);
  return m && MONTH_TOKEN.test(m[1]) ? text.slice(0, m.index) : text;
}

function newPeriodLines(charges) {
  return charges.map(l => RENT_LINE.test(l.description)
    ? { qty: l.qty, description: bumpMonth(l.description), unitPrice: l.unitPrice }
    : { qty: "", description: stripPeriod(l.description), unitPrice: l.unitPrice });
}

/**
 * Pre-fills the next invoice the way this guest's invoices have always
 * worked: the previous period's lines are carried over, followed by the
 * payment that settled them (so that block nets to zero), followed by
 * the new month's lines ready to be filled in.
 *
 * "The previous period" is whatever came after the last Payment line on
 * the previous invoice — everything above that line was already
 * settled on an earlier invoice. If that block doesn't add up to the
 * previous invoice's total (e.g. the invoice was laid out differently),
 * every line is carried instead, which is always arithmetically right.
 *
 * A payment line is only added when the previous invoice is marked
 * paid. If it's still unpaid, its lines carry forward with no payment
 * against them, so the unpaid amount stays owing on the new invoice.
 */
function buildNextDraft(prev, today) {
  const { lines, total } = computeLines(prev.lines);
  let lastPayment = -1;
  lines.forEach((l, i) => { if (PAYMENT_LINE.test(l.description)) lastPayment = i; });

  let carried = lastPayment >= 0 ? lines.slice(lastPayment + 1) : lines;
  const carriedSum = round2(carried.reduce((s, l) => s + l.amount, 0));
  if (Math.abs(carriedSum - total) > 0.005) carried = lines;

  const copy = l => ({ qty: l.qty, description: l.description, unitPrice: l.unitPrice });
  const draftLines = carried.map(copy);
  const paid = prev.status === "paid";
  if (paid && total !== 0) draftLines.push({ qty: 1, description: "Payment", unitPrice: -total });

  // Only charges repeat into the new month: credits (e.g. cat food the
  // guest bought on the owner's behalf) and payments are one-offs.
  const charges = carried.filter(l => l.unitPrice >= 0 && !PAYMENT_LINE.test(l.description));
  const fresh = newPeriodLines(charges);

  return {
    date: today,
    billTo: { ...(prev.billTo || {}) },
    reference: prev.reference || "",
    lines: [...draftLines, ...fresh],
    // Where the new month starts in `lines`, so the dashboard can mark
    // it visually.
    newPeriodStart: draftLines.length,
    previousNumber: prev.number,
    previousTotal: total,
    previousPaid: paid
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  getRentSettings,
  saveRentSettings,
  claimInvoiceNumber,
  cleanInvoiceInput,
  buildNextDraft,
  bumpMonth,
  stripPeriod,
  rentInvoicesCollection
};
