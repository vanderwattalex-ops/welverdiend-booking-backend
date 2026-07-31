require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors()); // widget is embedded cross-origin on Squarespace — allow it
app.use(express.json());
app.use("/assets", express.static(path.join(__dirname, "public"))); // unit photos
app.use(express.static(path.join(__dirname, "site"))); // booking-widget.html, admin-dashboard.html, upload-proof.html

app.get("/", (req, res) => res.json({ ok: true, service: "welverdiend-booking-backend" }));
app.get("/healthz", (req, res) => res.json({ ok: true }));

app.use("/api", require("./routes/config"));
app.use("/api", require("./routes/siteContent"));
app.use("/api", require("./routes/availability"));
app.use("/api", require("./routes/bookings"));
app.use("/api", require("./routes/track"));
app.use("/api", require("./routes/chatbot"));
app.use("/api", require("./routes/admin"));
app.use("/api", require("./routes/sync"));
app.use("/api", require("./routes/reminders"));
app.use("/", require("./routes/icalExport"));

// Catch-all error handler — without this, an error thrown by middleware
// (like a rejected file upload) falls through to Express's default HTML
// error page, which breaks every frontend fetch() call expecting JSON
// and shows a misleading "could not reach the server" message instead
// of the real reason.
app.use((err, req, res, next) => {
  console.error("[server] unhandled error:", err.message);
  if (res.headersSent) return next(err);
  res.status(400).json({ ok: false, error: err.message || "Something went wrong processing that request." });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Welverdiend booking backend listening on ${PORT}`));
