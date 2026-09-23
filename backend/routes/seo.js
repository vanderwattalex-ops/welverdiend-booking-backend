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

const router = express.Router();

// Not a secret: IndexNow verifies ownership by fetching this file from the site.
const INDEXNOW_KEY = "6138a99d3172f4007fcfa3f07dd31b6d";

const PAGES = [
  { path: "/", images: c => [c.heroPhotos && c.heroPhotos.homeTop, c.heroPhotos && c.heroPhotos.homeSecond] },
  { path: "/about.html", images: c => [c.heroPhotos && c.heroPhotos.aboutPhoto] },
  { path: "/unit1.html", images: c => galleryUrls(c, "unit1", 1000) },
  { path: "/unit2.html", images: c => galleryUrls(c, "unit2", 1000) },
  { path: "/wildlife.html", images: c => galleryUrls(c, "wildlife", 1000) },
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
// image files to keep in step with it.
const LOGO = path.join(__dirname, "..", "public", "logo-mark.png");
const iconCache = new Map();
function icon(size, background) {
  return async (req, res) => {
    try {
      if (!iconCache.has(size)) {
        const sharp = require("sharp");
        const pad = Math.round(size * 0.12);
        iconCache.set(size, await sharp(LOGO)
          .resize(size - pad * 2, size - pad * 2, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .extend({ top: pad, bottom: pad, left: pad, right: pad, background: background || { r: 0, g: 0, b: 0, alpha: 0 } })
          .flatten(background ? { background } : false)
          .png()
          .toBuffer());
      }
      res.set("Cache-Control", "public, max-age=604800").type("image/png").send(iconCache.get(size));
    } catch (err) {
      console.error("[seo] icon failed -", err.message);
      res.set("Cache-Control", "public, max-age=3600").sendFile(LOGO);
    }
  };
}
router.get("/favicon.ico", icon(48));
// iOS shows transparency as black, so the home-screen icon gets the site's cream.
router.get("/apple-touch-icon.png", icon(180, { r: 250, g: 248, b: 243 }));

router.get(`/${INDEXNOW_KEY}.txt`, (req, res) => res.type("text/plain").send(INDEXNOW_KEY));

module.exports = router;
module.exports.INDEXNOW_KEY = INDEXNOW_KEY;
