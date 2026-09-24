const crypto = require("node:crypto");
const { del } = require("@vercel/blob");
const { isAppMediaUrl } = require("./media-chunks");

function cleanupToken(sourceUrl, secret = process.env.BLOB_READ_WRITE_TOKEN) {
  if (!secret) throw new Error("BLOB_READ_WRITE_TOKEN is not configured");
  return crypto
    .createHmac("sha256", secret)
    .update(`release:${sourceUrl}`)
    .digest("hex");
}

function validToken(sourceUrl, token, secret) {
  const expected = Buffer.from(cleanupToken(sourceUrl, secret));
  const received = Buffer.from(String(token || ""));
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function createHandler({ deleteBlob = del, secret = process.env.BLOB_READ_WRITE_TOKEN } = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method not allowed" });
      return;
    }

    if (!secret) {
      res.status(503).json({ ok: false, error: "Blob cleanup is not configured" });
      return;
    }
    let body;
    try {
      body = req.body && typeof req.body === "object"
        ? req.body
        : JSON.parse(String(req.body || "{}"));
    } catch {
      res.status(400).json({ ok: false, error: "Invalid JSON body" });
      return;
    }
    const sourceUrl = String(body.source_url || "").trim();
    if (!isAppMediaUrl(sourceUrl)) {
      res.status(400).json({ ok: false, error: "Only this app's uploaded media can be deleted" });
      return;
    }
    if (!validToken(sourceUrl, body.cleanup_token, secret)) {
      res.status(401).json({ ok: false, error: "Invalid cleanup token" });
      return;
    }

    try {
      await deleteBlob(sourceUrl);
      console.log("[blob-release] uploaded source deleted");
      res.status(200).json({ ok: true, deleted: true });
    } catch (error) {
      console.error("[blob-release] deletion failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        ok: false,
        deleted: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

module.exports = createHandler();
module.exports.cleanupToken = cleanupToken;
module.exports.createHandler = createHandler;
module.exports.validToken = validToken;
