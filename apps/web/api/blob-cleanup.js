const { del, list } = require("@vercel/blob");

const RETENTION_MS = 72 * 60 * 60 * 1000;
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

function createHandler({ listBlobs = list, deleteBlobs = del } = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, error: "Method not allowed" });
      return;
    }

    const secret = process.env.CRON_SECRET;
    if (!secret) {
      res.status(503).json({ ok: false, error: "CRON_SECRET is not configured" });
      return;
    }
    if (req.headers.authorization !== `Bearer ${secret}`) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    try {
      const dryRun = ["1", "true"].includes(String(req.query?.dry_run || ""));
      const { expired, scanned, expiredBytes } = await scanExpiredMedia(Date.now(), listBlobs);
      if (!dryRun) await deleteInBatches(expired, deleteBlobs);
      const summary = {
        ok: true,
        dry_run: dryRun,
        scanned,
        eligible: expired.length,
        eligible_bytes: expiredBytes,
        deleted: dryRun ? 0 : expired.length,
        deleted_bytes: dryRun ? 0 : expiredBytes,
        retention_hours: 72,
        checked_at: new Date().toISOString(),
      };
      console.log("[blob-cleanup] completed", summary);
      res.status(200).json(summary);
    } catch (error) {
      console.error("[blob-cleanup] failed", error);
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.deleteInBatches = deleteInBatches;
module.exports.findExpiredMedia = findExpiredMedia;
module.exports.isTemporaryMedia = isTemporaryMedia;
module.exports.scanExpiredMedia = scanExpiredMedia;
