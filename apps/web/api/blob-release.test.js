const assert = require("node:assert/strict");
const test = require("node:test");
const { cleanupToken, createHandler } = require("./blob-release");

const SOURCE_URL = "https://si4slzwkn8wdmagr.public.blob.vercel-storage.com/uploads/recording-random.m4a";
const SECRET = "test-blob-secret";

function response() {
  return {
    setHeader() {},
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; },
  };
}

test("a signed cleanup request deletes only this app's uploaded media", async () => {
  const deleted = [];
  const handler = createHandler({
    secret: SECRET,
    deleteBlob: async (url) => deleted.push(url),
  });
  const result = response();
  await handler({
    method: "POST",
    body: { source_url: SOURCE_URL, cleanup_token: cleanupToken(SOURCE_URL, SECRET) },
  }, result);
  assert.equal(result.code, 200);
  assert.equal(result.body.deleted, true);
  assert.deepEqual(deleted, [SOURCE_URL]);
});

test("an invalid signature cannot delete uploaded media", async () => {
  let deleted = 0;
  const handler = createHandler({ secret: SECRET, deleteBlob: async () => { deleted += 1; } });
  const result = response();
  await handler({ method: "POST", body: { source_url: SOURCE_URL, cleanup_token: "invalid" } }, result);
  assert.equal(result.code, 401);
  assert.equal(deleted, 0);
});

test("external URLs are never deleted", async () => {
  let deleted = 0;
  const handler = createHandler({ secret: SECRET, deleteBlob: async () => { deleted += 1; } });
  const result = response();
  await handler({
    method: "POST",
    body: {
      source_url: "https://example.com/recording.m4a",
      cleanup_token: cleanupToken("https://example.com/recording.m4a", SECRET),
    },
  }, result);
  assert.equal(result.code, 400);
  assert.equal(deleted, 0);
});
