const express = require("express");
const router = express.Router();
const { askChatbot } = require("../lib/chatbot");

// POST /api/chatbot   body: { message, history: [{role:'user'|'bot', text}] }
router.post("/chatbot", express.json(), async (req, res) => {
  try {
    const { message, history } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ ok: false, error: "Please type a question." });
    }
    const result = await askChatbot(message, history);
    res.json(result);
  } catch (err) {
    console.error("[chatbot route] failed:", err.message);
    res.status(500).json({ ok: false, error: "Something went wrong — please try again." });
  }
});

module.exports = router;
