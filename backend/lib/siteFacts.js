// ---------------------------------------------------------------------------
// SITE FACTS — the plain, checkable facts about Welverdiend
// ---------------------------------------------------------------------------
// One source for the "At a glance" panel on every public page and for
// /llms.txt. Search engines and AI assistants answer "how much / how many /
// are pets allowed" from visible text, and before this the nightly rate
// appeared nowhere on the site except inside JSON-LD.
//
// Rate, bedrooms and sleeps come from the live settings (admin Settings
// tab), so changing the rate there updates the site within a minute. The
// rest are fixed facts that already appear elsewhere on the site (footer,
// JSON-LD, FAQ) -- change them here if they ever change.
//
// Only unit fields are read from settings. Bank details live in the same
// document and must never reach a public page.
// ---------------------------------------------------------------------------

const { getSettings } = require("./settings");

const SITE = "https://welverdiendaccommodation.com";

const FIXED = {
  name: "Welverdiend Accommodation",
  address: "4 Kenilworth Road, Groenvlei, Bloemfontein, 9301, Free State, South Africa",
  phone: "079 118 3173",
  phoneIntl: "+27 79 118 3173",
  email: "bookings@welverdiendaccommodation.com",
  checkIn: "14:00",
  checkOut: "10:00",
  pets: "Welcome at no extra charge",
  included: "Free Wi-Fi, free secure parking, fully equipped kitchen, smart TV, dedicated work area and braai facilities",
  wildlife: "Springbok, ostriches and ducks roam freely on the property",
  booking: "Book direct on the website with no booking fees; a 50% deposit secures the dates",
  alsoOn: [
    ["Airbnb (Unit 1)", "https://www.airbnb.co.za/rooms/1543967224420154478"],
    ["Airbnb (Unit 2)", "https://www.airbnb.com/rooms/1337503040346302823"],
    ["LekkeSlaap", "https://www.lekkeslaap.co.za/akkommodasie/welverdiend"],
    ["Booking.com", "https://www.booking.com/hotel/za/welverdiend-bloemfontein.html"]
  ]
};

const TTL_MS = 60 * 1000;
let cache = { at: 0, value: null };

function rand(n) {
  // "R1 400" -- South African style, no decimals for whole rands
  return "R" + Math.round(n).toLocaleString("en-ZA").replace(/,/g, " ");
}

function summariseUnits(units) {
  const rates = units.map(u => Number(u.pricePerNight)).filter(n => n > 0);
  const min = Math.min(...rates), max = Math.max(...rates);
  const same = (key) => units.every(u => u[key] === units[0][key]) ? units[0][key] : null;
  return {
    unitCount: units.length,
    rate: rates.length ? (min === max ? `${rand(min)} per unit per night` : `${rand(min)}–${rand(max)} per unit per night`) : null,
    sleeps: same("sleeps"),
    bedrooms: same("bedrooms"),
    bathrooms: same("bathrooms"),
    units: [...units].sort((a, b) => String(a.name).localeCompare(String(b.name))).map(u => ({
      id: u.id, name: u.name, rate: u.pricePerNight ? rand(u.pricePerNight) : null,
      sleeps: u.sleeps, bedrooms: u.bedrooms, bathrooms: u.bathrooms
    }))
  };
}

async function getFacts() {
  if (cache.value && Date.now() - cache.at < TTL_MS) return cache.value;
  const { units } = await getSettings();
  const value = { ...FIXED, ...summariseUnits(units) };
  cache = { at: Date.now(), value };
  return value;
}

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function rows(f) {
  const sleeps = f.sleeps
    ? `Up to ${f.sleeps} guests per unit` + (f.bedrooms ? ` · ${f.bedrooms} bedrooms` : "") + (f.bathrooms ? ` · ${f.bathrooms} bathroom${f.bathrooms > 1 ? "s" : ""}` : "")
    : null;
  return [
    ["Where", "Groenvlei, Bloemfontein — 4 Kenilworth Road"],
    ["What", `${f.unitCount} private self-catering units`],
    ["Sleeps", sleeps],
    ["Rate", f.rate],
    ["Pets", f.pets],
    ["Check-in", `From ${f.checkIn} · check-out by ${f.checkOut}`],
    ["Included", f.included],
    ["Booking", f.booking]
  ].filter(([, v]) => v);
}

// The visible panel. Inserted before the footer by lib/prerender.js.
function factsHtml(f) {
  return `
<section class="quick-facts" aria-labelledby="quick-facts-title">
  <h2 id="quick-facts-title">Welverdiend at a glance</h2>
  <dl>
    ${rows(f).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("\n    ")}
  </dl>
</section>
`;
}

// /llms.txt -- a plain-text brief for AI assistants (llmstxt.org format).
function llmsTxt(f, content) {
  const faqs = (content && content.faqs) || [];
  const lines = [
    `# ${f.name}`,
    "",
    `> Pet-friendly self-catering accommodation in Groenvlei, Bloemfontein, South Africa: ${f.unitCount} private units on a smallholding where wildlife roams freely, minutes from the city.`,
    "",
    "## Key facts",
    ...rows(f).map(([k, v]) => `- ${k}: ${v}`),
    `- Wildlife: ${f.wildlife}`,
    `- Address: ${f.address}`,
    `- Phone / WhatsApp: ${f.phoneIntl}`,
    `- Email: ${f.email}`,
    "",
    "## Units",
    ...f.units.map(u => `- [${u.name}](${SITE}/${u.id}.html): sleeps ${u.sleeps}, ${u.bedrooms} bedrooms, ${u.bathrooms} bathroom${u.bathrooms > 1 ? "s" : ""}${u.rate ? `, ${u.rate} per night` : ""}`),
    "",
    "## Pages",
    `- [Home](${SITE}/): overview, availability and guest reviews`,
    `- [About](${SITE}/about.html): the story behind Welverdiend`,
    `- [Wildlife](${SITE}/wildlife.html): the animals on the property`,
    `- [Location](${SITE}/location.html): where it is, with nearby restaurants and shops`,
    `- [FAQ](${SITE}/faq.html): pets, check-in, booking and payment`,
    `- [Reviews](${SITE}/reviews.html): what guests say`,
    `- [Contact](${SITE}/contact.html): phone, email and WhatsApp`,
    `- [Book](${SITE}/booking-widget.html): live availability and direct booking`,
    "",
    "## Also listed on",
    ...f.alsoOn.map(([name, url]) => `- [${name}](${url})`)
  ];
  if (faqs.length) {
    lines.push("", "## Frequently asked questions");
    for (const q of faqs) lines.push("", `### ${q.question}`, "", q.answer);
  }
  return lines.join("\n") + "\n";
}

module.exports = { getFacts, factsHtml, llmsTxt, SITE };
