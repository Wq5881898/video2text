const fs = require("node:fs/promises");
const path = require("node:path");
const { upload } = require("@vercel/blob/client");

const DEFAULT_BASE_URL = "https://web-iota-one-31.vercel.app";
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

function readArguments(argv) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    minSegments: 1,
    reportPath: "",
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--file") options.filePath = argv[++index];
    else if (value === "--base-url") options.baseUrl = argv[++index];
    else if (value === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (value === "--min-segments") options.minSegments = Number(argv[++index]);
    else if (value === "--report") options.reportPath = argv[++index];
    else if (value.startsWith("--")) throw new Error(`Unknown argument: ${value}`);
    else positional.push(value);
  }

  // npm on Windows can remove option names after `--`, so accept the same
  // values positionally: file, minimum segments, timeout, report, base URL.
  if (!options.filePath && positional[0]) options.filePath = positional[0];
  if (positional[1]) options.minSegments = Number(positional[1]);
  if (positional[2]) options.timeoutMs = Number(positional[2]);
  if (positional[3]) options.reportPath = positional[3];
  if (positional[4]) options.baseUrl = positional[4];

  if (!options.filePath) {
    throw new Error(
      "Missing file. Example: npm run test:cloud -- C:\\media\\sample.m4a 21",
    );
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }
  if (!Number.isInteger(options.minSegments) || options.minSegments <= 0) {
    throw new Error("--min-segments must be a positive integer");
  }

  options.baseUrl = options.baseUrl.replace(/\/$/, "");
  return options;
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
  }[extension] || "application/octet-stream";
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function log(message, details) {
  const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
  process.stdout.write(`[${new Date().toISOString()}] ${message}${suffix}\n`);
}

async function fetchJson(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        cache: "no-store",
        headers: {
          "Cache-Control": "no-cache",
          ...(options.headers || {}),
        },
      });
      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`HTTP ${response.status} returned non-JSON: ${text.slice(0, 300)}`);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${payload.error || payload.message || text}`);
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(attempt * 500);
    }
  }
  throw lastError;
}

async function run() {
  const options = readArguments(process.argv.slice(2));
  const startedAt = Date.now();
  const absoluteFilePath = path.resolve(options.filePath);
  const bytes = await fs.readFile(absoluteFilePath);
  const fileName = path.basename(absoluteFilePath);
  const uploadPath = `uploads/e2e-${Date.now()}-${fileName}`;
  const report = {
    base_url: options.baseUrl,
    file: { name: fileName, bytes: bytes.length },
    started_at: new Date(startedAt).toISOString(),
    transitions: [],
  };

  log("Uploading through the production Blob client flow", {
    file: fileName,
    bytes: bytes.length,
  });
  const uploadStartedAt = Date.now();
  const blob = await upload(uploadPath, new Blob([bytes], {
    type: contentTypeFor(absoluteFilePath),
  }), {
    access: "public",
    handleUploadUrl: `${options.baseUrl}/api/blob-upload`,
    multipart: bytes.length > 100 * 1024 * 1024,
  });
  report.upload_ms = Date.now() - uploadStartedAt;
  report.blob_url = blob.url;
  log("Blob upload completed", { upload_ms: report.upload_ms });

  const createStartedAt = Date.now();
  const created = await fetchJson(`${options.baseUrl}/api/jobs-create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source_url: blob.url,
      file_name: fileName,
      output_format: "txt",
      translate: true,
      media_type: "audio",
    }),
  });
  if (!created.ok || !created.job_id || !created.job_url) {
    throw new Error(`Invalid jobs-create response: ${JSON.stringify(created)}`);
  }
  report.create_ms = Date.now() - createStartedAt;
  report.job_id = created.job_id;
  report.job_url = new URL(created.job_url, options.baseUrl).href;
  log("Background job created", {
    job_id: report.job_id,
    job_url: report.job_url,
    create_ms: report.create_ms,
  });

  const pageResponse = await fetch(report.job_url, { cache: "no-store" });
  if (!pageResponse.ok) {
    throw new Error(`Job page returned HTTP ${pageResponse.status}`);
  }

  let lastSignature = "";
  let status;
  while (Date.now() - startedAt < options.timeoutMs) {
    status = await fetchJson(
      `${options.baseUrl}/api/jobs-status?job_id=${encodeURIComponent(report.job_id)}&_=${Date.now()}`,
    );
    const progress = status.progress
      ? `${status.progress.completed}/${status.progress.total}`
      : "";
    const signature = `${status.status}|${status.stage}|${progress}|${status.message}`;
    if (signature !== lastSignature) {
      const transition = {
        elapsed_ms: Date.now() - startedAt,
        status: status.status,
        stage: status.stage,
        progress,
        message: status.message,
      };
      report.transitions.push(transition);
      log("Job transition", transition);
      lastSignature = signature;
    }

    if (status.status === "completed") break;
    if (status.status === "failed") {
      throw new Error(`Job failed at ${status.stage}: ${status.message}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!status || status.status !== "completed") {
    throw new Error(`Timed out after ${options.timeoutMs} ms waiting for completion`);
  }

  const result = await fetchJson(
    `${options.baseUrl}/api/jobs-result?job_id=${encodeURIComponent(report.job_id)}&_=${Date.now()}`,
  );
  const outputText = String(result.output_text || "");
  if (!result.ok || !outputText.trim()) {
    throw new Error(`Result is missing output text: ${JSON.stringify(result)}`);
  }
  if (!result.translated || !/[\u3400-\u9fff]/u.test(outputText)) {
    throw new Error("Result did not contain the requested Chinese translation");
  }
  if (!/[A-Za-z]/.test(outputText)) {
    throw new Error("Result did not preserve the English transcript");
  }
  if (Number(result.segment_count) < options.minSegments) {
    throw new Error(
      `Expected at least ${options.minSegments} segments, received ${result.segment_count}`,
    );
  }

  report.completed_at = new Date().toISOString();
  report.total_ms = Date.now() - startedAt;
  report.result = {
    output_filename: result.output_filename,
    segment_count: result.segment_count,
    translated: result.translated,
    output_chars: outputText.length,
    preview: outputText.slice(0, 300),
  };
  report.passed = true;

  if (options.reportPath) {
    const reportPath = path.resolve(options.reportPath);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    log("Report written", { path: reportPath });
  }

  log("CLOUD E2E PASS", {
    job_id: report.job_id,
    segments: report.result.segment_count,
    total_ms: report.total_ms,
  });
}

run().catch((error) => {
  console.error(`[${new Date().toISOString()}] CLOUD E2E FAIL`, error);
  process.exitCode = 1;
});
