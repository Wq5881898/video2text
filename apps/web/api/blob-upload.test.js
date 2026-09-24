const assert = require("node:assert/strict");
const test = require("node:test");
const { createHandler } = require("./blob-upload");

function response() {
  return {
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; },
  };
}

test("generating an upload token performs one opportunistic cleanup", async () => {
  let cleanups = 0;
  let uploads = 0;
  const handler = createHandler({
    cleanupExpired: async () => { cleanups += 1; return { deleted: 2 }; },
    handleClientUpload: async () => { uploads += 1; return { type: "blob.generate-client-token" }; },
  });
  const result = response();
  await handler({ method: "POST", body: { type: "blob.generate-client-token" } }, result);
  assert.equal(result.code, 200);
  assert.equal(cleanups, 1);
  assert.equal(uploads, 1);
});

test("upload completion callbacks do not repeat the cleanup scan", async () => {
  let cleanups = 0;
  const handler = createHandler({
    cleanupExpired: async () => { cleanups += 1; },
    handleClientUpload: async () => ({ type: "blob.upload-completed" }),
  });
  const result = response();
  await handler({ method: "POST", body: { type: "blob.upload-completed" } }, result);
  assert.equal(result.code, 200);
  assert.equal(cleanups, 0);
});

test("a failed cleanup does not prevent a new upload from starting", async () => {
  const handler = createHandler({
    cleanupExpired: async () => { throw new Error("store temporarily unavailable"); },
    handleClientUpload: async () => ({ type: "blob.generate-client-token" }),
  });
  const result = response();
  await handler({ method: "POST", body: { type: "blob.generate-client-token" } }, result);
  assert.equal(result.code, 200);
});
