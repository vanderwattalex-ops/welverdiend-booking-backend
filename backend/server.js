require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const compression = require("compression");

const app = express();
app.use(cors()); // widget is embedded cross-origin on Squarespace — allow it
app.use(express.json());

// gzip/br for HTML, CSS and JS. Must come before the static handlers so
// it can compress what they serve.
app.use(compression());

// Canonical host: 301 www -> non-www and http -> https.
// Scoped deliberately:
//   - GET only, so POST bodies are never lost to a redirect
//   - /api excluded, because the booking widget and admin dashboard call
//     it cross-origin and a redirect breaks preflight
//   - only the custom domain, so the *.run.app URL keeps working as-is
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api")) return next();
  const host = (req.headers.host || "").toLowerCase();
  if (!host.endsWith("welverdiendaccommodation.com")) return next();
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  if (host === "welverdiendaccommodation.com" && proto === "https") return next();
  return res.redirect(301, "https://welverdiendaccommodation.com" + req.originalUrl);
});

app.use("/assets", express.static(path.join(__dirname, "public"))); // unit photos
app.use(express.static(path.join(__dirname, "site"))); // booking-widget.html, admin-dashboard.html, upload-proof.html

app.get("/", (req, res) => res.json({ ok: true, service: "welverdiend-booking-backend" }));
app.get("/healthz", (req, res) => res.json({ ok: true }));

app.use("/api", require("./routes/config"));
app.use("/api", require("./routes/siteContent"));
app.use("/api", require("./routes/availability"));
app.use("/api", require("./routes/bookings"));
app.use("/api", require("./routes/sync"));
app.use("/api", require("./routes/reminders"));
app.use("/api", require("./routes/track"));
app.use("/api", require("./routes/chatbot"));
app.use("/api", require("./routes/rentInvoices")); // guards each route itself, so order doesn't matter
// admin.js is mounted LAST on purpose — its router-wide requireAdmin
// middleware has no path scoping, so it would silently intercept any
// route mounted after it (this exact bug broke /api/site-content, then
// /api/track and /api/chatbot, on three separate earlier occasions).
// Mounting it last means nothing can ever be shadowed by it again,
// including routes added in the future.
app.use("/api", require("./routes/admin"));
app.use("/", require("./routes/icalExport"));

app.use((err, req, res, next) => {
  console.error("[server] unhandled error:", err.message);
  if (res.headersSent) return next(err);
  res.status(400).json({ ok: false, error: err.message || "Something went wrong processing that request." });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Welverdiend booking backend listening on ${PORT}`));
