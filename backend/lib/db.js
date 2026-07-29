const { Firestore } = require("@google-cloud/firestore");
const { Storage } = require("@google-cloud/storage");

// On Cloud Run, both clients pick up credentials automatically from the
// service's attached identity — no key file needed.
const firestore = new Firestore();
const storage = new Storage();

const BUCKET_NAME = process.env.PROOF_OF_PAYMENT_BUCKET || "welverdiend-proof-of-payment";
const bucket = storage.bucket(BUCKET_NAME);

const availabilityCollection = firestore.collection("availability");
const bookingsCollection = firestore.collection("bookings");
const overridesCollection = firestore.collection("overrides");
const settingsCollection = firestore.collection("settings");

module.exports = {
  firestore,
  storage,
  bucket,
  availabilityCollection,
  bookingsCollection,
  overridesCollection,
  settingsCollection
};
