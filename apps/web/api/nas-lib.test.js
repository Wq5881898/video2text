const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const { createUploadTicket, proxyNasJob, validateTicketRequest } = require("./nas-lib");

const ENV_KEYS = [
  "NAS_PREVIEW_ENABLED",
  "NAS_UPLOAD_ENDPOINT",
  "NAS_API_BASE",
  "NAS_SHARED_SECRET",
  "NAS_PROXY_TOKEN",
  "NAS_MAX_UPLOAD_BYTES",
];

async function withNasEnvironment(run) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    NAS_PREVIEW_ENABLED: "true",
    NAS_UPLOAD_ENDPOINT: "https://upload.example.test/files/",
    NAS_API_BASE: "https://upload.example.test",
    NAS_SHARED_SECRET: "shared-secret-that-is-longer-than-32-characters",
    NAS_PROXY_TOKEN: "proxy-token-that-is-longer-than-32-characters",
    NAS_MAX_UPLOAD_BYTES: "1000000",
  });
  try {
    await run();
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("NAS ticket is signed and contains only validated upload settings", async () => {
  await withNasEnvironment(async () => {
    const ticket = createUploadTicket({
      file_name: "recording.m4a",
      file_size: 1234,
      content_type: "audio/mp4",
      output_format: "srt",
      translate: true,
      source_language: "auto",
      translation_provider: "minimax",
    }, 1_000);
    assert.match(ticket.job_id, /^nas_[a-f0-9]{12}$/);
    assert.equal(ticket.upload_endpoint, "https://upload.example.test/files/");
    assert.equal(ticket.expires_at, 87_400);

    const [encoded, signature] = ticket.upload_token.split(".");
    const expected = crypto.createHmac("sha256", process.env.NAS_SHARED_SECRET)
      .update(encoded)
      .digest("base64url");
    assert.equal(signature, expected);
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    assert.equal(payload.job_id, ticket.job_id);
    assert.equal(payload.file_name, "recording.m4a");
    assert.equal(payload.output_format, "srt");
  });
});

test("NAS ticket validation rejects unsupported media and oversized files", () => {
  process.env.NAS_MAX_UPLOAD_BYTES = "10";
  assert.throws(() => validateTicketRequest({ file_name: "notes.txt", file_size: 5 }), /unsupported/);
  assert.throws(() => validateTicketRequest({ file_name: "audio.m4a", file_size: 11 }), /upload limit/);
  delete process.env.NAS_MAX_UPLOAD_BYTES;
});

test("NAS status proxy sends the private proxy token", async () => {
  await withNasEnvironment(async () => {
    const previousFetch = global.fetch;
    global.fetch = async (url, options) => {
      assert.equal(url, "https://upload.example.test/api/jobs/nas_123456789abc");
      assert.equal(options.headers["X-Video2Text-Proxy-Token"], process.env.NAS_PROXY_TOKEN);
      return { status: 200, text: async () => JSON.stringify({ ok: true, status: "queued" }) };
    };
    try {
      const response = await proxyNasJob("nas_123456789abc");
      assert.equal(response.status, 200);
      assert.equal(response.payload.status, "queued");
    } finally {
      global.fetch = previousFetch;
    }
  });
});
