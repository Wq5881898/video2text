const { handleUpload } = require("@vercel/blob/client");

const { cleanupExpiredMedia } = require("./blob-cleanup");

const ALLOWED_CONTENT_TYPES = ["audio/*", "video/*"];

function readRequestBody(req) {
  if (req.body) {
    if (typeof req.body === "string") {
      return Promise.resolve(JSON.parse(req.body));
    }
    return Promise.resolve(req.body);
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function createHandler({
  handleClientUpload = handleUpload,
  cleanupExpired = cleanupExpiredMedia,
} = {}) {
  return async function handler(req, res) {
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method not allowed" });
      return;
    }

    try {
      const body = await readRequestBody(req);
      console.log("[blob-upload] request received", {
        pathname: body?.pathname,
        hasType: Boolean(body?.type),
        type: body?.type,
        multipart: body?.payload?.multipart,
      });
      if (body?.type === "blob.generate-client-token") {
        try {
          const summary = await cleanupExpired();
          console.log("[blob-upload] pre-upload cleanup completed", summary);
        } catch (error) {
          console.warn("[blob-upload] pre-upload cleanup deferred", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const json = await handleClientUpload({
        body,
        request: req,
        onBeforeGenerateToken: async (pathname) => {
          console.log("[blob-upload] generating token", { pathname });
          return {
            allowedContentTypes: ALLOWED_CONTENT_TYPES,
            maximumSizeInBytes: 2 * 1024 * 1024 * 1024,
            addRandomSuffix: true,
            tokenPayload: JSON.stringify({ pathname }),
          };
        },
      });

      console.log("[blob-upload] success", {
        hasResponse: Boolean(json),
        keys: json ? Object.keys(json) : [],
      });
      res.status(200).json(json);
    } catch (error) {
      console.error("[blob-upload] failed", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
