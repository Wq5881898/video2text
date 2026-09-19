const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createHandler,
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

function response() {
  return {
    setHeader() {},
    status(code) { this.code = code; return this; },
    json(payload) { this.payload = payload; },
  };
}

test("handler requires authorization and dry-run never deletes", async () => {
  const previousSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "test-cron-secret";
  let listCalls = 0;
  let deleteCalls = 0;
  const handler = createHandler({
    listBlobs: async () => {
      listCalls += 1;
      return { blobs: [{ ...blob("uploads/old.m4a", 168, 250), uploadedAt: new Date(0) }], hasMore: false };
    },
    deleteBlobs: async () => { deleteCalls += 1; },
  });
  try {
    const unauthorized = response();
    await handler({ method: "GET", headers: {}, query: {} }, unauthorized);
    assert.equal(unauthorized.code, 401);
    assert.equal(listCalls, 0);

    const preview = response();
    await handler({ method: "GET", headers: { authorization: "Bearer test-cron-secret" }, query: { dry_run: "1" } }, preview);
    assert.equal(preview.code, 200);
    assert.equal(preview.payload.eligible, 1);
    assert.equal(preview.payload.eligible_bytes, 250);
    assert.equal(preview.payload.deleted, 0);
    assert.equal(preview.payload.retention_hours, 48);
    assert.equal(deleteCalls, 0);

    const cleanup = response();
    await handler({ method: "GET", headers: { authorization: "Bearer test-cron-secret" }, query: {} }, cleanup);
    assert.equal(cleanup.code, 200);
    assert.equal(cleanup.payload.deleted, 1);
    assert.equal(cleanup.payload.deleted_bytes, 250);
    assert.equal(cleanup.payload.retention_hours, 48);
    assert.equal(deleteCalls, 1);
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  }
});
