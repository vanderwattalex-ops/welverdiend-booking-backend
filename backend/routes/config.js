const express = require("express");
const router = express.Router();
const { units, extras, bankDetails } = require("../config/units");

// GET /api/config -> pricing + extras + bank details, so nothing guest-facing
// hardcodes numbers or details that could drift out of sync with the server.
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
    extras,
    bankDetails
  });
});

module.exports = router;
