const express = require("express");
const router = express.Router();
const { bookingsCollection } = require("../lib/db");
const { buildUnitExport } = require("../lib/icalExport");
const { units } = require("../config/units");

// GET /ical/unit1.ics  /ical/unit2.ics
// Paste this URL into Airbnb / Booking.com / Lekkeslaap as an "import
// calendar" source. Treat the URL as semi-private: it exposes booked date
// ranges only, no guest details, but there's no need to publish it.
router.get("/ical/:unitFile", async (req, res) => {
  const unitId = req.params.unitFile.replace(/\.ics$/, "");
  const unit = units.find(u => u.id === unitId);
  if (!unit) return res.status(404).send("Unknown unit");

  try {
    // Every status that holds the dates here — the same list
    // lib/availabilitySync.js blocks our own calendar with — not just
    // "confirmed". Otherwise a booking waiting on its deposit is blocked
    // on this site but still bookable on Airbnb/Booking.com/Lekkeslaap.
    // A website hold that isn't paid within 24h turns "expired"
    // (routes/reminders.js) and drops out of this feed, so the platforms
    // reopen the dates on their next fetch. Manual bookings never expire:
    // they stay here until the owner cancels them.
    const snap = await bookingsCollection
      .where("unitId", "==", unitId)
      .where("status", "in", ["awaiting_payment", "submitted", "confirmed"])
      .get();
    const holding = snap.docs.map(d => d.data());
    const ics = buildUnitExport(unit.name, holding);
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.send(ics);
  } catch (err) {
    console.error("[icalExport] failed:", err);
    res.status(500).send("Could not build calendar");
  }
});

module.exports = router;
