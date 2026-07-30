const express = require("express");
const router = express.Router();
const { getSiteContent } = require("../lib/siteContent");

// GET /api/site-content -> used by about.html, unit1.html, unit2.html
router.get("/site-content", async (req, res) => {
  try {
    const content = await getSiteContent();
    res.json({ ok: true, ...content });
  } catch (err) {
    console.error("[site-content] failed:", err);
    res.status(500).json({ ok: false, error: "Could not load site content" });
  }
});

module.exports = router;
