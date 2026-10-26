const { randomUUID } = require("crypto");
const { settingsCollection } = require("./db");

// Guests the owner has blocked (nuisance requests, fake proof of payment).
// A blocked email address or phone number can't send new booking requests
// from the website. Kept in its own settings doc so it never mixes with the
// public settings.
const DOC_ID = "blocklist";

const normEmail = e => String(e || "").trim().toLowerCase();
// Last 9 digits, so 082 123 4567, +27 82 123 4567 and 27821234567 all match
const normPhone = p => { const d = String(p || "").replace(/\D/g, ""); return d.length >= 9 ? d.slice(-9) : ""; };

async function getBlocklist() {
  const doc = await settingsCollection.doc(DOC_ID).get();
  return (doc.exists && Array.isArray(doc.data().entries)) ? doc.data().entries : [];
}

async function saveBlocklist(entries) {
  await settingsCollection.doc(DOC_ID).set({ entries, updatedAt: new Date().toISOString() });
}

// The entry that blocks this email or phone, or null
async function findBlock(email, phone) {
  const e = normEmail(email), p = normPhone(phone);
  if (!e && !p) return null;
  const entries = await getBlocklist();
  return entries.find(b => (e && b.email && normEmail(b.email) === e) || (p && b.phone && normPhone(b.phone) === p)) || null;
}

async function addBlock({ name, email, phone, reason, bookingId }) {
  const e = normEmail(email), p = normPhone(phone);
  if (!e && !p) throw new Error("Give an email address or a phone number to block.");
  const entries = await getBlocklist();
  const entry = {
    id: randomUUID(),
    name: String(name || "").trim().slice(0, 120),
    email: e.slice(0, 200),
    phone: String(phone || "").trim().slice(0, 40),
    reason: String(reason || "").trim().slice(0, 300),
    bookingId: String(bookingId || "").slice(0, 80),
    blockedAt: new Date().toISOString()
  };
  await saveBlocklist([entry, ...entries]);
  return entry;
}

async function removeBlock(id) {
  const entries = await getBlocklist();
  const left = entries.filter(b => b.id !== id);
  if (left.length === entries.length) return false;
  await saveBlocklist(left);
  return true;
}

module.exports = { getBlocklist, findBlock, addBlock, removeBlock, normPhone };
