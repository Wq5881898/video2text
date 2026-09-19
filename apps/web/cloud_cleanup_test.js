const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { list } = require("@vercel/blob");
const { deleteInBatches, scanExpiredMedia, RETENTION_HOURS } = require("./api/blob-cleanup");

const EXPECTED_HOST = "si4slzwkn8wdmagr.public.blob.vercel-storage.com";

async function snapshot() {
  const blobs = [];
  let cursor;
  do {
    const page = await list({ cursor, limit: 1000 });
    for (const blob of page.blobs) {
      assert.equal(new URL(blob.url).hostname, EXPECTED_HOST, "Unexpected Blob store: refusing deletion");
      blobs.push(blob);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

function bytes(blobs) {
  return blobs.reduce((total, blob) => total + blob.size, 0);
}

async function candidates(blobs, now) {
  return scanExpiredMedia(now, async () => ({ blobs, hasMore: false }));
}

async function run() {
  const args = process.argv.slice(2);
  assert(args.includes("--execute"), "Use --execute to authorize actual expired-media deletion");
  const reportIndex = args.indexOf("--report");
  const reportPath = reportIndex < 0 ? null : args[reportIndex + 1];
  if (reportIndex >= 0) assert(reportPath, "--report requires a file path");

  const now = Date.now();
  const before = await snapshot();
  const expired = await candidates(before, now);
  const selected = new Set(expired.expired);
  const preserved = before.filter((blob) => !selected.has(blob.url));
  const preservedJobs = preserved.filter((blob) => blob.pathname.startsWith("jobs/"));
  const report = {
    started_at: new Date(now).toISOString(),
    retention_hours: RETENTION_HOURS,
    before_count: before.length,
    before_bytes: bytes(before),
    eligible_count: selected.size,
    eligible_bytes: expired.expiredBytes,
    preserved_job_records: preservedJobs.length,
    deleted_media: before.filter((blob) => selected.has(blob.url)).map((blob) => ({
      pathname: blob.pathname,
      size: blob.size,
      uploaded_at: blob.uploadedAt,
    })),
  };
  console.log("CLEANUP PLAN", JSON.stringify({
    before_count: report.before_count,
    before_bytes: report.before_bytes,
    eligible_count: report.eligible_count,
    eligible_bytes: report.eligible_bytes,
    preserved_job_records: report.preserved_job_records,
  }));

  await deleteInBatches(expired.expired);
  let after;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    after = await snapshot();
    if (!after.some((blob) => selected.has(blob.url))) break;
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  const remainingUrls = new Set(after.map((blob) => blob.url));
  const stillPresent = expired.expired.filter((url) => remainingUrls.has(url));
  assert.equal(stillPresent.length, 0, "Some expired media remain after deletion");
  const missingProtected = preserved.filter((blob) => !remainingUrls.has(blob.url));
  assert.equal(missingProtected.length, 0, "A protected file disappeared during the cleanup test");

  // Reuse the original cutoff so files crossing the retention boundary do not
  // produce a false failure. A second cleanup must perform no deletions.
  const second = await candidates(after, now);
  assert.equal(second.expired.length, 0, "Expired media remain on the second scan");
  let secondDeleteCalls = 0;
  await deleteInBatches(second.expired, async () => { secondDeleteCalls += 1; });
  assert.equal(secondDeleteCalls, 0, "Empty cleanup unexpectedly called delete");

  Object.assign(report, {
    completed_at: new Date().toISOString(),
    after_count: after.length,
    after_bytes: bytes(after),
    deleted_count: selected.size,
    deleted_bytes: expired.expiredBytes,
    second_cleanup_deleted: 0,
    protected_files_preserved: preserved.length,
    passed: true,
  });
  if (reportPath) {
    const target = path.resolve(reportPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log("CLOUD CLEANUP PASS", JSON.stringify({
    deleted_count: report.deleted_count,
    deleted_bytes: report.deleted_bytes,
    before_bytes: report.before_bytes,
    after_bytes: report.after_bytes,
    preserved_job_records: report.preserved_job_records,
    protected_files_preserved: report.protected_files_preserved,
    second_cleanup_deleted: report.second_cleanup_deleted,
  }));
}

run().catch((error) => {
  console.error("CLOUD CLEANUP FAIL", error.message);
  process.exitCode = 1;
});
