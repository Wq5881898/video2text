const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execute = promisify(execFile);
const MAX_AUDIO_SECONDS = 8000;
const CHUNK_TARGET_SECONDS = 7998;
const MEDIA_BLOB_HOST = "si4slzwkn8wdmagr.public.blob.vercel-storage.com";
const MEDIA_FORMATS = "mov,mp3,wav,flac,aac,ogg,matroska,webm,avi,asf,flv,mpegts,mpeg,aiff,amr";

function isAppMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === MEDIA_BLOB_HOST &&
      !url.port && !url.username && !url.password && !url.search &&
      (/^\/uploads\/[^/]+$/i.test(url.pathname) || /^\/cloud-smoke\/[^/]+$/i.test(url.pathname) || /^\/[^/]+$/.test(url.pathname)) &&
      /\.(m4a|m4b|mp3|wav|flac|aac|ogg|opus|mp4|mov|mkv|avi|wmv|webm|flv|m4v)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function sourceOptions(source) {
  const remote = /^[a-z]+:\/\//i.test(source);
  if (remote && !isAppMediaUrl(source)) {
    throw new Error("Automatic audio splitting requires a media file uploaded through this app");
  }
  return [
    "-rw_timeout", "30000000", "-protocol_whitelist", remote ? "https,tls,tcp" : "file",
    "-format_whitelist", MEDIA_FORMATS,
  ];
}

function binaryPath(name) {
  const override = process.env[name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"];
  if (override) return override;
  // Resolve platform packages explicitly so Vercel's file tracer includes Linux binaries.
  if (process.platform === "linux" && process.arch === "x64") {
    return name === "ffmpeg"
      ? require.resolve("@ffmpeg-installer/linux-x64/ffmpeg")
      : require.resolve("@ffprobe-installer/linux-x64/ffprobe");
  }
  return name === "ffmpeg"
    ? require("@ffmpeg-installer/ffmpeg").path
    : require("@ffprobe-installer/ffprobe").path;
}

async function runTool(name, args, timeout = 120000) {
  try {
    return await execute(binaryPath(name), args, {
      timeout,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const detail = String(error.stderr || error.message).slice(-1600);
    throw new Error(`${name} media preparation failed: ${detail}`, { cause: error });
  }
}

async function probeMedia(source, { timeoutMs = 90000 } = {}) {
  const { stdout } = await runTool("ffprobe", [
    "-v", "error", ...sourceOptions(source), "-select_streams", "a:0",
    "-show_entries", "stream=codec_name,duration:format=duration",
    "-of", "json", source,
  ], timeoutMs);
  const payload = JSON.parse(stdout);
  const stream = payload.streams?.[0];
  if (!stream) throw new Error("The source file has no audio track");
  const streamDuration = Number(stream.duration);
  const duration = Number.isFinite(streamDuration) && streamDuration > 0
    ? streamDuration : Number(payload.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Could not determine the audio duration before transcription");
  }
  return { duration_seconds: duration, codec: String(stream.codec_name || "") };
}

function buildMediaPlan(metadata, maxSeconds = MAX_AUDIO_SECONDS) {
  const duration = Number(metadata.duration_seconds);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(maxSeconds) || maxSeconds <= 2) {
    throw new Error("Invalid audio duration or chunk limit");
  }
  const count = duration <= maxSeconds ? 1 : Math.ceil(duration / Math.min(CHUNK_TARGET_SECONDS, maxSeconds - 2));
  const seconds = duration / count;
  return {
    ...metadata,
    split: count > 1,
    parts: Array.from({ length: count }, (_, index) => ({
      index,
      offset_seconds: index * seconds,
      duration_seconds: Math.min(seconds, duration - index * seconds),
    })),
  };
}

function copyFormat(codec) {
  if (["aac", "alac"].includes(codec)) return ["m4a", "audio/mp4"];
  if (codec === "mp3") return ["mp3", "audio/mpeg"];
  if (codec === "flac") return ["flac", "audio/flac"];
  if (["opus", "vorbis"].includes(codec)) return ["ogg", "audio/ogg"];
  if (codec.startsWith("pcm_")) return ["wav", "audio/wav"];
  return null;
}

async function withMediaChunk(sourceUrl, plan, partIndex, useChunk) {
  const part = plan.parts[partIndex];
  if (!part) throw new Error("Audio chunk index is out of range");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "video2text-chunk-"));
  try {
    let format = copyFormat(plan.codec);
    let output;
    const inputArgs = [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...sourceOptions(sourceUrl),
      "-ss", String(part.offset_seconds), "-i", sourceUrl,
      "-t", String(part.duration_seconds), "-map", "0:a:0", "-vn",
    ];
    if (format) {
      output = path.join(directory, `part-${partIndex + 1}.${format[0]}`);
      try {
        await runTool("ffmpeg", [...inputArgs, "-c:a", "copy", "-avoid_negative_ts", "make_zero", output], 60000);
      } catch (error) {
        if (error.cause?.killed) throw error;
        await fs.unlink(output).catch(() => {});
        format = null;
      }
    }
    if (!format) {
      format = ["m4a", "audio/mp4"];
      output = path.join(directory, `part-${partIndex + 1}.m4a`);
      await runTool("ffmpeg", [...inputArgs, "-c:a", "aac", "-b:a", "96k", "-ac", "1", output], 90000);
    }
    const prepared = await probeMedia(output, { timeoutMs: 10000 });
    if (prepared.duration_seconds > MAX_AUDIO_SECONDS || (await fs.stat(output)).size === 0) {
      throw new Error(`Prepared audio chunk exceeds the safe duration limit: ${prepared.duration_seconds}s`);
    }
    return await useChunk({
      path: output,
      filename: path.basename(output),
      content_type: format[1],
      duration_seconds: prepared.duration_seconds,
    });
  } finally {
    // Only the unique mkdtemp directory belongs to this invocation. Never touch the source.
    await fs.rm(directory, { recursive: true, force: true }).catch((error) => {
      console.warn("[media-chunks] temporary cleanup failed", error.message);
    });
  }
}

function appendChunkSegments(previous, incoming, part, split) {
  return [...previous, ...incoming.map((segment) => ({
    ...segment,
    start: Math.round((segment.start + part.offset_seconds) * 1000) / 1000,
    end: Math.round((segment.end + part.offset_seconds) * 1000) / 1000,
    // Diarization IDs are local to each request; matching IDs do not establish identity.
    speaker: split && segment.speaker != null ? `part${part.index + 1}:${segment.speaker}` : segment.speaker,
  }))];
}

module.exports = {
  MAX_AUDIO_SECONDS,
  appendChunkSegments,
  binaryPath,
  buildMediaPlan,
  isAppMediaUrl,
  probeMedia,
  runTool,
  withMediaChunk,
};
