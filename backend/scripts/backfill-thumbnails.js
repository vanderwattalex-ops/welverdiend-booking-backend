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

  const todo = originals.filter(f => !existing.has(thumbPath(f.name)));
  const skipped = originals.length - todo.length;
  console.log(`${todo.length} to make, ${skipped} already there.`);

  // A few at a time -- one by one was very slow from Cloud Shell. Timings
  // per step show where the time goes if it is ever slow again.
  let made = 0, failed = 0;
  async function one(file) {
    const t0 = Date.now();
    try {
      const [buffer] = await file.download({ validation: false });
      const t1 = Date.now();
      await saveThumbnail(siteAssetsBucket, file.name, buffer);
      made++;
      console.log(`thumb ${made + failed}/${todo.length}  download ${t1 - t0}ms, resize+upload ${Date.now() - t1}ms  ${file.name}`);
    } catch (err) {
      failed++;
      console.error("FAILED ", file.name, "-", err.message);
    }
  }
  const queue = [...todo];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) await one(queue.shift());
  }));

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
