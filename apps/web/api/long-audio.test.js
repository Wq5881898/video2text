const assert = require("node:assert/strict");
const test = require("node:test");
const { buildMediaPlan } = require("./media-chunks");
const { continuationCursor, renderJobResult, transcribeWorkWindow } = require("./jobs-lib");

const SOURCE_URL = "https://si4slzwkn8wdmagr.public.blob.vercel-storage.com/uploads/recording.m4a";
function work(translate = false) {
  return {
    job: { source_url: SOURCE_URL, file_name: "recording.m4a", output_format: "txt", media_type: "audio", translate },
    stage: "transcribing", cursor_version: 2, transcription_part_index: 0,
    segments_en: [], segments_zh: [], next_index: 0, gladia_job_id: null,
  };
}

function fakeServices() {
  const events = [];
  let uploads = 0;
  let submits = 0;
  const services = {
    probeMedia: async () => ({ duration_seconds: 12309, codec: "aac" }),
    withMediaChunk: async (_url, _plan, index, use) => {
      events.push(`prepare-${index}`);
      return use({ path: `chunk-${index}`, filename: `part-${index}.m4a`, content_type: "audio/mp4" });
    },
    readFile: async () => Buffer.from("test audio"),
    downloadMedia: async () => { throw new Error("Must not download the whole long recording"); },
    uploadToGladia: async () => { events.push(`upload-${uploads}`); uploads += 1; return `audio-${uploads}`; },
    submitTranscription: async () => { events.push(`submit-${submits}`); submits += 1; return `job-${submits}`; },
    pollTranscriptionWindow: async (id) => {
      events.push(`done-${id}`);
      return { done: true, result: { transcription: { utterances: [
        { start: 1, end: 2, text: `Speech ${id}`, speaker: 0 },
      ] } } };
    },
  };
  return { events, services, get submits() { return submits; } };
}

test("long audio submits strictly serially and merges into one TXT and SRT", async () => {
  const fake = fakeServices();
  let saved;
  let current = work();
  let result;
  for (let iteration = 0; iteration < 10; iteration += 1) {
    result = await transcribeWorkWindow(current, {
      services: fake.services,
      onCheckpoint: async (checkpoint) => { saved = structuredClone(checkpoint); },
    });
    current = structuredClone(result.work);
    if (result.done) break;
  }
  assert.equal(result.done, true);
  assert.deepEqual(fake.events, ["prepare-0", "upload-0", "submit-0", "done-job-1", "prepare-1", "upload-1", "submit-1", "done-job-2"]);
  assert.equal(current.segments_en[1].start, 6155.5);
  assert.equal(saved.transcription_jobs.length, 2);
  const txt = renderJobResult(current.job, current.segments_en);
  assert.equal(txt.output_filename, "recording.txt");
  assert.equal(txt.output_text, "Speech job-1\nSpeech job-2\n");
  const srt = renderJobResult({ ...current.job, output_format: "srt" }, current.segments_en);
  assert.equal(srt.output_filename, "recording.srt");
  assert(srt.output_text.includes("01:42:35,500 --> 01:42:36,500"));
});

test("refreshing a pending chunk reuses its saved paid job", async () => {
  const fake = fakeServices();
  const prepared = await transcribeWorkWindow(work(), { services: fake.services });
  const submitted = await transcribeWorkWindow(prepared.work, { services: fake.services });
  fake.services.pollTranscriptionWindow = async () => ({ done: false });
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const pending = await transcribeWorkWindow(structuredClone(submitted.work), { services: fake.services });
    assert.equal(pending.done, false);
    assert.equal(pending.work.gladia_job_id, "job-1");
  }
  assert.equal(fake.submits, 1);
  assert.equal(continuationCursor(submitted.work), 1);
});

test("a later chunk can be retried without submitting completed chunks again", async () => {
  const fake = fakeServices();
  let current = work();
  for (let iteration = 0; iteration < 3; iteration += 1) {
    current = (await transcribeWorkWindow(current, { services: fake.services })).work;
  }
  assert.equal(current.transcription_part_index, 1);
  assert.equal(continuationCursor(current), 2);
  const originalUpload = fake.services.uploadToGladia;
  fake.services.uploadToGladia = async () => { throw new Error("HTTP 503 temporary failure"); };
  await assert.rejects(transcribeWorkWindow(current, { services: fake.services }), /HTTP 503/);
  fake.services.uploadToGladia = originalUpload;
  current = (await transcribeWorkWindow(structuredClone(current), { services: fake.services })).work;
  const final = await transcribeWorkWindow(current, { services: fake.services });
  assert.equal(final.done, true);
  assert.equal(fake.submits, 2);
  assert.equal(final.work.segments_en.length, 2);
});

test("legacy jobs and external URL jobs stay on the old path", async () => {
  const fake = fakeServices();
  fake.services.probeMedia = async () => { throw new Error("Must not probe this URL"); };
  const legacy = { ...work(), cursor_version: undefined, gladia_job_id: "existing-paid-job" };
  const prepared = await transcribeWorkWindow(legacy, { services: fake.services });
  const completed = await transcribeWorkWindow(prepared.work, { services: fake.services });
  assert.equal(completed.done, true);
  assert.equal(fake.submits, 0);
  assert.equal(continuationCursor(legacy), 0);
  const external = work();
  external.job.source_url = "https://example.com/audio.m4a";
  const externalPlan = await transcribeWorkWindow(external, { services: fake.services });
  assert.equal(externalPlan.work.media_plan.split, false);
});

test("one silent chunk is allowed but an entirely silent recording fails", async () => {
  const fake = fakeServices();
  let polls = 0;
  fake.services.pollTranscriptionWindow = async () => ({ done: true, result: { transcription: { utterances:
    polls++ === 0 ? [] : [{ start: 0, end: 1, text: "Speech after silence" }],
  } } });
  let current = work(true);
  let result;
  for (let iteration = 0; iteration < 5; iteration += 1) {
    result = await transcribeWorkWindow(current, { services: fake.services });
    current = result.work;
  }
  assert.equal(result.done, true);
  assert.equal(current.stage, "translating");
  assert.equal(current.next_index, 0);
  assert.equal(continuationCursor(current), 0);
  assert.equal(current.segments_en[0].start, 6154.5);
  fake.services.pollTranscriptionWindow = async () => ({ done: true, result: { transcription: { utterances: [] } } });
  const silent = { ...work(), media_plan: buildMediaPlan({ duration_seconds: 20 }), gladia_job_id: "silent-job" };
  await assert.rejects(transcribeWorkWindow(silent, { services: fake.services }), /No transcript segments/);
});
