const crypto = require("node:crypto");

const NAS_JOB_PATTERN = /^nas_[a-f0-9]{12}$/;
const SUPPORTED_EXTENSIONS = new Set([
  ".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".wma", ".m4b",
  ".mp4", ".mov", ".mkv", ".avi", ".wmv", ".flv", ".webm", ".m4v",
]);

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function ensureNasConfig() {
  if (String(process.env.NAS_PREVIEW_ENABLED || "").toLowerCase() !== "true") {
    throw new Error("NAS preview is not enabled");
  }
  const uploadEndpoint = String(process.env.NAS_UPLOAD_ENDPOINT || "").trim();
  const apiBase = String(process.env.NAS_API_BASE || "").trim().replace(/\/$/, "");
  const sharedSecret = String(process.env.NAS_SHARED_SECRET || "").trim();
  const proxyToken = String(process.env.NAS_PROXY_TOKEN || "").trim();
  if (!uploadEndpoint.startsWith("https://") || !apiBase.startsWith("https://")) {
    throw new Error("NAS_UPLOAD_ENDPOINT and NAS_API_BASE must use HTTPS");
  }
  if (sharedSecret.length < 32 || proxyToken.length < 32) {
    throw new Error("NAS secrets must contain at least 32 characters");
  }
  return {
    uploadEndpoint: uploadEndpoint.endsWith("/") ? uploadEndpoint : `${uploadEndpoint}/`,
    apiBase,
    sharedSecret,
    proxyToken,
  };
}

function extensionOf(fileName) {
  const match = String(fileName || "").toLowerCase().match(/(\.[a-z0-9]+)$/);
  return match ? match[1] : "";
}

function validateTicketRequest(body) {
  const fileName = String(body.file_name || "").trim().split(/[\\/]/).pop();
  const fileSize = Number(body.file_size);
  const contentType = String(body.content_type || "application/octet-stream").trim();
  const outputFormat = String(body.output_format || "txt").trim().toLowerCase();
  const sourceLanguage = String(body.source_language || "auto").trim().toLowerCase();
  const translationProvider = String(body.translation_provider || "minimax").trim().toLowerCase();
  const maxBytes = Number(process.env.NAS_MAX_UPLOAD_BYTES || 5 * 1024 * 1024 * 1024);
  if (!fileName || fileName.length > 180 || !SUPPORTED_EXTENSIONS.has(extensionOf(fileName))) {
    throw new Error("unsupported media file name or extension");
  }
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > maxBytes) {
    throw new Error("file size is outside the NAS upload limit");
  }
  if (!new Set(["txt", "srt"]).has(outputFormat)) {
    throw new Error("output_format must be txt or srt");
  }
  if (!new Set(["auto", "en", "zh", "en_zh"]).has(sourceLanguage)) {
    throw new Error("unsupported source language mode");
  }
  if (!new Set(["minimax", "glm", "qwen"]).has(translationProvider)) {
    throw new Error("unsupported translation provider");
  }
  return {
    file_name: fileName,
    file_size: fileSize,
    content_type: contentType,
    output_format: outputFormat,
    translate: Boolean(body.translate),
    source_language: sourceLanguage,
    translation_provider: translationProvider,
  };
}

function createUploadTicket(body, nowSeconds = Math.floor(Date.now() / 1000)) {
  const config = ensureNasConfig();
  const request = validateTicketRequest(body);
  const jobId = `nas_${crypto.randomBytes(6).toString("hex")}`;
  const payload = {
    version: 1,
    job_id: jobId,
    ...request,
    expires_at: nowSeconds + 24 * 60 * 60,
    nonce: crypto.randomBytes(12).toString("hex"),
  };
  const encoded = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", config.sharedSecret).update(encoded).digest("base64url");
  return {
    ok: true,
    backend: "nas",
    job_id: jobId,
    job_url: `/jobs/${jobId}`,
    upload_endpoint: config.uploadEndpoint,
    upload_token: `${encoded}.${signature}`,
    expires_at: payload.expires_at,
  };
}

async function proxyNasJob(jobId, suffix = "") {
  if (!NAS_JOB_PATTERN.test(jobId)) {
    return { status: 400, payload: { ok: false, error: "invalid NAS job id" } };
  }
  let config;
  try {
    config = ensureNasConfig();
  } catch (error) {
    return { status: 503, payload: { ok: false, error: error.message } };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(
      `${config.apiBase}/api/jobs/${encodeURIComponent(jobId)}${suffix}`,
      {
        headers: { "X-Video2Text-Proxy-Token": config.proxyToken },
        cache: "no-store",
        signal: controller.signal,
      },
    );
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { ok: false, error: "NAS worker returned a non-JSON response" };
    }
    return { status: response.status, payload };
  } catch (error) {
    return {
      status: 503,
      payload: {
        ok: false,
        error: error.name === "AbortError" ? "NAS worker status request timed out" : "NAS worker is unavailable",
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  NAS_JOB_PATTERN,
  createUploadTicket,
  ensureNasConfig,
  proxyNasJob,
  validateTicketRequest,
};
