const { settingsCollection } = require("./db");
const defaults = require("../config/siteContent");

// Reuses the same Firestore collection as pricing/extras settings, but
// its own document, so "site content" and "business settings" stay
// separate concerns even though they're both admin-editable.
const DOC_ID = "site";

async function getSiteContent() {
  const doc = await settingsCollection.doc(DOC_ID).get();
  const saved = doc.exists ? doc.data() : {};
  return {
    aboutParagraphs: saved.aboutParagraphs || defaults.aboutParagraphs,
    galleries: {
      unit1: (saved.galleries && saved.galleries.unit1) || defaults.galleries.unit1,
      unit2: (saved.galleries && saved.galleries.unit2) || defaults.galleries.unit2
    }
  };
}

async function saveAboutParagraphs(aboutParagraphs) {
  await settingsCollection.doc(DOC_ID).set({ aboutParagraphs }, { merge: true });
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

module.exports = { getSiteContent, saveAboutParagraphs, addGalleryPhoto, removeGalleryPhoto };
