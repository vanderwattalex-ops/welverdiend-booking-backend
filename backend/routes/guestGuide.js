// Guest guides: the page a guest opens from the WhatsApp check-in message
// (/unit2, later /unit1), and the admin endpoints behind guide-admin.html.
//
// The page lives in site/<unit>/index.html with all its wording in one
// GUIDE object between /*GUIDE-START*/ and /*GUIDE-END*/. That file is the
// default. When the owner edits the guide in guide-admin.html, the edited
// object is stored in Firestore (settings/guestGuide-<unit>) and swapped in
// here on every request, so edits go live at once with no deploy.
//
// The lockbox code is NEVER part of the guide: it is stored on its own
// (settings/guestGuideMessage-<unit>), is only readable with the admin
// token, and only goes into the WhatsApp message the owner sends.

const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const multer = require("multer");
const sharp = require("sharp");
const { randomUUID } = require("crypto");
const { settingsCollection, siteAssetsBucket } = require("../lib/db");
const { requireAdmin } = require("./adminAuth");

const router = express.Router();
const UNITS = ["unit1", "unit2"];
const SITE = path.join(__dirname, "..", "site");
const START = "/*GUIDE-START*/";
const END = "/*GUIDE-END*/";
const MAX_GUIDE_BYTES = 300 * 1024;
const IMG_LIMIT = 150 * 1024;

const guideDoc = unit => settingsCollection.doc("guestGuide-" + unit);
const messageDoc = unit => settingsCollection.doc("guestGuideMessage-" + unit);

async function readTemplate(unit) {
  try { return await fs.readFile(path.join(SITE, unit, "index.html"), "utf8"); } catch { return null; }
}
function defaultsFrom(html) {
  const a = html.indexOf(START), b = html.indexOf(END);
  if (a < 0 || b < a) throw new Error("GUIDE markers missing");
  return JSON.parse(html.slice(a + START.length, b));
}
// JSON is valid JavaScript; escaping "<" keeps "</script>" in any text from
// closing the script tag early.
function scriptJson(obj) {
  const BS = String.fromCharCode(92); // a backslash
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
  return JSON.stringify(obj)
    .split("<").join(BS + "u003c")
    .split(LS).join(BS + "u2028")
    .split(PS).join(BS + "u2029");
}
const attr = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
function unitOf(req, res) {
  const unit = req.params.unit;
  if (!UNITS.includes(unit)) { res.status(400).json({ ok: false, error: "Unknown unit" }); return null; }
  return unit;
}

// ---------------------------------------------------------------- public

router.get(["/unit1", "/unit2", "/unit1/", "/unit2/"], async (req, res, next) => {
  const unit = req.path.replace(/\//g, "");
  const html = await readTemplate(unit);
  if (!html) return next();
  let out = html;
  try {
    const snap = await guideDoc(unit).get();
    const guide = snap.exists ? snap.data().guide : null;
    if (guide && typeof guide === "object") {
      const a = html.indexOf(START), b = html.indexOf(END);
      out = html.slice(0, a + START.length) + scriptJson(guide) + html.slice(b);
      const og = guide.photos && guide.photos.og;
      if (og && /^https:\/\//.test(og)) out = out.replace(/(<meta property="og:image" content=")[^"]*/, "$1" + attr(og));
    }
  } catch (err) {
    console.error("[guestGuide] could not load saved guide, serving the default:", err.message);
  }
  res.set("Cache-Control", "no-cache");
  res.set("X-Robots-Tag", "noindex, nofollow");
  res.type("html").send(out);
});

// The "Download the full guide (PDF)" button. Opens in the browser (inline),
// served from the public site-assets bucket.
router.get(["/unit1/guest-guide.pdf", "/unit2/guest-guide.pdf"], async (req, res, next) => {
  const unit = req.path.split("/")[1];
  try {
    const snap = await guideDoc(unit).get();
    const url = snap.exists && snap.data().pdfUrl;
    if (!url) return next();
    res.set("Cache-Control", "no-cache");
    res.redirect(302, url);
  } catch (err) {
    next();
  }
});

// ---------------------------------------------------------------- admin

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Please upload a JPG, PNG or WebP photo"), ok);
  }
});
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === "application/pdf";
    cb(ok ? null : new Error("Please upload a PDF"), ok);
  }
});
// multer errors (wrong type, too big) as JSON instead of an HTML error page
const withUpload = mw => (req, res, next) => mw(req, res, err => {
  if (err) return res.status(400).json({ ok: false, error: err.code === "LIMIT_FILE_SIZE" ? "That file is too big" : err.message });
  next();
});

// Shrinks a photo to WebP under 150 KB, lowering quality and then size until it fits.
async function toWebp(buffer, width) {
  let w = width;
  for (let pass = 0; pass < 4; pass++) {
    for (const q of [80, 72, 64, 56, 48]) {
      const out = await sharp(buffer).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: q }).toBuffer();
      if (out.length <= IMG_LIMIT) return out;
    }
    w = Math.round(w * 0.8);
  }
  throw new Error("Could not get the photo under 150 KB");
}

router.get("/api/admin/guest-guide/:unit", requireAdmin, async (req, res) => {
  const unit = unitOf(req, res); if (!unit) return;
  try {
    const html = await readTemplate(unit);
    if (!html) return res.status(404).json({ ok: false, error: `There is no ${unit} guide page yet. Copy site/unit2 to site/${unit} first.` });
    const [g, m] = await Promise.all([guideDoc(unit).get(), messageDoc(unit).get()]);
    const saved = g.exists ? g.data() : {};
    res.json({
      ok: true,
      defaults: defaultsFrom(html),
      guide: saved.guide || null,
      updatedAt: saved.updatedAt || null,
      pdfUrl: saved.pdfUrl || null,
      message: m.exists ? m.data() : null
    });
  } catch (err) {
    console.error("[guestGuide] load failed:", err);
    res.status(500).json({ ok: false, error: "Could not load the guide" });
  }
});

router.put("/api/admin/guest-guide/:unit", requireAdmin, express.json({ limit: "400kb" }), async (req, res) => {
  const unit = unitOf(req, res); if (!unit) return;
  const guide = req.body && req.body.guide;
  if (!guide || typeof guide !== "object" || Array.isArray(guide)) return res.status(400).json({ ok: false, error: "guide must be an object" });
  const text = JSON.stringify(guide);
  if (Buffer.byteLength(text) > MAX_GUIDE_BYTES) return res.status(400).json({ ok: false, error: "The guide is too long to save" });
  try {
    // The page is public: refuse to save if the lockbox code has crept into it.
    const m = await messageDoc(unit).get();
    const code = m.exists && String(m.data().lockboxCode || "").trim();
    if (code && code.length >= 3 && text.includes(code)) {
      return res.status(400).json({ ok: false, error: `The lockbox code (${code}) appears in the guide text. Remove it – the guide page is public.` });
    }
    const updatedAt = new Date().toISOString();
    await guideDoc(unit).set({ guide, updatedAt }, { merge: true });
    res.json({ ok: true, updatedAt });
  } catch (err) {
    console.error("[guestGuide] save failed:", err);
    res.status(500).json({ ok: false, error: "Could not save the guide" });
  }
});

// Back to the wording in the page file.
router.delete("/api/admin/guest-guide/:unit", requireAdmin, async (req, res) => {
  const unit = unitOf(req, res); if (!unit) return;
  try {
    const snap = await guideDoc(unit).get();
    const pdfUrl = snap.exists ? snap.data().pdfUrl || null : null;
    await guideDoc(unit).set({ guide: null, pdfUrl, updatedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    console.error("[guestGuide] reset failed:", err);
    res.status(500).json({ ok: false, error: "Could not reset the guide" });
  }
});

// Private: lockbox code + WhatsApp message wording.
router.put("/api/admin/guest-guide/:unit/message", requireAdmin, express.json(), async (req, res) => {
  const unit = unitOf(req, res); if (!unit) return;
  const lockboxCode = String((req.body && req.body.lockboxCode) || "").trim().slice(0, 40);
  const template = String((req.body && req.body.template) || "").slice(0, 4000);
  const templateAf = String((req.body && req.body.templateAf) || "").slice(0, 4000);
  try {
    await messageDoc(unit).set({ lockboxCode, template, templateAf, updatedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    console.error("[guestGuide] message save failed:", err);
    res.status(500).json({ ok: false, error: "Could not save the message" });
  }
});

router.post("/api/admin/guest-guide/:unit/photo", requireAdmin, withUpload(imageUpload.single("photo")), async (req, res) => {
  const unit = unitOf(req, res); if (!unit) return;
  if (!req.file) return res.status(400).json({ ok: false, error: "No photo attached" });
  const width = Math.min(Math.max(parseInt(req.body.width, 10) || 1000, 300), 1600);
  try {
    const webp = await toWebp(req.file.buffer, width);
    const objectPath = `guest-guide/${unit}/${randomUUID()}.webp`;
    await siteAssetsBucket.file(objectPath).save(webp, {
      contentType: "image/webp",
      metadata: { cacheControl: "public, max-age=31536000, immutable" }
    });
    res.json({ ok: true, url: `https://storage.googleapis.com/${siteAssetsBucket.name}/${objectPath}`, bytes: webp.length });
  } catch (err) {
    console.error("[guestGuide] photo upload failed:", err);
    res.status(500).json({ ok: false, error: "Could not upload the photo" });
  }
});

// The social-preview (WhatsApp) photo must be a JPG of about 1200x630.
router.post("/api/admin/guest-guide/:unit/og-photo", requireAdmin, withUpload(imageUpload.single("photo")), async (req, res) => {
  const unit = unitOf(req, res); if (!unit) return;
  if (!req.file) return res.status(400).json({ ok: false, error: "No photo attached" });
  try {
    const jpg = await sharp(req.file.buffer).rotate().resize(1200, 630, { fit: "cover" }).jpeg({ quality: 78, progressive: true }).toBuffer();
    const objectPath = `guest-guide/${unit}/og-${randomUUID()}.jpg`;
    await siteAssetsBucket.file(objectPath).save(jpg, {
      contentType: "image/jpeg",
      metadata: { cacheControl: "public, max-age=31536000, immutable" }
    });
    res.json({ ok: true, url: `https://storage.googleapis.com/${siteAssetsBucket.name}/${objectPath}` });
  } catch (err) {
    console.error("[guestGuide] og photo upload failed:", err);
    res.status(500).json({ ok: false, error: "Could not upload the photo" });
  }
});

router.post("/api/admin/guest-guide/:unit/pdf", requireAdmin, withUpload(pdfUpload.single("pdf")), async (req, res) => {
  const unit = unitOf(req, res); if (!unit) return;
  if (!req.file) return res.status(400).json({ ok: false, error: "No PDF attached" });
  try {
    const objectPath = `guest-guide/${unit}/guide-${randomUUID()}.pdf`;
    await siteAssetsBucket.file(objectPath).save(req.file.buffer, {
      contentType: "application/pdf",
      metadata: {
        cacheControl: "public, max-age=31536000, immutable",
        contentDisposition: `inline; filename="Welverdiend-${unit}-guest-guide.pdf"`
      }
    });
    const pdfUrl = `https://storage.googleapis.com/${siteAssetsBucket.name}/${objectPath}`;
    await guideDoc(unit).set({ pdfUrl }, { merge: true });
    res.json({ ok: true, pdfUrl, link: `/${unit}/guest-guide.pdf` });
  } catch (err) {
    console.error("[guestGuide] pdf upload failed:", err);
    res.status(500).json({ ok: false, error: "Could not upload the PDF" });
  }
});

router.delete("/api/admin/guest-guide/:unit/pdf", requireAdmin, async (req, res) => {
  const unit = unitOf(req, res); if (!unit) return;
  try {
    await guideDoc(unit).set({ pdfUrl: null }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Could not remove the PDF" });
  }
});

module.exports = router;
