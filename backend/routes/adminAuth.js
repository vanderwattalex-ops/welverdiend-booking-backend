const crypto = require("crypto");

// Wrong-token protection: after MAX_FAILURES wrong admin tokens from one
// connection within WINDOW_MS, that connection is refused for BLOCK_MS, so
// the token can't be guessed by trying thousands of values. A correct token
// clears the count. Kept in memory per server instance (Cloud Run may run a
// few), which is plenty to make guessing hopeless.
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;
const failures = new Map(); // ip -> { count, first, blockedUntil }

// Cloud Run's front end appends the real client address as the LAST entry
// of X-Forwarded-For; anything before it was sent by the client and can be
// made up, so only the last entry is trusted.
function clientIp(req) {
  const parts = String(req.headers["x-forwarded-for"] || "").split(",").map(s => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : (req.socket && req.socket.remoteAddress) || "unknown";
}

function tokensMatch(given, expected) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  const token = req.header("x-admin-token");
  if (!process.env.ADMIN_TOKEN) {
    console.warn("[adminAuth] ADMIN_TOKEN is not set — refusing all admin requests.");
    return res.status(500).json({ ok: false, error: "Server not configured" });
  }

  const ip = clientIp(req);
  const now = Date.now();
  const rec = failures.get(ip);
  if (rec && rec.blockedUntil > now) {
    const minutes = Math.ceil((rec.blockedUntil - now) / 60000);
    return res.status(429).json({ ok: false, error: `Too many wrong admin tokens from this connection. Wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.` });
  }

  if (!tokensMatch(token, process.env.ADMIN_TOKEN)) {
    const fresh = !rec || now - rec.first > WINDOW_MS;
    const next = fresh ? { count: 1, first: now, blockedUntil: 0 } : { ...rec, count: rec.count + 1 };
    if (next.count >= MAX_FAILURES) {
      next.blockedUntil = now + BLOCK_MS;
      console.warn(`[adminAuth] ${MAX_FAILURES} wrong admin tokens from ${ip} — blocked for ${BLOCK_MS / 60000} minutes.`);
    }
    failures.set(ip, next);
    if (failures.size > 5000) { // keep memory bounded
      for (const [k, v] of failures) if (v.blockedUntil < now && now - v.first > WINDOW_MS) failures.delete(k);
    }
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  if (rec) failures.delete(ip);
  next();
}

module.exports = { requireAdmin };
