const { Firestore } = require("@google-cloud/firestore");
const { Storage } = require("@google-cloud/storage");

// On Cloud Run, both clients pick up credentials automatically from the
// service's attached identity — no key file needed.
const firestore = new Firestore();
const storage = new Storage();

const BUCKET_NAME = process.env.PROOF_OF_PAYMENT_BUCKET || "welverdiend-proof-of-payment";
const bucket = storage.bucket(BUCKET_NAME);

// A SEPARATE, publicly-readable bucket for marketing site photos (About/
// gallery images) — kept apart from the private proof-of-payment bucket
// on purpose, since these images need to load directly and fast for
// site visitors, with no admin token or backend round-trip involved.
const SITE_ASSETS_BUCKET_NAME = process.env.SITE_ASSETS_BUCKET || "welverdiend-site-assets";
const siteAssetsBucket = storage.bucket(SITE_ASSETS_BUCKET_NAME);

const availabilityCollection = firestore.collection("availability");
const bookingsCollection = firestore.collection("bookings");
const overridesCollection = firestore.collection("overrides");
const settingsCollection = firestore.collection("settings");

module.exports = {
  firestore,
  storage,
  bucket,
  siteAssetsBucket,
  availabilityCollection,
  bookingsCollection,
  overridesCollection,
  settingsCollection
};
