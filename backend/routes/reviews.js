const express = require("express");
const router = express.Router();
const { requireAdmin } = require("./adminAuth");
const {
  reviewRequestsCollection,
  getReviewSettings, saveReviewSettings, isAllowedReviewUrl,
  cleanRequestInput, findDuplicate, createReviewRequest, linkFor, recordClick,
  getDueStays, skipStay, todaySA
} = require("../lib/reviews");

// -----------------------------------------------------------------
// Reviews tab — asking guests for a Google review over WhatsApp, SMS
// or email, with a tracked link. requireAdmin is applied per route,
// NOT with router.use(), for the same reason as rentInvoices.js (see
// the note in server.js about admin.js).
// -----------------------------------------------------------------

// GET /api/admin/reviews  -> every request (newest first), stays due for a request, settings
router.get("/admin/reviews", requireAdmin, async (req, res) => {
  try {
    const [snap, settings] = await Promise.all([reviewRequestsCollection.get(), getReviewSettings()]);
    const requests = snap.docs.map(d => d.data()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const due = await getDueStays(requests);
    res.json({
      ok: true,
      requests: requests.map(r => ({ ...r, link: linkFor(r.id) })),
      due,
      settings,
      today: todaySA()
    });
  } catch (err) {
    console.error("[reviews] load failed:", err);
    res.status(500).json({ ok: false, error: "Could not load review requests" });
  }
});

// POST /api/admin/review-requests
// body: { guestName, channel, contact, stayKey?, source?, unitId?, checkOut?, sentBy?, force? }
// Refuses with 409 + `duplicate` when this number/email was asked before,
// unless `force` is set (the dashboard asks first).
router.post("/admin/review-requests", requireAdmin, async (req, res) => {
  try {
    const { value, error } = cleanRequestInput(req.body);
    if (error) return res.status(400).json({ ok: false, error });

    if (!req.body.force) {
      const dup = await findDuplicate(value.contact);
      if (dup) {
        return res.status(409).json({
          ok: false,
          duplicate: { guestName: dup.guestName, createdAt: dup.createdAt, sentBy: dup.sentBy || "" },
          error: "This guest has already been asked."
        });
      }
    }

    const request = await createReviewRequest(value);
    res.json({ ok: true, request: { ...request, link: linkFor(request.id) } });
  } catch (err) {
    console.error("[reviews] create failed:", err);
    res.status(500).json({ ok: false, error: "Could not create the review request" });
  }
});

// POST /api/admin/review-requests/:id/reviewed   body: { reviewed: true|false }
router.post("/admin/review-requests/:id/reviewed", requireAdmin, async (req, res) => {
  try {
    const ref = reviewRequestsCollection.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: "Request not found" });
    const reviewedAt = req.body && req.body.reviewed ? new Date().toISOString() : null;
    await ref.update({ reviewedAt });
    res.json({ ok: true, reviewedAt });
  } catch (err) {
    console.error("[reviews] mark reviewed failed:", err);
    res.status(500).json({ ok: false, error: "Could not update the request" });
  }
});

// POST /api/admin/review-skips   body: { stayKey }  -> hides a stay from the due list
router.post("/admin/review-skips", requireAdmin, async (req, res) => {
  try {
    await skipStay((req.body || {}).stayKey);
    res.json({ ok: true });
  } catch (err) {
    if (err.userFacing) return res.status(400).json({ ok: false, error: err.message });
    console.error("[reviews] skip failed:", err);
    res.status(500).json({ ok: false, error: "Could not skip that stay" });
  }
});

// POST /api/admin/review-settings   body: { googleReviewUrl?, messageTemplate? }
router.post("/admin/review-settings", requireAdmin, async (req, res) => {
  try {
    await saveReviewSettings(req.body || {});
    res.json({ ok: true, settings: await getReviewSettings() });
  } catch (err) {
    if (err.userFacing) return res.status(400).json({ ok: false, error: err.message });
    console.error("[reviews] save settings failed:", err);
    res.status(500).json({ ok: false, error: "Could not save review settings" });
  }
});

// POST /api/review-click/:token — public, called by the /r/ page's own
// JavaScript. Link-preview robots (WhatsApp, email scanners) fetch the
// page but don't run scripts, so they never count as a guest's click.
router.post("/review-click/:token", async (req, res) => {
  try {
    if (/^[\w-]{6,20}$/.test(req.params.token)) await recordClick(req.params.token);
  } catch (err) {
    console.error("[reviews] click failed:", err.message);
  }
  res.json({ ok: true });
});

// GET /r/:token — the link guests receive. Mounted outside /api in
// server.js. An unknown token still forwards to Google: the guest
// wanted to leave a review, a lost record shouldn't stop them.
async function redirectPage(req, res) {
  let url;
  try {
    url = (await getReviewSettings()).googleReviewUrl;
  } catch (err) {
    console.error("[reviews] redirect settings failed:", err.message);
  }
  if (!url || !isAllowedReviewUrl(url)) url = "https://g.page/r/CVSR9OHKczIqEAI/review";
  const token = /^[\w-]{6,20}$/.test(req.params.token) ? req.params.token : "";
  const safeUrl = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

  res.set("Cache-Control", "no-store");
  res.set("X-Robots-Tag", "noindex");
  res.type("html").send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>Review Welverdiend Accommodation</title>
<meta property="og:title" content="Review Welverdiend Accommodation">
<meta property="og:description" content="Thank you for staying with us — tap to leave a quick Google review.">
<meta property="og:image" content="https://welverdiendaccommodation.com/assets/unit2-exterior.jpg">
<style>body{font-family:system-ui,sans-serif;background:#FAF8F3;color:#2B2A26;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px;text-align:center}a{color:#4A4436;font-weight:600}</style>
</head><body>
<div><p>Taking you to Google reviews…</p><p><a href="${safeUrl}">Tap here if nothing happens</a></p></div>
<script>
  (function(){
    var url = ${JSON.stringify(url).replace(/</g, "\\u003c")};
    var go = function(){ location.replace(url); };
    var token = ${JSON.stringify(token)};
    if(!token) return go();
    try{
      fetch("/api/review-click/" + token, { method: "POST", keepalive: true }).then(go, go);
      setTimeout(go, 1500);
    }catch(e){ go(); }
  })();
</script>
</body></html>`);
}

module.exports = router;
module.exports.redirectPage = redirectPage;
