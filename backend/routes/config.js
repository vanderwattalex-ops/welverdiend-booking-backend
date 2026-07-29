const express = require("express");
const router = express.Router();
const { getSettings } = require("../lib/settings");

// GET /api/config -> pricing + extras + bank details, so nothing guest-facing
// hardcodes numbers or details that could drift out of sync with the server.
router.get("/config", async (req, res) => {
  try {
    const { units, extras, bankDetails } = await getSettings();
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
  } catch (err) {
    console.error("[config] failed:", err);
    res.status(500).json({ ok: false, error: "Could not load settings" });
  }
});

module.exports = router;
