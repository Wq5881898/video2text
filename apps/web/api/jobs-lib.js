const crypto = require("node:crypto");
const { put, get } = require("@vercel/blob");

const GLADIA_BASE = "https://api.gladia.io/v2";
const GLADIA_UPLOAD_URL = `${GLADIA_BASE}/upload`;
const GLADIA_TRANSCRIBE_URL = `${GLADIA_BASE}/pre-recorded`;
const DEEPL_URL = "https://api-free.deepl.com/v2/translate";
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_ITERS = 11;
const DEEPL_BATCH_SIZE = 40;
const DEEPL_MAX_CHARS = 45000;

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

async function writeJson(pathname, data) {
  return put(pathname, JSON.stringify(data, null, 2), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
  });
}

async function readJson(pathname) {
  const response = await get(pathname, { access: "public" });
  if (!response || response.statusCode !== 200 || !response.stream) {
    return null;
  }
  const text = await new Response(response.stream).text();
  return JSON.parse(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadMedia(sourceUrl) {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Media download failed: HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    bytes: Buffer.from(arrayBuffer),
    contentType: response.headers.get("content-type") || "application/octet-stream",
  };
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
  });
  if (!response.ok) {
    throw new Error(`Gladia upload failed: HTTP ${response.status} ${await response.text()}`);
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
  });
  if (!response.ok) {
    throw new Error(`Gladia submit failed: HTTP ${response.status} ${await response.text()}`);
  }
  const payload = await response.json();
  if (!payload.id) {
    throw new Error("Gladia submit returned no job id");
  }
  return payload.id;
}

async function waitForTranscription(jobId) {
  for (let index = 0; index < POLL_MAX_ITERS; index += 1) {
    const response = await fetch(`${GLADIA_TRANSCRIBE_URL}/${jobId}`, {
      headers: {
        "x-gladia-key": ensureEnv("GLADIA_API_KEY"),
      },
    });
    if (!response.ok) {
      throw new Error(`Gladia polling failed: HTTP ${response.status} ${await response.text()}`);
    }
    const payload = await response.json();
    if (payload.status === "done") {
      return payload.result || {};
    }
    if (payload.status === "error") {
      throw new Error(`Gladia job failed: ${JSON.stringify(payload)}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("Transcription polling timed out");
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

async function translateBatch(texts) {
  const params = new URLSearchParams();
  for (const text of texts) {
    params.append("text", text);
  }
  params.set("source_lang", "EN");
  params.set("target_lang", "ZH");
  const response = await fetch(DEEPL_URL, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${ensureEnv("DEEPL_KEY")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!response.ok) {
    throw new Error(`DeepL translation failed: HTTP ${response.status} ${await response.text()}`);
  }
  const payload = await response.json();
  const translations = payload.translations || [];
  return translations.map((item) => String(item.text || "").trim());
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
    if (batch.length && (batch.length >= DEEPL_BATCH_SIZE || batchChars + text.length > DEEPL_MAX_CHARS)) {
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
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${seconds}`.replace(".", ",");
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
  const stem = sourceName.includes(".") ? sourceName.slice(0, sourceName.lastIndexOf(".")) : sourceName;
  return `${stem}.${outputFormat}`;
}

async function processJob(job) {
  const download = await downloadMedia(job.source_url);
  const audioUrl = await uploadToGladia(job.file_name, download.bytes, download.contentType);
  const transcriptionResult = await waitForTranscription(await submitTranscription(audioUrl));
  const segmentsEn = extractSegments(transcriptionResult);
  if (!segmentsEn.length) {
    throw new Error("No transcript segments were returned");
  }
  const segmentsZh = job.translate ? await translateSegments(segmentsEn) : null;
  const outputText = job.output_format === "srt"
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

async function updateJobStatus(jobId, data) {
  await writeJson(jobStatusPath(jobId), {
    job_id: jobId,
    updated_at: new Date().toISOString(),
    ...data,
  });
}

module.exports = {
  jobResultPath,
  jobStatusPath,
  makeJobId,
  processJob,
  readJson,
  updateJobStatus,
  writeJson,
};
