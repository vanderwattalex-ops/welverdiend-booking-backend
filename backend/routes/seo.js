// ---------------------------------------------------------------------------
// Machine-facing files for search engines and AI assistants:
//   /llms.txt           plain-text brief for AI tools, built from live data
//   /sitemap.xml        page list plus every site photo (for Google Images)
//   /favicon.ico        48px icon (browsers and Google results ask for it)
//   /apple-touch-icon.png  180px icon for phone home screens and bookmarks
//   /<key>.txt          IndexNow ownership key (lets Bing be told about changes)
// Mounted before express.static, so the live sitemap wins over the static
// site/sitemap.xml -- which stays as the fallback if the live one fails.
// ---------------------------------------------------------------------------

const express = require("express");
const path = require("path");
const { getFacts, llmsTxt, SITE } = require("../lib/siteFacts");
const { cachedContent, galleryUrls } = require("../lib/prerender");
const { INDEXNOW_KEY } = require("../lib/indexnow");

const router = express.Router();

const PAGES = [
  { path: "/", images: c => [c.heroPhotos && c.heroPhotos.homeTop, c.heroPhotos && c.heroPhotos.homeSecond] },
  { path: "/about.html", images: c => [c.heroPhotos && c.heroPhotos.aboutPhoto] },
  { path: "/unit1.html", images: c => galleryUrls(c, "unit1", 1000) },
  { path: "/unit2.html", images: c => galleryUrls(c, "unit2", 1000) },
  { path: "/wildlife.html", images: c => galleryUrls(c, "wildlife", 1000) },
  { path: "/pets.html", images: c => galleryUrls(c, "pets", 1000) },
  { path: "/location.html" },
  { path: "/faq.html" },
  { path: "/reviews.html" },
  { path: "/contact.html" }
];

function xmlEsc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

router.get("/sitemap.xml", async (req, res, next) => {
  try {
    const c = await cachedContent();
    const urls = PAGES.map(p => {
      const imgs = (p.images ? p.images(c) : []).filter(Boolean);
      return `  <url>\n    <loc>${SITE}${p.path}</loc>\n` +
        imgs.map(u => `    <image:image><image:loc>${xmlEsc(u)}</image:loc></image:image>\n`).join("") +
        `  </url>`;
    });
    res.type("application/xml").send(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n` +
      urls.join("\n") + `\n</urlset>\n`
    );
  } catch (err) {
    console.error("[seo] live sitemap failed, serving static -", err.message);
    next();
  }
});

router.get("/llms.txt", async (req, res) => {
  try {
    const [facts, content] = await Promise.all([getFacts(), cachedContent()]);
    res.set("Cache-Control", "public, max-age=3600").type("text/plain; charset=utf-8").send(llmsTxt(facts, content));
  } catch (err) {
    console.error("[seo] llms.txt failed -", err.message);
    res.status(503).type("text/plain").send("Temporarily unavailable.");
  }
});

// Icons are made once per instance from the logo, so there are no extra
// image files to keep in step with it. The logo is a thin taupe W on a
// transparent, non-square canvas -- Google pads that with grey/black bars and
// the strokes vanish at 16-48px -- so the icon is a solid taupe square with a
// cream, slightly thickened W, sized to survive Google's circle crop.
const LOGO = path.join(__dirname, "..", "public", "logo-mark.png");
const TAUPE = { r: 138, g: 126, b: 104 };
const CREAM = { r: 250, g: 248, b: 243 };
const iconCache = new Map();

async function brandIcon(size) {
  const sharp = require("sharp");
  const big = size * 4;                     // draw large, shrink once at the end
  const mark = Math.round(big * 0.72);
  const fitted = await sharp(LOGO).trim().ensureAlpha()
    .resize(mark, mark, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  const alpha = await sharp(fitted).extractChannel(3)
    .blur(Math.max(0.3, big / 160)).linear(4, 0)   // thicken the hairline strokes
    .toBuffer();
  const w = await sharp({ create: { width: mark, height: mark, channels: 3, background: CREAM } })
    .joinChannel(alpha).png().toBuffer();
  const full = await sharp({ create: { width: big, height: big, channels: 3, background: TAUPE } })
    .composite([{ input: w, gravity: "center" }]).png().toBuffer();
  return sharp(full).resize(size, size).png().toBuffer();
}

function icon(size) {
  return async (req, res) => {
    try {
      if (!iconCache.has(size)) iconCache.set(size, await brandIcon(size));
      res.set("Cache-Control", "public, max-age=604800").type("image/png").send(iconCache.get(size));
    } catch (err) {
      console.error("[seo] icon failed -", err.message);
      res.set("Cache-Control", "public, max-age=3600").sendFile(LOGO);
    }
  };
}
router.get("/favicon.ico", icon(48));
router.get("/icon-192.png", icon(192));   // the <link rel="icon"> Google search results use
router.get("/icon-512.png", icon(512));   // logo in the home page's structured data
router.get("/apple-touch-icon.png", icon(180));

router.get(`/${INDEXNOW_KEY}.txt`, (req, res) => res.type("text/plain").send(INDEXNOW_KEY));

module.exports = router;
module.exports.INDEXNOW_KEY = INDEXNOW_KEY;
