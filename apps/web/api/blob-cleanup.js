const { del, list } = require("@vercel/blob");

const RETENTION_HOURS = 48;
const RETENTION_MS = RETENTION_HOURS * 60 * 60 * 1000;
const DELETE_BATCH_SIZE = 100;
const MEDIA_EXTENSION = /\.(?:m4a|m4b|mp3|wav|mp4|mov|mkv|avi|webm|aac|flac|ogg|oga|opus|wma|aiff?|amr|3g[p2]|mpeg|mpg|m4v|mts|m2ts|ts)$/i;

function isTemporaryMedia(blob) {
  const pathname = String(blob.pathname || "");
  // Job records and files outside the app's media locations must never expire.
  if (
    !pathname ||
    (pathname.includes("/") &&
      !pathname.startsWith("uploads/") &&
      !pathname.startsWith("cloud-smoke/"))
  ) {
    return false;
  }
  const contentType = String(blob.contentType || "").toLowerCase();
  // list() exposes pathname, size and uploadedAt, but not contentType.
  return (
    MEDIA_EXTENSION.test(pathname) ||
    contentType.startsWith("audio/") ||
    contentType.startsWith("video/")
  );
}

async function scanExpiredMedia(now = Date.now(), listBlobs = list) {
  const cutoff = now - RETENTION_MS;
  const expired = [];
  let scanned = 0;
  let expiredBytes = 0;
  let cursor;

  do {
    const page = await listBlobs({ cursor, limit: 1000 });
    for (const blob of page.blobs) {
      scanned += 1;
      const uploadedAt = new Date(blob.uploadedAt).getTime();
      if (isTemporaryMedia(blob) && Number.isFinite(uploadedAt) && uploadedAt < cutoff) {
        expired.push(blob.url);
        expiredBytes += Math.max(0, Number(blob.size) || 0);
      }
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return { expired, scanned, expiredBytes };
}

async function findExpiredMedia(now = Date.now(), listBlobs = list) {
  return (await scanExpiredMedia(now, listBlobs)).expired;
}

async function deleteInBatches(urls, deleteBlobs = del) {
  for (let index = 0; index < urls.length; index += DELETE_BATCH_SIZE) {
    await deleteBlobs(urls.slice(index, index + DELETE_BATCH_SIZE));
  }
}

async function cleanupExpiredMedia({
  now = Date.now(),
  listBlobs = list,
  deleteBlobs = del,
} = {}) {
  const { expired, scanned, expiredBytes } = await scanExpiredMedia(now, listBlobs);
  await deleteInBatches(expired, deleteBlobs);
  return {
    scanned,
    eligible: expired.length,
    eligible_bytes: expiredBytes,
    deleted: expired.length,
    deleted_bytes: expiredBytes,
    retention_hours: RETENTION_HOURS,
    checked_at: new Date(now).toISOString(),
  };
}

module.exports = {
  RETENTION_HOURS,
  cleanupExpiredMedia,
  deleteInBatches,
  findExpiredMedia,
  isTemporaryMedia,
  scanExpiredMedia,
};
