const assert = require("node:assert/strict");
const test = require("node:test");
const blob = require("@vercel/blob");

test("checkpoint reads preserve the strong ETag needed by conditional writes", async () => {
  const original = blob.get;
  const modulePath = require.resolve("./jobs-lib");
  delete require.cache[modulePath];
  blob.get = async (_pathname, options) => {
    assert.equal(options.headers["accept-encoding"], "identity");
    return {
      statusCode: 200,
      stream: new Response(JSON.stringify({ stage: "transcribing", transcription_part_index: 1 })).body,
      blob: { etag: '"strong-etag"' },
    };
  };
  try {
    const { readJson } = require("./jobs-lib");
    const result = await readJson("jobs/job_123456789abc/work.json", { withMetadata: true });
    assert.equal(result.etag, '"strong-etag"');
    assert.equal(result.value.transcription_part_index, 1);
  } finally {
    blob.get = original;
    delete require.cache[modulePath];
  }
});
