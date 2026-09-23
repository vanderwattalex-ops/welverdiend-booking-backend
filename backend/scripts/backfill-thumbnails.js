// One-off: create the grid thumbnails for gallery photos uploaded before
// thumbnails existed, and mark every site photo as long-cacheable.
// New uploads get both automatically (routes/admin.js), so this only needs
// running once after the deploy that introduced lib/thumbnails.js.
// Safe to re-run: it skips thumbnails that already exist.
//
// Run from backend/ in Cloud Shell (which already has the project's credentials):
//   npm install --omit=dev && node scripts/backfill-thumbnails.js

const { siteAssetsBucket } = require("../lib/db");
const { thumbPath, saveThumbnail, IMMUTABLE } = require("../lib/thumbnails");

async function main() {
  const [galleryFiles] = await siteAssetsBucket.getFiles({ prefix: "gallery-photos/" });
  const [heroFiles] = await siteAssetsBucket.getFiles({ prefix: "hero-photos/" });

  const existing = new Set(galleryFiles.map(f => f.name));
  const originals = galleryFiles.filter(f => /\.jpg$/i.test(f.name));

  let made = 0, skipped = 0, failed = 0;
  for (const file of originals) {
    if (existing.has(thumbPath(file.name))) { skipped++; continue; }
    try {
      const [buffer] = await file.download();
      await saveThumbnail(siteAssetsBucket, file.name, buffer);
      made++;
      console.log("thumb  ", file.name);
    } catch (err) {
      failed++;
      console.error("FAILED ", file.name, "-", err.message);
    }
  }

  // Photo names are uuids and never reused, so browsers can keep them for a year.
  for (const file of [...originals, ...heroFiles.filter(f => /\.jpg$/i.test(f.name))]) {
    if (file.metadata.cacheControl === IMMUTABLE) continue;
    await file.setMetadata({ cacheControl: IMMUTABLE });
  }

  console.log(`\nThumbnails: ${made} made, ${skipped} already there, ${failed} failed.`);
  console.log(`Cache headers set on ${originals.length} gallery and ${heroFiles.length} hero photos.`);
  if (failed) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exit(1); });
