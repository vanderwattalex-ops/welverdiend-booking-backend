const express = require("express");
const router = express.Router();
const { recordPageview } = require("../lib/analytics");

// POST /api/track  body: { page, referrer }
// Fire-and-forget from the browser — never blocks the page, and never
// fails loudly even if something goes wrong internally.
router.post("/track", express.json(), async (req, res) => {
  try {
    const { page, referrer } = req.body || {};
    await recordPageview({ page, referrer });
  } catch (err) {
    console.error("[track] failed:", err.message);
  }
  res.json({ ok: true });
});

module.exports = router;
