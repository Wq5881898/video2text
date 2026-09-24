const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const { del, put, get } = require("@vercel/blob");
const { appendChunkSegments, buildMediaPlan, isAppMediaUrl, probeMedia, withMediaChunk } = require("./media-chunks");

const GLADIA_BASE = "https://api.gladia.io/v2";
const GLADIA_UPLOAD_URL = `${GLADIA_BASE}/upload`;
const GLADIA_TRANSCRIBE_URL = `${GLADIA_BASE}/pre-recorded`;
const MINIMAX_BASE_URL = "https://api.minimaxi.com/v1";
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_ITERS = 11;
const TRANSLATION_BATCH_SIZE = 20;
const TRANSLATION_MAX_CHARS = 12000;
const BLOB_READ_ATTEMPTS = 3;

function ensureEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

function makeJobId() {
  return `job_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function jobStatusPath(jobId) {
  return `jobs/${jobId}/status.json`;
}

function jobResultPath(jobId) {
  return `jobs/${jobId}/result.json`;
}

function jobWorkPath(jobId) {
  return `jobs/${jobId}/work.json`;
}

function jobWorkerSignature(jobId, nextIndex) {
  return crypto
    .createHmac("sha256", ensureEnv("MINIMAX_API_KEY"))
    .update(`${jobId}:${nextIndex}`)
    .digest("hex");
}

function verifyJobWorkerSignature(jobId, nextIndex, signature) {
  const expected = Buffer.from(jobWorkerSignature(jobId, nextIndex));
  const received = Buffer.from(String(signature || ""));
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

async function triggerJobContinuation(jobId, nextIndex) {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (!host) {
    throw new Error("Vercel runtime URL is unavailable for job continuation");
  }
  const baseUrl = host.startsWith("http") ? host : `https://${host}`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/jobs-continue`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-video2text-job-signature": jobWorkerSignature(jobId, nextIndex),
        },
        body: JSON.stringify({ job_id: jobId, next_index: nextIndex }),
      });
      if (!response.ok) {
        throw new Error(`Continuation request failed: HTTP ${response.status} ${await response.text()}`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleep(500 * attempt);
      }
    }
  }
  throw lastError;
}

async function writeJson(pathname, data, options = {}) {
  return put(pathname, JSON.stringify(data, null, 2), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
    cacheControlMaxAge: 60,
    ...options,
  });
}

async function readJson(pathname, { withMetadata = false } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= BLOB_READ_ATTEMPTS; attempt += 1) {
    try {
      const response = await get(pathname, {
        access: "public",
        // Compression changes a public Blob's strong ETag into a weak ETag,
        // which cannot satisfy the checkpoint's conditional write.
        headers: { "cache-control": "no-cache", "accept-encoding": "identity" },
        useCache: false,
      });
      if (!response || response.statusCode !== 200 || !response.stream) {
        return null;
      }
      const text = await new Response(response.stream).text();
      const value = JSON.parse(text);
      return withMetadata ? { value, etag: response.blob.etag } : value;
    } catch (error) {
      lastError = error;
      if (attempt < BLOB_READ_ATTEMPTS) {
        await sleep(200 * attempt);
      }
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadMedia(sourceUrl) {
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(90000) });
  if (!response.ok) {
    throw new Error(`Media download failed: HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    bytes: Buffer.from(arrayBuffer),
    contentType:
      response.headers.get("content-type") || "application/octet-stream",
  };
}

async function releaseUploadedSource(sourceUrl, deleteBlob = del) {
  if (!isAppMediaUrl(sourceUrl)) {
    return { managed: false, deleted: false };
  }
  await deleteBlob(sourceUrl);
  return { managed: true, deleted: true };
}

async function uploadToGladia(filename, bytes, contentType) {
  const form = new FormData();
  form.append("audio", new Blob([bytes], { type: contentType }), filename);
  const response = await fetch(GLADIA_UPLOAD_URL, {
    method: "POST",
    headers: {
      "x-gladia-key": ensureEnv("GLADIA_API_KEY"),
    },
    body: form,
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) {
    throw new Error(
      `Gladia upload failed: HTTP ${response.status} ${await response.text()}`,
    );
  }
  const payload = await response.json();
  if (!payload.audio_url) {
    throw new Error("Gladia upload returned no audio_url");
  }
  return payload.audio_url;
}

async function submitTranscription(audioUrl) {
  const response = await fetch(GLADIA_TRANSCRIBE_URL, {
    method: "POST",
    headers: {
      "x-gladia-key": ensureEnv("GLADIA_API_KEY"),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      language_config: { languages: ["en"], code_switching: false },
      diarization: true,
      diarization_config: { min_speakers: 1, max_speakers: 4 },
      sentences: true,
      subtitles: true,
      subtitles_config: {
        formats: ["srt"],
        maximum_characters_per_row: 42,
        maximum_rows_per_caption: 2,
        style: "compliance",
      },
      summarization: false,
      chapterization: false,
      sentiment_analysis: false,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(
      `Gladia submit failed: HTTP ${response.status} ${await response.text()}`,
    );
  }
  const payload = await response.json();
  if (!payload.id) {
    throw new Error("Gladia submit returned no job id");
  }
  return payload.id;
}

async function pollTranscriptionWindow(jobId, options = {}) {
  const maxIterations = Math.max(
    1,
    Number(options.maxIterations) || POLL_MAX_ITERS,
  );
  const pollIntervalMs = Math.max(
    0,
    Number.isFinite(options.pollIntervalMs)
      ? Number(options.pollIntervalMs)
      : POLL_INTERVAL_MS,
  );
  let lastStatus = "pending";
  const deadline = Date.now() + Math.max(1, Number(options.maxWindowMs) || 60000);
  for (let index = 0; index < maxIterations; index += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let response;
    let payload;
    try {
      response = await fetch(`${GLADIA_TRANSCRIBE_URL}/${jobId}`, {
        headers: {
          "x-gladia-key": ensureEnv("GLADIA_API_KEY"),
        },
        signal: AbortSignal.timeout(Math.min(30000, remaining)),
      });
      if (response.ok) payload = await response.json();
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") break;
      throw error;
    }
    if (!response.ok) {
      throw new Error(
        `Gladia polling failed: HTTP ${response.status} ${await response.text()}`,
      );
    }
    lastStatus = String(payload.status || "pending");
    if (payload.status === "done") {
      return { done: true, result: payload.result || {}, status: "done" };
    }
    if (payload.status === "error") {
      throw new Error(`Gladia job failed: ${JSON.stringify(payload)}`);
    }
    if (index + 1 < maxIterations) {
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
  }
  return { done: false, result: null, status: lastStatus };
}

async function waitForTranscription(jobId) {
  const poll = await pollTranscriptionWindow(jobId);
  if (poll.done) return poll.result;
  throw new Error("Transcription polling timed out");
}

function continuationCursor(work) {
  if (work.stage === "transcribing" && work.cursor_version === 2) {
    return (Number(work.transcription_part_index) || 0) + 1;
  }
  return Math.max(0, Number(work.next_index) || 0);
}

async function transcribeWorkWindow(work, options = {}) {
  const checkpoint = options.onCheckpoint || (async () => {});
  const onStage = options.onStage || (async () => {});
  const services = {
    probeMedia, buildMediaPlan, withMediaChunk, downloadMedia,
    uploadToGladia, submitTranscription, pollTranscriptionWindow,
    readFile: fs.readFile,
    ...options.services,
  };
  let updated = { ...work };
  const save = async () => {
    updated.updated_at = new Date().toISOString();
    await checkpoint(updated);
  };
  if (!updated.media_plan) {
    if (updated.gladia_job_id || !isAppMediaUrl(updated.job.source_url)) {
      // Keep legacy paid requests and external-URL processing on the original path.
      updated.media_plan = { split: false, parts: [{ index: 0, offset_seconds: 0 }] };
    } else {
      await onStage("prepare_audio", "Inspecting audio duration before transcription.");
      updated.media_plan = services.buildMediaPlan(await services.probeMedia(updated.job.source_url));
    }
    updated.transcription_part_index = 0;
    await save();
    return {
      done: false, work: updated, prepared: true,
      progress: { completed: 0, total: updated.media_plan.parts.length },
    };
  }
  const plan = updated.media_plan;
  const index = Number(updated.transcription_part_index) || 0;
  const part = plan.parts[index];
  if (!part) throw new Error("Audio chunk index in the saved checkpoint is invalid");
  const progress = { completed: index, total: plan.parts.length };
  if (!updated.gladia_job_id) {
    const submit = async (filename, bytes, contentType) => {
      await onStage("upload_to_gladia", `Uploading audio part ${index + 1} of ${plan.parts.length}.`, { progress });
      const audioUrl = await services.uploadToGladia(filename, bytes, contentType);
      await onStage("submit_transcription", `Submitting audio part ${index + 1} of ${plan.parts.length}.`, { progress });
      return services.submitTranscription(audioUrl);
    };
    if (plan.split) {
      await onStage("prepare_audio", `Preparing audio part ${index + 1} of ${plan.parts.length}.`, { progress });
      updated.gladia_job_id = await services.withMediaChunk(updated.job.source_url, plan, index, async (chunk) =>
        submit(chunk.filename, await services.readFile(chunk.path), chunk.content_type));
    } else {
      const downloaded = await services.downloadMedia(updated.job.source_url);
      updated.gladia_job_id = await submit(updated.job.file_name, downloaded.bytes, downloaded.contentType);
    }
    await save();
    return { done: false, work: updated, progress, submitted: true };
  }
  await onStage("poll_transcription", `Transcribing audio part ${index + 1} of ${plan.parts.length}.`, {
    progress, gladia_job_id: updated.gladia_job_id,
  });
  const result = await services.pollTranscriptionWindow(updated.gladia_job_id, {
    maxIterations: options.maxIterations || 10,
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
  });
  if (!result.done) return { done: false, work: updated, progress };
  const segments = extractSegments(result.result);
  // Silence in one chunk is valid; fail only if the entire recording has no transcript.
  updated.segments_en = appendChunkSegments(updated.segments_en || [], segments, part, plan.split);
  updated.transcription_part_index = index + 1;
  updated.transcription_jobs = [
    ...(updated.transcription_jobs || []),
    { index, job_id: updated.gladia_job_id, segment_count: segments.length },
  ];
  updated.gladia_job_id = null;
  const done = updated.transcription_part_index >= plan.parts.length;
  if (done) {
    if (!updated.segments_en.length) throw new Error("No transcript segments were returned");
    updated.stage = updated.job.translate ? "translating" : "rendering";
    updated.next_index = 0;
    updated.segments_zh = [];
  }
  await save();
  return {
    done, work: updated,
    progress: { completed: updated.transcription_part_index, total: plan.parts.length },
  };
}

function extractSegments(result) {
  const utterances = result?.transcription?.utterances || [];
  return utterances
    .map((item) => ({
      start: Math.round(Number(item.start || 0) * 100) / 100,
      end: Math.round(Number(item.end || 0) * 100) / 100,
      speaker: item.speaker ?? null,
      text: String(item.text || "").trim(),
    }))
    .filter((item) => item.text);
}

async function requestTranslationBatch(texts) {
  const segments = texts.map((text, id) => ({ id, text }));
  const baseUrl = (process.env.MINIMAX_BASE_URL || MINIMAX_BASE_URL).replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ensureEnv("MINIMAX_API_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.MINIMAX_MODEL || "MiniMax-M3",
      temperature: 0,
      max_tokens: 4000,
      reasoning_split: true,
      thinking: { type: "disabled" },
      messages: [
        { role: "system", content: "Translate each English subtitle into natural Simplified Chinese. Preserve meaning, names, numbers, tone and every id. Never merge, split or omit segments. Return exactly one plain-text line per segment: the numeric id, one tab character, then the translation. Example: 0\tChinese translation. Do not use JSON, Markdown, explanations, blank lines, or extra text." },
        { role: "user", content: JSON.stringify({ segments }) },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`MiniMax translation failed: HTTP ${response.status} ${await response.text()}`);
  }
  const payload = await response.json();
  const choice = payload.choices?.[0];
  if (choice?.finish_reason !== "stop") {
    throw new Error(`MiniMax output incomplete: ${choice?.finish_reason}`);
  }
  let content = String(choice.message?.content || "").trim();
  if (content.startsWith("```")) content = content.replace(/^```(?:json)?\s*/, "").replace(/```$/, "").trim();
  let translations;
  try {
    translations = JSON.parse(content).translations;
  } catch {
    translations = content.split(/\r?\n/).filter(Boolean).map((line) => {
      const match = line.match(/^\s*(\d+)\s*\t\s*(.+?)\s*$/);
      return match ? { id: Number(match[1]), text: match[2] } : null;
    });
  }
  if (!Array.isArray(translations) || translations.length !== texts.length ||
      translations.some((item, index) => !item || Number(item.id) !== index || !String(item.text || "").trim())) {
    throw new Error("MiniMax returned missing or mismatched translations");
  }
  return translations.map((item) => String(item.text).trim());
}

async function translateBatch(texts) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await requestTranslationBatch(texts);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (/MINIMAX_API_KEY is not configured|HTTP (401|402|403|429)/.test(message)) throw error;
      console.warn("[minimax] translation batch retry", { size: texts.length, attempt, error: message });
      if (attempt < 2) await sleep(500);
    }
  }
  if (texts.length === 1) {
    throw new Error(`MiniMax translation failed after retries: ${lastError?.message || lastError}`);
  }
  if (!(lastError instanceof SyntaxError) &&
      !/MiniMax (output incomplete|returned missing or mismatched translations)/.test(lastError?.message || "")) {
    throw lastError;
  }
  const middle = Math.floor(texts.length / 2);
  console.warn("[minimax] splitting failed translation batch", { size: texts.length, middle });
  return [
    ...(await translateBatch(texts.slice(0, middle))),
    ...(await translateBatch(texts.slice(middle))),
  ];
}

async function translateSegments(segments) {
  const translated = [];
  let batch = [];
  let batchChars = 0;

  async function flush() {
    if (!batch.length) {
      return;
    }
    translated.push(...(await translateBatch(batch)));
    batch = [];
    batchChars = 0;
  }

  for (const segment of segments) {
    const text = segment.text;
    if (
      batch.length &&
      (batch.length >= TRANSLATION_BATCH_SIZE ||
        batchChars + text.length > TRANSLATION_MAX_CHARS)
    ) {
      await flush();
    }
    batch.push(text);
    batchChars += text.length;
  }
  await flush();

  return translated.map((text, index) => ({
    ...segments[index],
    text,
  }));
}

function formatTimestamp(value) {
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = (value % 60).toFixed(3).padStart(6, "0");
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${seconds}`.replace(
    ".",
    ",",
  );
}

function renderTxt(segmentsEn, segmentsZh) {
  const lines = [];
  if (!segmentsZh) {
    return `${segmentsEn.map((segment) => segment.text).join("\n")}\n`;
  }
  for (let index = 0; index < segmentsEn.length; index += 1) {
    lines.push(segmentsZh[index].text);
    lines.push(segmentsEn[index].text);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderSrt(segmentsEn, segmentsZh) {
  const lines = [];
  for (let index = 0; index < segmentsEn.length; index += 1) {
    const en = segmentsEn[index];
    const zh = segmentsZh ? segmentsZh[index] : null;
    lines.push(String(index + 1));
    lines.push(`${formatTimestamp(en.start)} --> ${formatTimestamp(en.end)}`);
    if (zh) {
      lines.push(zh.text);
    }
    lines.push(en.text);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function outputFilename(sourceName, outputFormat) {
  const stem = sourceName.includes(".")
    ? sourceName.slice(0, sourceName.lastIndexOf("."))
    : sourceName;
  return `${stem}.${outputFormat}`;
}

async function submitJob(job, options = {}) {
  const onStage =
    typeof options.onStage === "function" ? options.onStage : async () => {};

  await onStage(
    "download_source",
    "Downloading the uploaded file from cloud storage.",
  );
  const download = await downloadMedia(job.source_url);
  await onStage(
    "upload_to_gladia",
    "Uploading the media to the speech engine.",
    {
      downloaded_bytes: download.bytes.length,
    },
  );
  const audioUrl = await uploadToGladia(
    job.file_name,
    download.bytes,
    download.contentType,
  );
  await onStage("submit_transcription", "Submitting the transcription job.");
  const gladiaJobId = await submitTranscription(audioUrl);
  return gladiaJobId;
}

async function prepareJob(job, options = {}) {
  const onStage =
    typeof options.onStage === "function" ? options.onStage : async () => {};
  const gladiaJobId = await submitJob(job, options);
  await onStage(
    "poll_transcription",
    "Waiting for the speech engine to finish.",
    {
      gladia_job_id: gladiaJobId,
    },
  );
  const transcriptionResult = await waitForTranscription(gladiaJobId);
  const segmentsEn = extractSegments(transcriptionResult);
  if (!segmentsEn.length) {
    throw new Error("No transcript segments were returned");
  }
  await onStage(
    "transcription_done",
    `Transcript received with ${segmentsEn.length} segments.`,
  );
  return segmentsEn;
}

function renderJobResult(job, segmentsEn, segmentsZh = null) {
  const outputText =
    job.output_format === "srt"
      ? renderSrt(segmentsEn, segmentsZh)
      : renderTxt(segmentsEn, segmentsZh);
  return {
    output_filename: outputFilename(job.file_name, job.output_format),
    output_text: outputText,
    segment_count: segmentsEn.length,
    translated: Boolean(segmentsZh),
    media_type: job.media_type,
  };
}

async function translateWorkBatch(work) {
  const segmentsEn = Array.isArray(work.segments_en) ? work.segments_en : [];
  const start = Math.max(0, Number(work.next_index) || 0);
  const end = Math.min(start + TRANSLATION_BATCH_SIZE, segmentsEn.length);
  if (start >= end) {
    return { ...work, next_index: segmentsEn.length };
  }
  const sourceBatch = segmentsEn.slice(start, end);
  const texts = await translateBatch(sourceBatch.map((segment) => segment.text));
  const translatedBatch = texts.map((text, index) => ({
    ...sourceBatch[index],
    text,
  }));
  const previous = Array.isArray(work.segments_zh)
    ? work.segments_zh.slice(0, start)
    : [];
  return {
    ...work,
    segments_zh: [...previous, ...translatedBatch],
    next_index: end,
    updated_at: new Date().toISOString(),
  };
}

async function processJob(job, options = {}) {
  const onStage =
    typeof options.onStage === "function" ? options.onStage : async () => {};
  const segmentsEn = await prepareJob(job, options);
  const segmentsZh = job.translate ? await translateSegments(segmentsEn) : null;
  if (job.translate) {
    await onStage("translation_done", "Chinese translation completed.");
  }
  return renderJobResult(job, segmentsEn, segmentsZh);
}

async function updateJobStatus(jobId, data) {
  await writeJson(jobStatusPath(jobId), {
    job_id: jobId,
    updated_at: new Date().toISOString(),
    ...data,
  });
}

module.exports = {
  continuationCursor,
  jobResultPath,
  jobStatusPath,
  jobWorkPath,
  makeJobId,
  extractSegments,
  pollTranscriptionWindow,
  prepareJob,
  processJob,
  readJson,
  releaseUploadedSource,
  renderJobResult,
  submitJob,
  triggerJobContinuation,
  transcribeWorkWindow,
  translateWorkBatch,
  translateSegments,
  updateJobStatus,
  verifyJobWorkerSignature,
  writeJson,
};
