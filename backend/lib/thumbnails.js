// ---------------------------------------------------------------------------
// GALLERY THUMBNAILS
// ---------------------------------------------------------------------------
// The gallery grids show each photo as a ~260-400px tile, but used to load
// the full 1600px upload (up to ~730KB each) -- Unit 1's page alone pulled
// ~16MB of photos. Each gallery upload now also gets a small WebP copy stored
// next to it, named by convention so no Firestore change is needed:
//
//   gallery-photos/unit1/<uuid>.jpg        full size, used by the lightbox
//   gallery-photos/unit1/<uuid>-thumb.webp the grid tile
//
// Pages put the thumbnail in src and the full URL in data-full, with an
// onerror that swaps to the full photo -- so a missing thumbnail (e.g. an
// older photo before the backfill ran) degrades to the old behaviour rather
// than a broken image.
//
// The few Unit 2 photos still on Squarespace's CDN are resized by Squarespace
// itself via its ?format= parameter.
// ---------------------------------------------------------------------------

const THUMB_WIDTH = 800; // 2x a typical tile, so it stays sharp on phones
const IMMUTABLE = "public, max-age=31536000, immutable"; // names are uuids, never reused

function thumbPath(objectPath) {
  return objectPath.replace(/\.jpg$/i, "-thumb.webp");
}

function thumbUrl(url) {
  if (typeof url !== "string") return url;
  if (/^https:\/\/storage\.googleapis\.com\/[^/]+\/gallery-photos\/.+\.jpg$/i.test(url)) {
    return thumbPath(url);
  }
  if (url.startsWith("https://images.squarespace-cdn.com/")) {
    return url.split("?")[0] + "?format=750w";
  }
  return url;
}

async function makeThumbnail(buffer) {
  const sharp = require("sharp"); // required lazily so thumbUrl() stays usable without it
  return sharp(buffer)
    .rotate()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: 72 })
    .toBuffer();
}

async function saveThumbnail(bucket, objectPath, buffer) {
  const thumb = await makeThumbnail(buffer);
  await bucket.file(thumbPath(objectPath)).save(thumb, {
    contentType: "image/webp",
    metadata: { cacheControl: IMMUTABLE },
    resumable: false // tiny file: one request instead of a resumable-session handshake
  });
}

module.exports = { thumbUrl, thumbPath, makeThumbnail, saveThumbnail, IMMUTABLE };
