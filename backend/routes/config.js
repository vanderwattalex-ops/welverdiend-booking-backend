const express = require("express");
const router = express.Router();
const { units, extras } = require("../config/units");

// GET /api/config -> pricing + extras, so the widget never hardcodes
// numbers that could drift out of sync with what the server charges.
router.get("/config", (req, res) => {
  res.json({
    ok: true,
    units: units.map(u => ({
      id: u.id,
      name: u.name,
      pricePerNight: u.pricePerNight,
      description: u.description,
      beds: u.beds,
      bathrooms: u.bathrooms,
      amenities: u.amenities,
      photo: u.photo
    })),
    extras
  });
});

module.exports = router;
