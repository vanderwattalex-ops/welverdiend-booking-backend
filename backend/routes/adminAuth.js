function requireAdmin(req, res, next) {
  const token = req.header("x-admin-token");
  if (!process.env.ADMIN_TOKEN) {
    console.warn("[adminAuth] ADMIN_TOKEN is not set — refusing all admin requests.");
    return res.status(500).json({ ok: false, error: "Server not configured" });
  }
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

module.exports = { requireAdmin };
