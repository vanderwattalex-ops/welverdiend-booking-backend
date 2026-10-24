const express = require("express");
const router = express.Router();
const { getSettings } = require("../lib/settings");
const { runningSpecials, bestDiscount } = require("../lib/promotions");

// GET /api/config -> pricing + extras + bank details, so nothing guest-facing
// hardcodes numbers or details that could drift out of sync with the server.
router.get("/config", async (req, res) => {
  try {
    const { units, extras, bankDetails, promotions } = await getSettings();
    res.json({
      ok: true,
      units: units.map(u => ({
        id: u.id,
        name: u.name,
        pricePerNight: u.pricePerNight,
        description: u.description,
        bedrooms: u.bedrooms,
        beds: u.beds,
        bathrooms: u.bathrooms,
        sleeps: u.sleeps,
        amenities: u.amenities,
        photo: u.photo
      })),
      extras,
      bankDetails,
      // only what guests may see: the long-stay steps and specials still running
      promotions: {
        longStay: promotions.longStay,
        specials: runningSpecials(promotions).map(({ id, name, percent, minNights, units, stayFrom, stayTo, bookBy, reason }) =>
          ({ id, name, percent, minNights, units, stayFrom, stayTo, bookBy, reason }))
      }
    });
  } catch (err) {
    console.error("[config] failed:", err);
    res.status(500).json({ ok: false, error: "Could not load settings" });
  }
});

// GET /api/quote?unit=unit2&checkIn=2026-11-03&checkOut=2026-11-08
// The automatic discount a direct booking for these dates gets (or none),
// worked out by the same code that prices the booking request.
router.get("/quote", async (req, res) => {
  try {
    const { unit: unitId, checkIn, checkOut } = req.query;
    const { units, promotions } = await getSettings();
    const unit = units.find(u => u.id === unitId);
    if (!unit || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn || "") || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut || "") || checkIn >= checkOut) {
      return res.status(400).json({ ok: false, error: "unit, checkIn and checkOut are required" });
    }
    const nights = Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
    const promo = bestDiscount({ unitId, checkIn, nights, rate: unit.pricePerNight, promotions });
    res.json({ ok: true, nights, rate: unit.pricePerNight, discount: promo });
  } catch (err) {
    console.error("[quote] failed:", err);
    res.status(500).json({ ok: false, error: "Could not work out the price" });
  }
});

module.exports = router;
