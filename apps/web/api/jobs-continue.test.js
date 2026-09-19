const assert = require("node:assert/strict");
const test = require("node:test");
const { BlobPreconditionFailedError } = require("@vercel/blob");
const lib = require("./jobs-lib");

function response() {
  return { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
}

async function withWorker(overrides, run) {
  const saved = {};
  for (const [name, value] of Object.entries(overrides)) {
    saved[name] = lib[name];
    lib[name] = value;
  }
  const filename = require.resolve("./jobs-continue");
  const previousModule = require.cache[filename];
  delete require.cache[filename];
  try {
    await run(require("./jobs-continue"));
  } finally {
    for (const [name, value] of Object.entries(saved)) lib[name] = value;
    if (previousModule) require.cache[filename] = previousModule;
    else delete require.cache[filename];
  }
}

test("concurrent invocations cannot both submit the same paid chunk", async () => {
  let stored = {
    stage: "transcribing", cursor_version: 2, transcription_part_index: 0,
    job: {}, next_index: 0,
  };
  let version = 0;
  let workers = 0;
  let continued = 0;
  await withWorker({
    verifyJobWorkerSignature: () => true,
    readJson: async () => ({ value: structuredClone(stored), etag: String(version) }),
    writeJson: async (_path, value, options) => {
      assert(options.ifMatch != null);
      if (options.ifMatch !== String(version)) throw new BlobPreconditionFailedError();
      stored = structuredClone(value);
      version += 1;
      return { etag: String(version) };
    },
    updateJobStatus: async () => {},
    triggerJobContinuation: async () => { continued += 1; },
    transcribeWorkWindow: async (work, options) => {
      workers += 1;
      const updated = { ...work, media_plan: { parts: [{}] }, gladia_job_id: "one-paid-job" };
      await options.onCheckpoint(updated);
      return { done: false, work: updated, progress: { completed: 0, total: 1 } };
    },
  }, async (handler) => {
    const request = { method: "POST", body: { job_id: "job_123456789abc", next_index: 1 }, headers: {} };
    const first = response();
    const second = response();
    await Promise.all([handler(request, first), handler(request, second)]);
    assert.equal(workers, 1);
    assert.equal(continued, 1);
    assert.equal(stored.gladia_job_id, "one-paid-job");
    assert.equal(stored.worker_lease, null);
    assert.equal(first.code, 200);
    assert.equal(second.code, 200);
    assert([first.body.status, second.body.status].includes("worker_already_running"));
  });
});

test("replayed chunk cursors do not change a later checkpoint", async () => {
  let writes = 0;
  await withWorker({
    verifyJobWorkerSignature: () => true,
    readJson: async () => ({ value: { stage: "transcribing", cursor_version: 2, transcription_part_index: 1 }, etag: "v2" }),
    writeJson: async () => { writes += 1; },
  }, async (handler) => {
    const result = response();
    await handler({ method: "POST", body: { job_id: "job_123456789abc", next_index: 1 }, headers: {} }, result);
    assert.equal(result.body.status, "stale_continuation_ignored");
    assert.equal(result.body.next_index, 2);
    assert.equal(writes, 0);
  });
});
