// ---------------------------------------------------------------------------
// IndexNow: tells Bing (and through it Copilot and ChatGPT search) straight
// away that the public pages changed, instead of waiting for a crawl.
// Called after every successful save in the dashboard's Website tab. Edits are
// rare, so it simply sends every public page; IndexNow is happy with that.
// Best-effort: a failure is logged and never affects the save.
// ---------------------------------------------------------------------------

const { SITE } = require("./siteFacts");

// Not a secret: IndexNow verifies ownership by fetching /<key>.txt from the site.
const INDEXNOW_KEY = "6138a99d3172f4007fcfa3f07dd31b6d";

const PUBLIC_PATHS = [
  "/", "/about.html", "/unit1.html", "/unit2.html", "/wildlife.html", "/pets.html",
  "/location.html", "/faq.html", "/reviews.html", "/contact.html"
];

async function notifyIndexNow() {
  // Only the live service pings; local runs and tests never do.
  if (process.env.NODE_ENV === "test" || !process.env.K_SERVICE) return;
  try {
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: new URL(SITE).host,
        key: INDEXNOW_KEY,
        keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`,
        urlList: PUBLIC_PATHS.map(p => SITE + p)
      }),
      signal: AbortSignal.timeout(4000)
    });
    if (res.status !== 200 && res.status !== 202) console.error("[indexnow] answer", res.status);
  } catch (err) {
    console.error("[indexnow] failed -", err.message);
  }
}

module.exports = { notifyIndexNow, INDEXNOW_KEY, PUBLIC_PATHS };
