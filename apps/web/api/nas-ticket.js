const { createUploadTicket } = require("./nas-lib");

async function readJsonBody(req) {
  if (req.body && typeof req.body !== "string") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body);
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

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }
  try {
    const body = await readJsonBody(req);
    res.status(200).json(createUploadTicket(body));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not enabled|must use HTTPS|secrets/.test(message) ? 503 : 400;
    res.status(status).json({ ok: false, error: message });
  }
};
