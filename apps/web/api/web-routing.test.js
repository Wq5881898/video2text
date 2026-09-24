const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

async function frontend(responses) {
  const raw = await fs.readFile(path.join(__dirname, "../public/web.js"), "utf8");
  const source = raw.replace(/^import[^\n]+\n/, "").split(/\r?\ndocument\r?\n/)[0];
  const calls = [];
  const redirects = [];
  const elements = new Map();
  const context = vm.createContext({
    URL, Date, Error,
    document: { getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    } },
    window: { location: { assign: (url) => redirects.push(url) } },
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      const response = responses.shift();
      assert(response, `Unexpected request: ${url}`);
      return { ok: response.ok !== false, status: response.ok === false ? 400 : 200, text: async () => JSON.stringify(response) };
    },
  });
  vm.runInContext(source, context);
  return { context, calls, redirects };
}

test("the sync product automatically hands long uploads to one durable job", async () => {
  const page = await frontend([
    { ok: true, splitting_supported: true, split_required: true, part_count: 2 },
    { ok: true, job_url: "/jobs/job_123456789abc" },
  ]);
  const result = await page.context.processCloudSource("https://blob.example/long.m4a", "long.m4a", "srt", true);
  assert.equal(result, null);
  assert.deepEqual(page.calls.map((call) => call.url), ["./api/media-info", "./api/jobs-create"]);
  assert.deepEqual(page.redirects, ["/jobs/job_123456789abc"]);
  assert.equal(page.calls[1].body.output_format, "srt");
  assert.equal(page.calls[1].body.translate, true);
});

test("short uploads keep the existing sync behavior", async () => {
  const page = await frontend([
    { ok: true, splitting_supported: true, split_required: false },
    { ok: true, result: { output_text: "Short transcript" } },
  ]);
  const result = await page.context.processCloudSource("https://blob.example/short.m4a", "short.m4a", "txt", false);
  assert.equal(result.payload.result.output_text, "Short transcript");
  assert.deepEqual(page.calls.map((call) => call.url), ["./api/media-info", "./api/transcribe"]);
  assert.equal(page.redirects.length, 0);
});

test("a completed short upload immediately calls the signed release endpoint", async () => {
  const sourceUrl = "https://blob.example/short.m4a";
  const page = await frontend([
    { ok: true, splitting_supported: true, split_required: false },
    { ok: true, source_cleanup_token: "signed-token", result: { output_text: "Short transcript" } },
    { ok: true, deleted: true },
  ]);
  const result = await page.context.processCloudSource(sourceUrl, "short.m4a", "txt", false);
  assert.deepEqual(page.calls.map((call) => call.url), [
    "./api/media-info",
    "./api/transcribe",
    "./api/blob-release",
  ]);
  assert.deepEqual(page.calls[2].body, {
    source_url: sourceUrl,
    cleanup_token: "signed-token",
  });
  assert.equal(result.payload.source_cleanup.managed, true);
  assert.equal(result.payload.source_cleanup.deleted, true);
  assert.equal(result.payload.source_cleanup_token, undefined);
});

test("a Gladia duration rejection can still be handed off without re-uploading", async () => {
  const page = await frontend([
    { ok: true, splitting_supported: true, split_required: false },
    { ok: false, status: "background_required" },
    { ok: true, job_url: "/jobs/job_123456789abc" },
  ]);
  await page.context.processCloudSource("https://blob.example/long.m4a", "long.m4a", "txt", false);
  assert.equal(page.calls[2].body.source_url, page.calls[1].body.source_url);
  assert.equal(page.redirects.length, 1);
});

test("arbitrary external URL probes are never performed by media-info", async () => {
  const handler = require("./media-info");
  const response = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await handler({ method: "POST", body: { source_url: "http://127.0.0.1/private.wav" } }, response);
  assert.equal(response.code, 200);
  assert.equal(response.body.splitting_supported, false);
});

test("root and deployed frontend code remain identical", async () => {
  assert.equal(
    await fs.readFile(path.join(__dirname, "../web.js"), "utf8"),
    await fs.readFile(path.join(__dirname, "../public/web.js"), "utf8"),
  );
});
