const assert = require("node:assert/strict");
const test = require("node:test");
const {
  cleanupExpiredMedia,
  deleteInBatches,
  isTemporaryMedia,
  scanExpiredMedia,
  RETENTION_HOURS,
} = require("./blob-cleanup");

const NOW = Date.parse("2026-09-16T12:00:00Z");
const HOUR_MS = 3600000;

function blob(pathname, ageHours, size = 100) {
  return {
    pathname,
    url: `https://example.public.blob.vercel-storage.com/${pathname}`,
    uploadedAt: new Date(NOW - ageHours * HOUR_MS),
    size,
  };
}

test("recognizes SDK list media records without contentType", () => {
  for (const pathname of ["uploads/recording.m4a", "uploads/VIDEO.MP4", "legacy-audio.mp3", "cloud-smoke/test.wav", "uploads/phone.3gp"]) {
    assert.equal(isTemporaryMedia({ pathname }), true, pathname);
  }
});

test("protects job records, outputs and unrelated files", () => {
  for (const pathname of ["jobs/job_123/work.json", "jobs/job_123/result.json", "jobs/job_123/media.m4a", "outputs/result.txt", "other/recording.mp3", "uploads/metadata.json"]) {
    assert.equal(isTemporaryMedia({ pathname }), false, pathname);
  }
});

test("uses a 48-hour media retention policy", () => {
  assert.equal(RETENTION_HOURS, 48);
});

test("expires media older than 48 hours across pages and protects the boundary", async () => {
  const oldMedia = blob("uploads/seven-days-old.m4a", 168, 200);
  const legacyMedia = blob("legacy.mp3", 144, 300);
  const justExpired = blob("uploads/just-over-48-hours.m4a", 48 + 1 / 60, 150);
  const requests = [];
  const pages = [
    { blobs: [oldMedia, blob("uploads/recent.m4a", 24), blob("uploads/exactly-48-hours.mp4", 48), justExpired], hasMore: true, cursor: "next" },
    { blobs: [legacyMedia, blob("jobs/job_123/result.json", 200), { ...blob("uploads/unknown-date.wav", 100), uploadedAt: "invalid" }], hasMore: false },
  ];
  const scan = await scanExpiredMedia(NOW, async (options) => {
    requests.push(options);
    return pages.shift();
  });
  assert.deepEqual(scan.expired, [oldMedia.url, justExpired.url, legacyMedia.url]);
  assert.equal(scan.scanned, 7);
  assert.equal(scan.expiredBytes, 650);
  assert.equal(requests[1].cursor, "next");
});

test("deletes in bounded batches and avoids empty deletes", async () => {
  const batches = [];
  const deleteBlobs = async (urls) => batches.push(urls);
  await deleteInBatches([], deleteBlobs);
  assert.equal(batches.length, 0);
  await deleteInBatches(Array.from({ length: 205 }, (_, index) => `url-${index}`), deleteBlobs);
  assert.deepEqual(batches.map((batch) => batch.length), [100, 100, 5]);
});

test("opportunistic cleanup deletes only expired media and reports the result", async () => {
  const removed = [];
  const summary = await cleanupExpiredMedia({
    now: NOW,
    listBlobs: async () => ({
      blobs: [
        blob("uploads/old.m4a", 168, 250),
        blob("uploads/recent.m4a", 24, 100),
        blob("jobs/job_123/result.json", 168, 500),
      ],
      hasMore: false,
    }),
    deleteBlobs: async (urls) => removed.push(...urls),
  });
  assert.equal(summary.scanned, 3);
  assert.equal(summary.eligible, 1);
  assert.equal(summary.deleted, 1);
  assert.equal(summary.deleted_bytes, 250);
  assert.equal(summary.retention_hours, 48);
  assert.deepEqual(removed, ["https://example.public.blob.vercel-storage.com/uploads/old.m4a"]);
});
