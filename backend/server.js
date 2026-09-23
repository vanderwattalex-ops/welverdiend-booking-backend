require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const compression = require("compression");
const { prerender, handles } = require("./lib/prerender");

const app = express();
app.disable("x-powered-by"); // don't advertise the framework
app.use(cors()); // widget is embedded cross-origin on Squarespace — allow it
app.use(express.json());

// gzip/br for HTML, CSS and JS. Must come before the static handlers so
// it can compress what they serve.
app.use(compression());

// Baseline security headers. HSTS only on the custom domain: the run.app URL
// is Google's and not ours to pin. No frame restrictions -- the booking
// widget may still be embedded on other sites.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if ((req.headers.host || "").toLowerCase() === "welverdiendaccommodation.com") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }
  next();
});

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


// llms.txt, the live sitemap, icons, IndexNow key (see routes/seo.js).
app.use(require("./routes/seo"));

// Serve the site pages with their content already in the HTML. Crawlers that
// do not run JavaScript -- Bing at times, and most AI crawlers -- otherwise
// receive a page whose body just says "Loading...". Falls through to the
// static file on any failure, which is the previous behaviour exactly.
// Mounted before express.static so it wins for these paths.
app.get(["/", "/:page.html"], async (req, res, next) => {
  const page = req.path === "/" ? "index.html" : req.path.slice(1);
  if (!handles(page)) return next();
  const html = await prerender(path.join(__dirname, "site", page), page);
  if (!html) return next();
  res.type("html").send(html);
});

// Browser caching. Without it every page view re-downloaded the logos, badge
// and stylesheet (max-age=0). File names here aren't versioned, so lifetimes
// are kept modest: images a week, CSS/JS an hour -- long enough to cover a
// browsing session, short enough that a deploy shows up the same day.
// HTML is left at the default (always revalidated via ETag).
function cacheFor(res, filePath) {
  if (/\.(png|jpe?g|webp|svg|ico)$/i.test(filePath)) res.setHeader("Cache-Control", "public, max-age=604800");
  else if (/\.(css|js)$/i.test(filePath)) res.setHeader("Cache-Control", "public, max-age=3600");
}
app.use("/assets", express.static(path.join(__dirname, "public"), { setHeaders: cacheFor })); // unit photos
app.use(express.static(path.join(__dirname, "site"), { setHeaders: cacheFor })); // booking-widget.html, admin-dashboard.html, upload-proof.html

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

// Nothing matched: a real page for people, JSON for API callers.
app.use((req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ ok: false, error: "Not found" });
  res.status(404).sendFile(path.join(__dirname, "site", "404.html"));
});

app.use((err, req, res, next) => {
  console.error("[server] unhandled error:", err.message);
  if (res.headersSent) return next(err);
  res.status(400).json({ ok: false, error: err.message || "Something went wrong processing that request." });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Welverdiend booking backend listening on ${PORT}`));
