const { settingsCollection } = require("./db");
const defaults = require("../config/siteContent");
const { v4: uuidv4 } = require("uuid");

// Reuses the same Firestore collection as pricing/extras settings, but
// its own document, so "site content" and "business settings" stay
// separate concerns even though they're both admin-editable.
const DOC_ID = "site";

const GALLERY_IDS = ["unit1", "unit2", "wildlife"];

async function getSiteContent() {
  const doc = await settingsCollection.doc(DOC_ID).get();
  const saved = doc.exists ? doc.data() : {};
  const galleries = {};
  GALLERY_IDS.forEach(id => {
    galleries[id] = (saved.galleries && saved.galleries[id]) || defaults.galleries[id] || [];
  });
  return {
    aboutParagraphs: saved.aboutParagraphs || defaults.aboutParagraphs,
    heroPhotos: {
      homeTop: (saved.heroPhotos && saved.heroPhotos.homeTop) || defaults.heroPhotos.homeTop,
      homeSecond: (saved.heroPhotos && saved.heroPhotos.homeSecond) || defaults.heroPhotos.homeSecond,
      aboutPhoto: (saved.heroPhotos && saved.heroPhotos.aboutPhoto) || defaults.heroPhotos.aboutPhoto
    },
    reviews: saved.reviews || defaults.reviews,
    galleries
  };
}

async function saveAboutParagraphs(aboutParagraphs) {
  await settingsCollection.doc(DOC_ID).set({ aboutParagraphs }, { merge: true });
}

async function setHeroPhoto(slot, url) {
  const current = await getSiteContent();
  const heroPhotos = { ...current.heroPhotos, [slot]: url };
  await settingsCollection.doc(DOC_ID).set({ heroPhotos }, { merge: true });
  return heroPhotos;
}

async function addGalleryPhoto(unitId, url) {
  const current = await getSiteContent();
  const updated = [...current.galleries[unitId], url];
  const galleries = { ...current.galleries, [unitId]: updated };
  await settingsCollection.doc(DOC_ID).set({ galleries }, { merge: true });
  return updated;
}

async function removeGalleryPhoto(unitId, url) {
  const current = await getSiteContent();
  const updated = current.galleries[unitId].filter(u => u !== url);
  const galleries = { ...current.galleries, [unitId]: updated };
  await settingsCollection.doc(DOC_ID).set({ galleries }, { merge: true });
  return updated;
}

async function addReview({ name, rating, text }) {
  const current = await getSiteContent();
  const review = { id: uuidv4(), name, rating: Math.max(1, Math.min(5, Number(rating) || 5)), text, createdAt: new Date().toISOString() };
  const reviews = [review, ...current.reviews];
  await settingsCollection.doc(DOC_ID).set({ reviews }, { merge: true });
  return reviews;
}

async function removeReview(id) {
  const current = await getSiteContent();
  const reviews = current.reviews.filter(r => r.id !== id);
  await settingsCollection.doc(DOC_ID).set({ reviews }, { merge: true });
  return reviews;
}

module.exports = {
  GALLERY_IDS,
  getSiteContent, saveAboutParagraphs, setHeroPhoto,
  addGalleryPhoto, removeGalleryPhoto, addReview, removeReview
};
