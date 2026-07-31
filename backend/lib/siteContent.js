const { settingsCollection } = require("./db");
const defaults = require("../config/siteContent");
const { v4: uuidv4 } = require("uuid");

// Reuses the same Firestore collection as pricing/extras settings, but
// its own document, so "site content" and "business settings" stay
// separate concerns even though they're both admin-editable.
const DOC_ID = "site";

const GALLERY_IDS = ["unit1", "unit2", "wildlife"];
// Unit 1 and Unit 2 galleries are organized into sections (Bedroom 1,
// Kitchen, etc). Wildlife stays a simple flat list — sections wouldn't
// add anything there.
const SECTIONED_GALLERY_IDS = ["unit1", "unit2"];
const DEFAULT_SECTION = "Other";

/**
 * Older photo entries were plain URL strings. This converts any of
 * those into the new {id, url, section} object shape, tagging them
 * "Other" so nothing is lost — the admin can then move each into the
 * right section afterward. Returns { photos, changed } so the caller
 * only writes back to Firestore when a conversion actually happened.
 */
function migratePhotos(list) {
  let changed = false;
  const photos = (list || []).map(p => {
    if (typeof p === "string") {
      changed = true;
      return { id: uuidv4(), url: p, section: DEFAULT_SECTION };
    }
    return p;
  });
  return { photos, changed };
}

async function getSiteContent() {
  const doc = await settingsCollection.doc(DOC_ID).get();
  const saved = doc.exists ? doc.data() : {};

  const galleries = {};
  let needsMigrationWrite = false;
  GALLERY_IDS.forEach(id => {
    const raw = (saved.galleries && saved.galleries[id]) || defaults.galleries[id] || [];
    if (SECTIONED_GALLERY_IDS.includes(id)) {
      const { photos, changed } = migratePhotos(raw);
      galleries[id] = photos;
      if (changed) needsMigrationWrite = true;
    } else {
      galleries[id] = raw; // wildlife — stays flat strings
    }
  });

  if (needsMigrationWrite) {
    await settingsCollection.doc(DOC_ID).set({ galleries }, { merge: true });
  }

  const gallerySections = {};
  SECTIONED_GALLERY_IDS.forEach(id => {
    gallerySections[id] = (saved.gallerySections && saved.gallerySections[id]) || defaults.gallerySections[id];
  });

  return {
    aboutParagraphs: saved.aboutParagraphs || defaults.aboutParagraphs,
    heroPhotos: {
      homeTop: (saved.heroPhotos && saved.heroPhotos.homeTop) || defaults.heroPhotos.homeTop,
      homeSecond: (saved.heroPhotos && saved.heroPhotos.homeSecond) || defaults.heroPhotos.homeSecond,
      aboutPhoto: (saved.heroPhotos && saved.heroPhotos.aboutPhoto) || defaults.heroPhotos.aboutPhoto
    },
    reviews: saved.reviews || defaults.reviews,
    faqs: saved.faqs || defaults.faqs,
    recommendations: saved.recommendations || defaults.recommendations,
    galleries,
    gallerySections
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

async function addGalleryPhoto(unitId, url, section) {
  const current = await getSiteContent();
  const entry = SECTIONED_GALLERY_IDS.includes(unitId)
    ? { id: uuidv4(), url, section: section || DEFAULT_SECTION }
    : url; // wildlife stays a plain string
  const updated = [...current.galleries[unitId], entry];
  const galleries = { ...current.galleries, [unitId]: updated };
  await settingsCollection.doc(DOC_ID).set({ galleries }, { merge: true });
  return updated;
}

/**
 * Removes a photo. `identifier` is a photo id for sectioned galleries
 * (unit1/unit2) or the raw url string for wildlife.
 */
async function removeGalleryPhoto(unitId, identifier) {
  const current = await getSiteContent();
  const updated = SECTIONED_GALLERY_IDS.includes(unitId)
    ? current.galleries[unitId].filter(p => p.id !== identifier)
    : current.galleries[unitId].filter(u => u !== identifier);
  const galleries = { ...current.galleries, [unitId]: updated };
  await settingsCollection.doc(DOC_ID).set({ galleries }, { merge: true });
  return updated;
}

/**
 * Moves a photo one step earlier/later among the OTHER photos in the
 * same section — so "move this photo up" reorders it within its own
 * section's visual group, not the whole unsorted list.
 */
async function movePhoto(unitId, photoId, direction) {
  const current = await getSiteContent();
  const photos = [...current.galleries[unitId]];
  const idx = photos.findIndex(p => p.id === photoId);
  if (idx === -1) return photos;
  const section = photos[idx].section;

  let swapIdx = -1;
  if (direction === "up") {
    for (let i = idx - 1; i >= 0; i--) {
      if (photos[i].section === section) { swapIdx = i; break; }
    }
  } else {
    for (let i = idx + 1; i < photos.length; i++) {
      if (photos[i].section === section) { swapIdx = i; break; }
    }
  }
  if (swapIdx !== -1) {
    [photos[idx], photos[swapIdx]] = [photos[swapIdx], photos[idx]];
  }

  const galleries = { ...current.galleries, [unitId]: photos };
  await settingsCollection.doc(DOC_ID).set({ galleries }, { merge: true });
  return photos;
}

async function setPhotoSection(unitId, photoId, section) {
  const current = await getSiteContent();
  const photos = current.galleries[unitId].map(p => p.id === photoId ? { ...p, section } : p);
  const galleries = { ...current.galleries, [unitId]: photos };
  await settingsCollection.doc(DOC_ID).set({ galleries }, { merge: true });
  return photos;
}

async function addGallerySection(unitId, name) {
  const current = await getSiteContent();
  const sections = current.gallerySections[unitId] || [];
  if (sections.includes(name)) return sections;
  const updated = [...sections, name];
  const gallerySections = { ...current.gallerySections, [unitId]: updated };
  await settingsCollection.doc(DOC_ID).set({ gallerySections }, { merge: true });
  return updated;
}

async function renameGallerySection(unitId, oldName, newName) {
  const current = await getSiteContent();
  const sections = (current.gallerySections[unitId] || []).map(s => s === oldName ? newName : s);
  const gallerySections = { ...current.gallerySections, [unitId]: sections };
  // Re-tag any photos currently in the renamed section so they follow it.
  const photos = current.galleries[unitId].map(p => p.section === oldName ? { ...p, section: newName } : p);
  const galleries = { ...current.galleries, [unitId]: photos };
  await settingsCollection.doc(DOC_ID).set({ gallerySections, galleries }, { merge: true });
  return { sections, photos };
}

async function removeGallerySection(unitId, name) {
  const current = await getSiteContent();
  const sections = (current.gallerySections[unitId] || []).filter(s => s !== name);
  const gallerySections = { ...current.gallerySections, [unitId]: sections };
  // Photos in the removed section fall back to "Other" rather than disappearing.
  const photos = current.galleries[unitId].map(p => p.section === name ? { ...p, section: DEFAULT_SECTION } : p);
  const galleries = { ...current.galleries, [unitId]: photos };
  await settingsCollection.doc(DOC_ID).set({ gallerySections, galleries }, { merge: true });
  return { sections, photos };
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

async function addFaq({ question, answer }) {
  const current = await getSiteContent();
  const faq = { id: uuidv4(), question, answer };
  const faqs = [...current.faqs, faq];
  await settingsCollection.doc(DOC_ID).set({ faqs }, { merge: true });
  return faqs;
}

async function removeFaq(id) {
  const current = await getSiteContent();
  const faqs = current.faqs.filter(f => f.id !== id);
  await settingsCollection.doc(DOC_ID).set({ faqs }, { merge: true });
  return faqs;
}

async function addRecommendation({ name, category, description, mapLink, distance }) {
  const current = await getSiteContent();
  const rec = { id: uuidv4(), name, category: category || "", description: description || "", mapLink: mapLink || "", distance: distance || "" };
  const recommendations = [...current.recommendations, rec];
  await settingsCollection.doc(DOC_ID).set({ recommendations }, { merge: true });
  return recommendations;
}

async function removeRecommendation(id) {
  const current = await getSiteContent();
  const recommendations = current.recommendations.filter(r => r.id !== id);
  await settingsCollection.doc(DOC_ID).set({ recommendations }, { merge: true });
  return recommendations;
}

module.exports = {
  GALLERY_IDS, SECTIONED_GALLERY_IDS,
  getSiteContent, saveAboutParagraphs, setHeroPhoto,
  addGalleryPhoto, removeGalleryPhoto, movePhoto, setPhotoSection,
  addGallerySection, renameGallerySection, removeGallerySection,
  addReview, removeReview,
  addFaq, removeFaq, addRecommendation, removeRecommendation
};
