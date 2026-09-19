const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  appendChunkSegments, buildMediaPlan, isAppMediaUrl, probeMedia, runTool, withMediaChunk,
} = require("./media-chunks");

test("splitting leaves every planned part below 8000 seconds with complete coverage", () => {
  for (const duration of [1, 7999, 8000, 8000.001, 8100, 12309, 16000, 50000]) {
    const plan = buildMediaPlan({ duration_seconds: duration, codec: "aac" });
    assert.equal(plan.split, duration > 8000);
    assert(plan.parts.every((part) => part.duration_seconds <= 8000));
    assert.equal(plan.parts[0].offset_seconds, 0);
    const last = plan.parts.at(-1);
    assert(Math.abs(last.offset_seconds + last.duration_seconds - duration) < 0.000001);
    plan.parts.slice(1).forEach((part, index) => {
      const previous = plan.parts[index];
      assert(Math.abs(part.offset_seconds - previous.offset_seconds - previous.duration_seconds) < 0.000001);
    });
  }
  const actual = buildMediaPlan({ duration_seconds: 12309, codec: "aac" });
  assert.equal(actual.parts.length, 2);
  assert.equal(actual.parts[1].offset_seconds, 6154.5);
});

test("invalid audio duration is rejected before remote submission", () => {
  for (const duration of [0, -1, NaN, Infinity, undefined]) {
    assert.throws(() => buildMediaPlan({ duration_seconds: duration }), /Invalid audio/);
  }
});

test("native URL inspection is restricted to this project's uploaded media", async () => {
  const base = "https://si4slzwkn8wdmagr.public.blob.vercel-storage.com";
  assert(isAppMediaUrl(`${base}/uploads/recording.m4a`));
  assert(isAppMediaUrl(`${base}/legacy.mp3`));
  for (const value of [
    "http://127.0.0.1/audio.wav", "https://example.com/audio.m4a", "file:///etc/passwd",
    `${base}/jobs/job_123/result.json`, `${base}/uploads/file.m3u8`,
    `${base}/uploads/nested/file.wav`, `${base}/uploads/audio.wav?redirect=http://localhost`,
    "https://si4slzwkn8wdmagr.public.blob.vercel-storage.com.evil.test/uploads/audio.wav",
  ]) {
    assert.equal(isAppMediaUrl(value), false, value);
    await assert.rejects(probeMedia(value), /uploaded through this app/);
  }
});

test("merged timestamps use the original recording offset and isolate speaker IDs", () => {
  const source = [{ start: 1.25, end: 2.5, text: "Second part", speaker: 0 }];
  const combined = appendChunkSegments([{ start: 0, end: 1, text: "First part" }], source,
    { index: 1, offset_seconds: 6154.5 }, true);
  assert.equal(combined[1].start, 6155.75);
  assert.equal(combined[1].end, 6157);
  assert.equal(combined[1].speaker, "part2:0");
  assert.equal(source[0].start, 1.25);
});

test("real FFmpeg splits a 12309-second recording and removes temporary chunks", { timeout: 180000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "video2text-long-audio-test-"));
  const source = path.join(directory, "long-recording.m4a");
  try {
    await runTool("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi",
      "-i", "anullsrc=r=8000:cl=mono", "-t", "12309", "-c:a", "aac", "-b:a", "8k", source,
    ], 120000);
    const metadata = await probeMedia(source);
    assert(Math.abs(metadata.duration_seconds - 12309) < 0.2);
    const plan = buildMediaPlan(metadata);
    assert.equal(plan.parts.length, 2);
    let total = 0;
    for (const part of plan.parts) {
      let chunkPath;
      await withMediaChunk(source, plan, part.index, async (chunk) => {
        chunkPath = chunk.path;
        assert(chunk.duration_seconds <= 8000);
        assert(Math.abs(chunk.duration_seconds - part.duration_seconds) < 0.5);
        total += chunk.duration_seconds;
        assert((await fs.stat(chunk.path)).size > 0);
      });
      await assert.rejects(fs.stat(chunkPath), { code: "ENOENT" });
    }
    assert(Math.abs(total - metadata.duration_seconds) < 1);
    let failedPath;
    await assert.rejects(withMediaChunk(source, plan, 0, async (chunk) => {
      failedPath = chunk.path;
      throw new Error("simulated API rejection");
    }), /simulated API rejection/);
    await assert.rejects(fs.stat(failedPath), { code: "ENOENT" });
    assert((await fs.stat(source)).size > 0);
    console.log("[native split verification]", { source_seconds: metadata.duration_seconds, part_count: plan.parts.length, combined_seconds: total });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
