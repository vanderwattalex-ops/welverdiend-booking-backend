// One-off: create the grid thumbnails for gallery photos uploaded before
// thumbnails existed, and mark every site photo as long-cacheable.
// New uploads get both automatically (routes/admin.js), so this only needs
// running once after the deploy that introduced lib/thumbnails.js.
// Safe to re-run: it skips thumbnails that already exist.
//
// Run from backend/ in Cloud Shell (which already has the project's credentials):
//   npm install --omit=dev && node scripts/backfill-thumbnails.js

const { siteAssetsBucket } = require("../lib/db");
const { thumbPath, makeThumbnail, IMMUTABLE } = require("../lib/thumbnails");

// Some steps occasionally never returned when run from Cloud Shell, stalling
// the whole run. Every step now has a time limit and each photo is retried.
function withTimeout(promise, ms, step) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${step} timed out after ${ms / 1000}s`)), ms); })
  ]).finally(() => clearTimeout(timer));
}

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
  async function attempt(file) {
    const t0 = Date.now();
    // The bucket is public, so a plain HTTPS fetch works and can be aborted.
    const url = `https://storage.googleapis.com/${siteAssetsBucket.name}/${file.name}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    const buffer = Buffer.from(await withTimeout(res.arrayBuffer(), 30000, "download"));
    const t1 = Date.now();
    const thumb = await withTimeout(makeThumbnail(buffer), 30000, "resize");
    const t2 = Date.now();
    await withTimeout(siteAssetsBucket.file(thumbPath(file.name)).save(thumb, {
      contentType: "image/webp", metadata: { cacheControl: IMMUTABLE }, resumable: false
    }), 30000, "upload");
    return `download ${t1 - t0}ms, resize ${t2 - t1}ms, upload ${Date.now() - t2}ms`;
  }
  async function one(file) {
    for (let tries = 1; tries <= 3; tries++) {
      try {
        const timing = await attempt(file);
        made++;
        console.log(`thumb ${made + failed}/${todo.length}  ${timing}  ${file.name}`);
        return;
      } catch (err) {
        console.error(`  try ${tries} failed (${err.message})  ${file.name}`);
      }
    }
    failed++;
    console.error("FAILED ", file.name);
  }
  const queue = [...todo];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) await one(queue.shift());
  }));

  // Photo names are uuids and never reused, so browsers can keep them for a year.
  for (const file of [...originals, ...heroFiles.filter(f => /\.jpg$/i.test(f.name))]) {
    if (file.metadata.cacheControl === IMMUTABLE) continue;
    try {
      await withTimeout(file.setMetadata({ cacheControl: IMMUTABLE }), 30000, "cache header");
    } catch (err) {
      console.error("  cache header not set -", err.message, file.name);
    }
  }

  console.log(`\nThumbnails: ${made} made, ${skipped} already there, ${failed} failed.`);
  console.log(`Cache headers set on ${originals.length} gallery and ${heroFiles.length} hero photos.`);
  // Exit explicitly: a step abandoned by a time-out can keep the process alive.
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
