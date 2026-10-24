// ---------------------------------------------------------------------------
// SERVER-SIDE PRE-RENDERING
// ---------------------------------------------------------------------------
// The site pages ship with empty containers ("Loading…") that the browser
// fills in from /api/site-content. Googlebot runs JavaScript and copes, but
// Bingbot renders inconsistently and most AI crawlers (GPTBot, ClaudeBot,
// PerplexityBot) do not render at all -- they read the raw HTML only. Before
// this, faq.html served them a page whose entire body said "Loading…", and
// reviews, recommendations and every real photograph were invisible.
//
// This fills those same containers server-side, using markup that matches the
// client templates, so the initial HTML already contains the content. The
// client JS still runs afterwards and re-renders identical markup, which is
// harmless and keeps live data (availability, weather) working.
//
// Everything here is best-effort: any failure returns null and the caller
// falls through to serving the original file, i.e. exactly the old behaviour.
// ---------------------------------------------------------------------------

const fs = require("fs").promises;
const { getSiteContent } = require("./siteContent");
const { thumbUrl, heroImgAttrs } = require("./thumbnails");
const { getFacts, factsHtml, SITE } = require("./siteFacts");

const CONTENT_TTL_MS = 60 * 1000;
let contentCache = { at: 0, value: null };

async function cachedContent() {
  if (contentCache.value && Date.now() - contentCache.at < CONTENT_TTL_MS) {
    return contentCache.value;
  }
  const value = await getSiteContent();
  contentCache = { at: Date.now(), value };
  return value;
}

const fileCache = new Map();
async function cachedFile(filePath) {
  if (fileCache.has(filePath)) return fileCache.get(filePath);
  const html = await fs.readFile(filePath, "utf8");
  fileCache.set(filePath, html);
  return html;
}

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Replace everything between a container's opening tag and its matching close.
// Counts nesting depth rather than stopping at the first </div>, so it stays
// correct if a placeholder ever gains nested markup.
function replaceContainer(html, id, inner) {
  const open = new RegExp(`<div[^>]*\\bid="${id}"[^>]*>`);
  const match = html.match(open);
  if (!match) return html;

  const start = match.index + match[0].length;
  let depth = 1;
  let i = start;
  const tag = /<\/?div\b[^>]*>/g;
  tag.lastIndex = start;
  let t;
  while ((t = tag.exec(html))) {
    depth += t[0][1] === "/" ? -1 : 1;
    if (depth === 0) { i = t.index; break; }
  }
  if (depth !== 0) return html;

  return html.slice(0, start) + inner + html.slice(i);
}

// Grid tile: the small thumbnail, falling back to the full photo if the
// thumbnail is missing. The lightbox reads full URLs from the page's own
// photo list, not from these tags. Mirrors galleryImg() in the page scripts.
function galleryImg(url, alt, index) {
  return `<img src="${esc(thumbUrl(url))}" data-full="${esc(url)}" onerror="this.onerror=null;this.src=this.dataset.full" alt="${esc(alt)}" width="400" height="220" loading="lazy" data-index="${index}">`;
}

// Put a photo URL into an <img id="..." src=""> placeholder, so the browser
// can start fetching it straight away instead of waiting for the page script
// to fetch /api/site-content first.
function setImgSrc(html, id, url, extra) {
  if (!url) return html;
  return html.replace(new RegExp(`<img\\b[^>]*\\bid="${id}"[^>]*>`), tag =>
    tag.replace(`src=""`, `src="${esc(url)}"${extra ? " " + extra : ""}`));
}

// Same, for the big home/about photos: WebP srcset (phone + desktop size) with
// the JPEG kept in data-full as the fallback if a copy is missing.
function setHeroImg(html, id, url, sizes, extra) {
  if (!url) return html;
  const a = heroImgAttrs(url, sizes);
  if (!a.srcset) return setImgSrc(html, id, url, extra);
  const attrs = `srcset="${esc(a.srcset)}" sizes="${esc(a.sizes)}" data-full="${esc(a.full)}" onerror="this.onerror=null;this.removeAttribute('srcset');this.src=this.dataset.full"`;
  return setImgSrc(html, id, a.src, attrs + (extra ? " " + extra : ""));
}

// The owner's chosen focus point for each named photo (what stays in view when the
// photo is cropped), as a small <style> block so it applies before any script runs.
const FOCUS_IDS = {
  homeTop: "hero-top-img", homeSecond: "hero-second-img", aboutPhoto: "about-photo-img",
  petPhoto1: "pet-photo-1", petPhoto2: "pet-photo-2", petPhoto3: "pet-photo-3",
  featurePhoto1: "feature-photo-1", featurePhoto2: "feature-photo-2", featurePhoto3: "feature-photo-3"
};
function addFocusStyle(html, content, slots) {
  const focus = content.heroFocus || {};
  const rules = slots
    .filter(s => /^\d{1,3}% \d{1,3}%$/.test(focus[s] || ""))
    .map(s => `#${FOCUS_IDS[s]}{object-position:${focus[s]};}`);
  return rules.length ? html.replace("</head>", `<style id="photo-focus">${rules.join("")}</style>\n</head>`) : html;
}

// Featured photos on the Home page: show the spots that have a photo, with their
// captions, and the section itself only when at least one photo exists.
function featureHtml(html, content) {
  const hero = content.heroPhotos || {};
  const caps = content.featureCaptions || [];
  let shown = 0;
  [1, 2, 3].forEach(n => {
    const url = hero[`featurePhoto${n}`];
    if (!url) return;
    shown++;
    const cap = caps[n - 1] || "";
    html = html.replace(`<figure class="feature-photo" id="feature-${n}" hidden>`, `<figure class="feature-photo" id="feature-${n}">`);
    html = html.replace(`id="feature-photo-${n}" src="" width="1200" height="800" alt=""`,
      `id="feature-photo-${n}" src="" width="1200" height="800" alt="${esc(cap || "Welverdiend Accommodation")}"`);
    html = setHeroImg(html, `feature-photo-${n}`, url, "(max-width: 760px) 92vw, 50vw");
    html = html.replace(`<figcaption id="feature-caption-${n}"></figcaption>`, `<figcaption id="feature-caption-${n}">${esc(cap)}</figcaption>`);
  });
  if (!shown) return html;
  html = html.replace('id="feature-section" hidden>', 'id="feature-section">');
  html = html.replace('id="feature-photos" data-count="0"', `id="feature-photos" data-count="${shown}"`);
  if (content.featureHeading) html = html.replace('<h2 id="feature-heading">Featured at Welverdiend</h2>', `<h2 id="feature-heading">${esc(content.featureHeading)}</h2>`);
  return html;
}

// Preload the above-the-fold photo from <head>, ahead of CSS and fonts.
function preloadImage(html, url, sizes) {
  if (!url) return html;
  const a = heroImgAttrs(url, sizes);
  const set = a.srcset ? ` imagesrcset="${esc(a.srcset)}" imagesizes="${esc(a.sizes)}"` : "";
  return html.replace("</head>", `<link rel="preload" as="image" href="${esc(a.src)}"${set} fetchpriority="high">
</head>`);
}

function aboutHtml(paragraphs) {
  return (paragraphs || [])
    .map(p => `<p class="lede" style="margin:0 0 20px;text-align:left;">${esc(p)}</p>`)
    .join("");
}

function faqHtml(faqs) {
  return (faqs || []).map(f => `
        <div class="faq-item">
          <p class="faq-question">${esc(f.question)}</p>
          <p class="faq-answer">${esc(f.answer)}</p>
        </div>
      `).join("");
}

function reviewsHtml(reviews) {
  return (reviews || []).map(r => `
        <div class="review-card">
          <div class="review-stars">${"★".repeat(r.rating || 0)}${"☆".repeat(Math.max(0, 5 - (r.rating || 0)))}</div>
          <p class="review-text">"${esc(r.text)}"</p>
          <div class="review-name">${esc(r.name)}</div>
        </div>
      `).join("");
}

function recsHtml(recs) {
  return (recs || []).map(r => `
        <div class="rec-card">
          ${r.category ? `<div class="rec-category">${esc(r.category)}</div>` : ""}
          <div class="rec-name">${esc(r.name)}</div>
          ${r.description ? `<p class="rec-desc">${esc(r.description)}</p>` : ""}
          ${(r.distance || r.mapLink) ? `
            <div class="rec-meta">
              <span class="rec-distance">${esc(r.distance || "")}</span>
              ${r.mapLink ? `<a href="${esc(r.mapLink)}" target="_blank" rel="noopener" class="rec-maplink">View on map →</a>` : ""}
            </div>
          ` : ""}
        </div>
      `).join("");
}

// The wildlife gallery is a different shape to the unit ones: a flat list of
// URL strings with no sections, rendered as a single grid. Mirrors the markup
// in wildlife.html.
function flatGalleryHtml(content, key, alt) {
  const photos = (content.galleries && content.galleries[key]) || [];
  if (photos.length === 0) return null;
  const imgs = photos
    .map((p, i) => {
      const url = typeof p === "string" ? p : (p && p.url);
      if (!url) return "";
      return galleryImg(url, alt, i);
    })
    .join("");
  return imgs ? `<div class="gallery-grid">${imgs}</div>` : null;
}

// Pet photos: a grid of photo + optional caption. Mirrors the markup built by
// pets.html in the browser. Entries are {id, url, caption}; plain strings
// (older data) are accepted too.
function petGalleryHtml(content) {
  const photos = (content.galleries && content.galleries.pets) || [];
  const items = photos
    .map(p => (typeof p === "string" ? { url: p, caption: "" } : p))
    .filter(p => p && p.url);
  if (items.length === 0) return null;
  const figs = items
    .map((p, i) => {
      const cap = String(p.caption || "").trim();
      const alt = cap || "A guest's pet at Welverdiend";
      return `<figure class="pet-photo">${galleryImg(p.url, alt, i)}${cap ? `<figcaption>${esc(cap)}</figcaption>` : ""}</figure>`;
    })
    .join("");
  return `<div class="gallery-grid pet-grid">${figs}</div>`;
}

function galleryHtml(content, unitId, label) {
  const photos = (content.galleries && content.galleries[unitId]) || [];
  if (photos.length === 0) return null;
  const sectionNames = (content.gallerySections && content.gallerySections[unitId]) || [];
  const groups = [...sectionNames, "Other"]
    .map(name => ({ name, photos: photos.filter(p => p.section === name) }))
    .filter(g => g.photos.length > 0);
  if (groups.length === 0) return null;

  // Five highlight photos (the first of each section, topped up in order) above a folded
  // "See all" gallery. Mirrors the unit pages' script; the full gallery stays in the HTML.
  const ordered = groups.flatMap(g => g.photos);
  const indexOf = new Map(ordered.map((p, i) => [p.url, i]));
  const picks = groups.map(g => g.photos[0]);
  ordered.forEach(p => { if (picks.length < 5 && !picks.includes(p)) picks.push(p); });
  const highlights = picks.slice(0, 5);
  const folded = ordered.length > highlights.length;

  let index = 0;
  return `
        <div class="gallery-highlights">
          ${highlights.map(p => galleryImg(p.url, `${label} — ${p.section}`, indexOf.get(p.url))).join("")}
        </div>
        ${folded ? `
        <div class="gallery-more">
          <button type="button" class="gallery-more-btn" aria-expanded="false" aria-controls="gallery-all">See all ${ordered.length} photos</button>
        </div>` : ""}
        <div class="gallery-all" id="gallery-all" ${folded ? "hidden" : ""}>
          ${groups.map(g => `
          <div class="gallery-section">
            <h2 style="font-size:22px;margin-bottom:16px;">${esc(g.name)}</h2>
            <div class="gallery-grid">
              ${g.photos.map(p => galleryImg(p.url, `${label} — ${g.name}`, index++)).join("")}
            </div>
          </div>`).join("")}
        </div>`;
}

// ---------------------------------------------------------------------------
// Additions applied to every page (see applyCommon)
// ---------------------------------------------------------------------------

const BUSINESS_ID = `${SITE}/#business`;

// Breadcrumb name and schema.org page type for each page. index.html is the
// root and carries the LodgingBusiness + WebSite entities in its own file.
const PAGE_INFO = {
  "about.html":    { name: "About",    type: "AboutPage" },
  "unit1.html":    { name: "Unit 1",   type: "WebPage" },
  "unit2.html":    { name: "Unit 2",   type: "WebPage" },
  "wildlife.html": { name: "Wildlife", type: "WebPage" },
  "pets.html":     { name: "Pet-Friendly Stays", type: "WebPage" },
  "location.html": { name: "Location", type: "WebPage" },
  "faq.html":      { name: "FAQ",      type: "WebPage" }, // the FAQPage entity is already in faq.html
  "reviews.html":  { name: "Reviews",  type: "WebPage" },
  "contact.html":  { name: "Contact",  type: "ContactPage" }
};

// JSON for a <script> block: "</" would end the script early.
function jsonLd(obj) {
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\u003c")}</script>`;
}

function pageLdHtml(page, html) {
  const info = PAGE_INFO[page];
  if (!info) return "";
  const url = `${SITE}/${page}`;
  const title = ((html.match(/<title>([^<]*)<\/title>/) || [])[1] || info.name).trim();
  return jsonLd({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": info.type,
        "@id": `${url}#webpage`,
        url,
        name: title,
        inLanguage: "en-ZA",
        isPartOf: { "@id": `${SITE}/#website` },
        about: { "@id": BUSINESS_ID },
        breadcrumb: { "@id": `${url}#breadcrumb` }
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${url}#breadcrumb`,
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${SITE}/` },
          { "@type": "ListItem", position: 2, name: info.name, item: url }
        ]
      }
    ]
  });
}

// Add the unit's own photos, and its live nightly rate from admin Settings,
// to its Accommodation JSON-LD block.
function addUnitSchema(html, urls, price) {
  if (!urls.length && !price) return html;
  return html.replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/, (whole, json) => {
    try {
      const data = JSON.parse(json);
      if (data["@type"] !== "Accommodation") return whole;
      if (urls.length) data.image = urls;
      if (price) {
        data.offers = {
          "@type": "Offer",
          url: `${SITE}/booking-widget.html?unit=${data.url.match(/(unit\d)\.html/)[1]}`,
          priceSpecification: {
            "@type": "UnitPriceSpecification",
            price,
            priceCurrency: "ZAR",
            unitText: "night"
          }
        };
      }
      return jsonLd(data);
    } catch (err) {
      return whole;
    }
  });
}

// Each page's own photo when the link is shared (WhatsApp, Facebook), instead
// of every page showing the home page's hero.
function setShareImage(html, url) {
  if (!url) return html;
  return html
    .replace(/(<meta property="og:image" content=")[^"]*(")/, `$1${esc(url)}$2`)
    .replace(/(<meta name="twitter:image" content=")[^"]*(")/, `$1${esc(url)}$2`);
}

function galleryUrls(c, key, max) {
  return ((c.galleries && c.galleries[key]) || [])
    .map(p => (typeof p === "string" ? p : p && p.url))
    .filter(Boolean)
    .slice(0, max);
}

function shareImageFor(page, c) {
  const hero = c.heroPhotos || {};
  if (page === "about.html") return hero.aboutPhoto;
  if (page === "unit1.html" || page === "unit2.html" || page === "wildlife.html" || page === "pets.html") {
    return galleryUrls(c, page.replace(".html", ""), 1)[0];
  }
  return null;
}

function applyCommon(page, c, facts, html) {
  if (facts) html = html.replace('<footer class="site-footer">', factsHtml(facts) + '\n<footer class="site-footer">');
  const ld = pageLdHtml(page, html);
  if (ld) html = html.replace("</head>", ld + "\n</head>");
  html = setShareImage(html, shareImageFor(page, c));
  if (page === "unit1.html" || page === "unit2.html") {
    const id = page.replace(".html", "");
    const unit = facts && (facts.units || []).find(u => u.id === id);
    html = addUnitSchema(html, galleryUrls(c, id, 8), unit && unit.price);
  }
  return html;
}

// Which containers each page fills, and with what.
const PAGES = {
  "index.html":    (c, h) => {
    const hero = c.heroPhotos || {};
    h = addFocusStyle(h, c, ["homeTop", "homeSecond", "petPhoto1", "petPhoto2", "petPhoto3", "featurePhoto1", "featurePhoto2", "featurePhoto3"]);
    h = preloadImage(h, hero.homeTop, "100vw");
    h = setHeroImg(h, "hero-top-img", hero.homeTop, "100vw", 'fetchpriority="high"');
    h = setHeroImg(h, "hero-second-img", hero.homeSecond, "100vw", 'loading="lazy"');
    [1, 2, 3].forEach(n => {
      if (!hero[`petPhoto${n}`]) return;
      h = setHeroImg(h, `pet-photo-${n}`, hero[`petPhoto${n}`], "(max-width: 700px) 340px, 33vw");
      // photo present -> drop the "Your pet here" placeholder that follows its <img>
      h = h.replace(new RegExp(`(<img\\b[^>]*\\bid="pet-photo-${n}"[^>]*>)<span class="pet-placeholder"[^>]*>.*?</span>`), "$1");
    });
    h = featureHtml(h, c);
    return replaceContainer(h, "reviews-preview", reviewsHtml((c.reviews || []).slice(0, 3)));
  },
  "about.html":    (c, h) => {
    h = addFocusStyle(h, c, ["aboutPhoto"]);
    h = setHeroImg(h, "about-photo-img", (c.heroPhotos || {}).aboutPhoto, "100vw");
    return replaceContainer(h, "about-text", aboutHtml(c.aboutParagraphs));
  },
  "faq.html":      (c, h) => replaceContainer(h, "faq-list", faqHtml(c.faqs)),
  "reviews.html":  (c, h) => replaceContainer(h, "reviews-list", reviewsHtml(c.reviews)),
  "location.html": (c, h) => replaceContainer(h, "recs-grid", recsHtml(c.recommendations)),
  "contact.html":  (c, h) => h,
  "unit1.html":    (c, h) => { const g = galleryHtml(c, "unit1", "Unit 1"); return g ? replaceContainer(h, "gallery-wrap", g) : h; },
  "unit2.html":    (c, h) => { const g = galleryHtml(c, "unit2", "Unit 2"); return g ? replaceContainer(h, "gallery-wrap", g) : h; },
  "wildlife.html": (c, h) => { const g = flatGalleryHtml(c, "wildlife", "Welverdiend wildlife"); return g ? replaceContainer(h, "gallery-wrap", g) : h; },
  "pets.html":     (c, h) => {
    const g = petGalleryHtml(c);
    // Until the first photo is added, say so in the HTML itself rather than leaving "Loading photos..." for crawlers.
    const empty = '<div class="gallery-empty"><p style="margin:0;">Photos of our four-legged guests are on their way — check back soon.</p></div>';
    return replaceContainer(h, "gallery-wrap", g || empty);
  }
};

function handles(page) {
  return Object.prototype.hasOwnProperty.call(PAGES, page);
}

// Facts are an addition, not the page: if settings can't be read, serve the
// page without the panel rather than falling back to the bare file.
async function factsOrNull() {
  try {
    return await getFacts();
  } catch (err) {
    console.error("[prerender] facts unavailable -", err.message);
    return null;
  }
}

// Returns the pre-rendered HTML, or null to let the caller serve the file
// untouched. Never throws.
async function prerender(filePath, page) {
  try {
    if (!handles(page)) return null;
    const [html, content, facts] = await Promise.all([cachedFile(filePath), cachedContent(), factsOrNull()]);
    return applyCommon(page, content, facts, PAGES[page](content, html));
  } catch (err) {
    console.error("[prerender] falling back to static for", page, "-", err.message);
    return null;
  }
}

module.exports = { prerender, handles, cachedContent, galleryUrls };
