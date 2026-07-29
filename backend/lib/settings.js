const { settingsCollection } = require("./db");
const staticConfig = require("../config/units");

const DOC_ID = "general";

/**
 * Returns the live, editable settings: per-unit pricing/description/
 * amenities, the extras catalog, bank details, and the notification
 * email. Anything never saved via the admin Settings tab falls back to
 * the defaults in config/units.js, so this works correctly even before
 * the settings document exists.
 *
 * Deliberately NOT editable here (stay in config/units.js / env vars,
 * since they're wiring rather than day-to-day business info): each
 * unit's iCal source URLs, frontendBaseUrl, the admin token.
 */
async function getSettings() {
  const doc = await settingsCollection.doc(DOC_ID).get();
  const saved = doc.exists ? doc.data() : {};
  const savedUnits = saved.units || [];

  const units = staticConfig.units.map(u => {
    const override = savedUnits.find(su => su.id === u.id) || {};
    return {
      ...u, // keeps id, name, sources (iCal URLs) from the static config
      pricePerNight: override.pricePerNight ?? u.pricePerNight,
      description: override.description ?? u.description,
      bedrooms: override.bedrooms ?? u.bedrooms,
      beds: override.beds ?? u.beds,
      bathrooms: override.bathrooms ?? u.bathrooms,
      sleeps: override.sleeps ?? u.sleeps,
      amenities: override.amenities ?? u.amenities,
      photo: override.photo ?? u.photo
    };
  });

  return {
    units,
    extras: saved.extras || staticConfig.extras,
    bankDetails: saved.bankDetails || staticConfig.bankDetails,
    ownerNotificationEmail: saved.ownerNotificationEmail || staticConfig.ownerNotificationEmail,
    frontendBaseUrl: staticConfig.frontendBaseUrl
  };
}

/**
 * Saves editable settings. `units` here only needs id + the editable
 * fields (pricePerNight, description, beds, bathrooms, amenities,
 * photo) — id is used to match back up with the static unit list.
 */
async function saveSettings({ units, extras, bankDetails, ownerNotificationEmail }) {
  const payload = {};
  if (units) payload.units = units;
  if (extras) payload.extras = extras;
  if (bankDetails !== undefined) payload.bankDetails = bankDetails;
  if (ownerNotificationEmail !== undefined) payload.ownerNotificationEmail = ownerNotificationEmail;
  payload.updatedAt = new Date().toISOString();
  await settingsCollection.doc(DOC_ID).set(payload, { merge: true });
}

module.exports = { getSettings, saveSettings };
