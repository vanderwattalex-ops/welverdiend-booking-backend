const crypto = require("crypto");
const { FieldValue } = require("@google-cloud/firestore");
const { firestore, bookingsCollection, settingsCollection } = require("./db");

// -----------------------------------------------------------------
// Google review requests. Kept in their own collections so nothing
// here can block dates, email guests or count towards booking stats.
//
//   reviewRequests  one doc per request, doc id = the public link token
//   reviewStays     OTA stays remembered once they've started — the
//                   iCal feeds drop a stay as soon as it's over, so
//                   without this there'd be nothing left to ask about
//   reviewSkips     stays the owner chose not to ask about, id = stayKey
// -----------------------------------------------------------------

const reviewRequestsCollection = firestore.collection("reviewRequests");
const reviewStaysCollection = firestore.collection("reviewStays");
const reviewSkipsCollection = firestore.collection("reviewSkips");
const SETTINGS_DOC = settingsCollection.doc("reviews");

// The live domain, not the *.run.app URL — guests trust a link on the
// business's own name far more than a random cloud address.
const PUBLIC_BASE = "https://welverdiendaccommodation.com";

// How far back a finished stay stays on the "due" list.
const DUE_WINDOW_DAYS = 60;

const DEFAULT_REVIEW_URL = "https://g.page/r/CVSR9OHKczIqEAI/review";
const DEFAULT_MESSAGE_TEMPLATE =
  "Hi {name}, thank you so much for staying with us at Welverdiend Accommodation! " +
  "We hope you enjoyed the peace and the wildlife.\n\n" +
  "If you have a minute, we'd be very grateful for a quick Google review — it really helps a small family business like ours:\n" +
  "{link}\n\n" +
  "Warm regards,\nWelverdiend Accommodation";

// Only ever redirect guests to Google. The URL is typed into the
// dashboard, but it's still checked here so the /r/ links can never be
// turned into a redirect to some other site.
const ALLOWED_REVIEW_HOSTS = ["g.page", "search.google.com", "www.google.com", "google.com", "maps.app.goo.gl", "www.google.co.za", "google.co.za"];

function isAllowedReviewUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_REVIEW_HOSTS.includes(u.hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

function todaySA() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" });
}

function addDays(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function userError(message) {
  const err = new Error(message);
  err.userFacing = true;
  return err;
}

async function getReviewSettings() {
  const doc = await SETTINGS_DOC.get();
  const saved = doc.exists ? doc.data() : {};
  return {
    googleReviewUrl: saved.googleReviewUrl || DEFAULT_REVIEW_URL,
    messageTemplate: saved.messageTemplate || DEFAULT_MESSAGE_TEMPLATE,
    defaultMessageTemplate: DEFAULT_MESSAGE_TEMPLATE
  };
}

async function saveReviewSettings({ googleReviewUrl, messageTemplate }) {
  const payload = {};
  if (googleReviewUrl !== undefined) {
    const url = String(googleReviewUrl).trim();
    if (!isAllowedReviewUrl(url)) {
      throw userError("The review link must be a Google link starting with https:// — e.g. https://g.page/r/…/review");
    }
    payload.googleReviewUrl = url;
  }
  if (messageTemplate !== undefined) {
    const t = String(messageTemplate).trim();
    if (t && !t.includes("{link}")) throw userError("The message must contain {link}, or guests won't get the review link.");
    payload.messageTemplate = t; // blank = fall back to the default
  }
  await SETTINGS_DOC.set(payload, { merge: true });
}

/**
 * Normalises a phone number to international digits. South African
 * numbers are usually written locally ("082 123 4567"), which wa.me
 * can't use — a leading 0 becomes 27. Anything already international
 * ("+44 7700…", "27 82…") is kept as typed, minus the punctuation.
 */
function normalisePhone(raw) {
  let s = String(raw || "").trim();
  const hadPlus = s.startsWith("+");
  s = s.replace(/\D/g, "");
  if (!hadPlus && s.startsWith("00")) s = s.slice(2);
  else if (!hadPlus && s.startsWith("0")) s = "27" + s.slice(1);
  return /^\d{9,15}$/.test(s) ? s : null;
}

const CHANNELS = ["whatsapp", "sms", "email"];

function cleanRequestInput(body) {
  const b = body || {};
  const guestName = String(b.guestName || "").trim().slice(0, 80);
  if (!guestName) return { error: "Please enter the guest's name." };

  const channel = String(b.channel || "").toLowerCase();
  if (!CHANNELS.includes(channel)) return { error: "Pick WhatsApp, SMS or email." };

  let contact;
  if (channel === "email") {
    contact = String(b.contact || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) return { error: "That email address doesn't look right." };
  } else {
    contact = normalisePhone(b.contact);
    if (!contact) return { error: "That phone number doesn't look right — e.g. 082 123 4567 or +44 7700 900123." };
  }

  const stayKey = /^(booking|stay):[\w-]{1,120}$/.test(b.stayKey || "") ? b.stayKey : null;
  const source = String(b.source || "manual").slice(0, 20);
  const unitId = b.unitId ? String(b.unitId).slice(0, 20) : null;
  const checkOut = /^\d{4}-\d{2}-\d{2}$/.test(b.checkOut || "") ? b.checkOut : null;
  const sentBy = String(b.sentBy || "").trim().slice(0, 40);

  return { value: { guestName, channel, contact, stayKey, source, unitId, checkOut, sentBy } };
}

async function newToken() {
  for (let i = 0; i < 5; i++) {
    const token = crypto.randomBytes(6).toString("base64url"); // 8 chars, unguessable
    const doc = await reviewRequestsCollection.doc(token).get();
    if (!doc.exists) return token;
  }
  throw new Error("Could not generate a unique link token");
}

function linkFor(token) {
  return `${PUBLIC_BASE}/r/${token}`;
}

async function findDuplicate(contact) {
  const snap = await reviewRequestsCollection.where("contact", "==", contact).get();
  if (snap.empty) return null;
  return snap.docs.map(d => d.data()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

async function createReviewRequest(value) {
  const token = await newToken();
  const request = {
    id: token,
    ...value,
    createdAt: new Date().toISOString(),
    clickCount: 0,
    firstClickedAt: null,
    lastClickedAt: null,
    reviewedAt: null
  };
  await reviewRequestsCollection.doc(token).set(request);
  return request;
}

async function recordClick(token) {
  const ref = reviewRequestsCollection.doc(token);
  await firestore.runTransaction(async tx => {
    const doc = await tx.get(ref);
    if (!doc.exists) return;
    const now = new Date().toISOString();
    tx.update(ref, {
      clickCount: FieldValue.increment(1),
      lastClickedAt: now,
      ...(doc.data().firstClickedAt ? {} : { firstClickedAt: now })
    });
  });
}

/**
 * Called after every availability sync. Remembers each OTA stay once
 * it has started, because the feeds drop it the moment it ends — and
 * "ended" is exactly when it becomes worth asking for a review.
 * Owner blocks and anything involving a direct booking are skipped
 * (direct bookings come straight from the bookings collection).
 * Reads first and only writes new stays, so the 5-minute sync doesn't
 * rewrite the same documents all day.
 */
async function recordStartedStays(unitId, busyRanges) {
  const today = todaySA();
  const started = (busyRanges || []).filter(r =>
    !r.blocked && r.start <= today && !(r.sources || []).includes("direct")
  );
  if (!started.length) return;
  const refs = started.map(r => reviewStaysCollection.doc(`${unitId}_${r.start}_${r.end}`));
  const docs = await firestore.getAll(...refs);
  const batch = firestore.batch();
  let writes = 0;
  docs.forEach((doc, i) => {
    if (doc.exists) return;
    const r = started[i];
    batch.set(refs[i], { unitId, start: r.start, end: r.end, sources: r.sources || [], firstSeenAt: new Date().toISOString() });
    writes++;
  });
  if (writes) await batch.commit();
}

/**
 * Stays that have ended in the last DUE_WINDOW_DAYS and haven't been
 * asked about or skipped yet — direct bookings (with the guest's
 * details) plus remembered OTA stays (dates only; the platforms never
 * share the guest's name or number through the calendar feed).
 */
async function getDueStays(requests) {
  const today = todaySA();
  const from = addDays(today, -DUE_WINDOW_DAYS);

  const [bookingSnap, staySnap, skipSnap] = await Promise.all([
    bookingsCollection.where("status", "in", ["confirmed", "submitted"]).get(),
    reviewStaysCollection.where("end", ">=", from).get(),
    reviewSkipsCollection.get()
  ]);

  const handled = new Set([
    ...requests.map(r => r.stayKey).filter(Boolean),
    ...skipSnap.docs.map(d => d.id)
  ]);

  const direct = bookingSnap.docs
    .map(d => d.data())
    .filter(b => b.checkOut && b.checkOut <= today && b.checkOut >= from)
    .map(b => ({
      stayKey: `booking:${b.id}`,
      source: b.manual && b.bookingChannel ? String(b.bookingChannel) : "direct",
      unitId: b.unitId,
      checkIn: b.checkIn,
      checkOut: b.checkOut,
      guestName: b.guestName || "",
      phone: b.phone || "",
      email: b.email || ""
    }));

  const ota = staySnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => s.end <= today)
    .map(s => ({
      stayKey: `stay:${s.id}`,
      source: (s.sources || []).join(" + ") || "platform",
      unitId: s.unitId,
      checkIn: s.start,
      checkOut: s.end,
      guestName: "",
      phone: "",
      email: ""
    }));

  return [...direct, ...ota]
    .filter(s => !handled.has(s.stayKey))
    .sort((a, b) => b.checkOut.localeCompare(a.checkOut));
}

async function skipStay(stayKey) {
  if (!/^(booking|stay):[\w-]{1,120}$/.test(stayKey || "")) throw userError("Unknown stay.");
  await reviewSkipsCollection.doc(stayKey).set({ skippedAt: new Date().toISOString() });
}

module.exports = {
  reviewRequestsCollection,
  getReviewSettings, saveReviewSettings, isAllowedReviewUrl,
  cleanRequestInput, findDuplicate, createReviewRequest, linkFor, recordClick,
  recordStartedStays, getDueStays, skipStay, todaySA
};
