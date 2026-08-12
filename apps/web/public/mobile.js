import { upload as uploadToBlob } from "@vercel/blob/client";

const UPLOAD_STALL_TIMEOUT_MS = 45_000;
const UPLOAD_ATTEMPTS = 2;

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { ok: response.ok, raw_text: text };
  }
  return { ok: response.ok, status: response.status, payload };
}

function updateSelectedFileLabel() {
  const sourceFile = document.getElementById("source-file");
  const selectedFile = document.getElementById("selected-file");
  const file = sourceFile.files?.[0];
  selectedFile.textContent = file
    ? `${file.name} (${Math.round(file.size / 1024)} KB)`
    : "No file selected";
}

function syncMutualExclusion(mode = "none") {
  const uploadCard = document.getElementById("upload-card");
  const urlCard = document.getElementById("url-card");
  const sourceFile = document.getElementById("source-file");
  const sourceUrl = document.getElementById("source-url");

  if (mode === "upload") {
    sourceUrl.value = "";
    sourceUrl.disabled = true;
    sourceFile.disabled = false;
    uploadCard.classList.add("is-active");
    uploadCard.classList.remove("is-inactive");
    urlCard.classList.remove("is-active");
    urlCard.classList.add("is-inactive");
    return;
  }

  if (mode === "url") {
    sourceFile.value = "";
    sourceFile.disabled = true;
    sourceUrl.disabled = false;
    updateSelectedFileLabel();
    urlCard.classList.add("is-active");
    urlCard.classList.remove("is-inactive");
    uploadCard.classList.remove("is-active");
    uploadCard.classList.add("is-inactive");
    return;
  }

  sourceFile.disabled = false;
  sourceUrl.disabled = false;
  uploadCard.classList.add("is-active");
  urlCard.classList.add("is-active");
  uploadCard.classList.remove("is-inactive");
  urlCard.classList.remove("is-inactive");
}

function wireDropzone() {
  const dropzone = document.getElementById("upload-field");
  const sourceFile = document.getElementById("source-file");
  const sourceUrl = document.getElementById("source-url");
  const dragEvents = ["dragenter", "dragover", "dragleave", "drop"];
  for (const eventName of dragEvents) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  }
  for (const eventName of ["dragenter", "dragover"]) {
    dropzone.addEventListener(eventName, () =>
      dropzone.classList.add("is-dragover"),
    );
  }
  for (const eventName of ["dragleave", "drop"]) {
    dropzone.addEventListener(eventName, () =>
      dropzone.classList.remove("is-dragover"),
    );
  }
  dropzone.addEventListener("drop", (event) => {
    const files = event.dataTransfer?.files;
    if (!files?.length) {
      return;
    }
    sourceFile.files = files;
    updateSelectedFileLabel();
    syncMutualExclusion("upload");
  });
  sourceFile.addEventListener("change", () => {
    updateSelectedFileLabel();
    if (sourceFile.files?.length) {
      syncMutualExclusion("upload");
    } else if (!sourceUrl.value.trim()) {
      syncMutualExclusion("none");
    }
  });
  sourceUrl.addEventListener("input", () => {
    if (sourceUrl.value.trim()) {
      syncMutualExclusion("url");
    } else if (!sourceFile.files?.length) {
      syncMutualExclusion("none");
    }
  });
  updateSelectedFileLabel();
  syncMutualExclusion("none");
}

function appendLog(message) {
  const log = document.getElementById("transcribe-output");
  const stamp = new Date().toLocaleTimeString();
  const lines = log.textContent ? `${log.textContent}\n` : "";
  log.textContent = `${lines}[${stamp}] ${message}`;
}

function showProgress(message) {
  const panel = document.getElementById("result-panel");
  const summary = document.getElementById("result-summary");
  panel.hidden = false;
  summary.innerHTML = `
    <div class="result-card">
      <div class="result-grid">
        <div><strong>Status</strong><span>Submitting</span></div>
      </div>
      <p class="result-message">${message}</p>
    </div>
  `;
  appendLog(message);
}

async function uploadFileWithRetry(sourceFile) {
  let lastError;

  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    const abortController = new AbortController();
    let stallTimer;
    const resetStallTimer = () => {
      window.clearTimeout(stallTimer);
      stallTimer = window.setTimeout(
        () => abortController.abort("Upload made no progress for 45 seconds."),
        UPLOAD_STALL_TIMEOUT_MS,
      );
    };

    try {
      showProgress(
        attempt === 1
          ? "Starting secure upload to cloud storage."
          : "The first upload stalled. Retrying once...",
      );
      resetStallTimer();
      const blob = await uploadToBlob(sourceFile.name, sourceFile, {
        access: "public",
        handleUploadUrl: "./api/blob-upload",
        multipart: sourceFile.size > 100 * 1024 * 1024,
        abortSignal: abortController.signal,
        onUploadProgress(progress) {
          resetStallTimer();
          showProgress(
            `Uploading your file: ${Math.round(progress.percentage)}% (${progress.loaded}/${progress.total})`,
          );
        },
      });
      window.clearTimeout(stallTimer);
      return blob;
    } catch (error) {
      window.clearTimeout(stallTimer);
      lastError = error;
      appendLog(
        `Upload attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw lastError || new Error("Upload failed after two attempts.");
}

async function submitMobileJob(event) {
  event.preventDefault();
  const sourceFile = document.getElementById("source-file").files[0];
  const sourceUrl = document.getElementById("source-url").value.trim();
  const outputFormat = document.getElementById("output-format").value;
  const translate = document.getElementById("translate").checked;

  document.getElementById("transcribe-output").textContent = "";

  try {
    let payload;
    if (sourceFile) {
      showProgress(`Preparing upload for ${sourceFile.name} (${sourceFile.size} bytes).`);
      const blob = await uploadFileWithRetry(sourceFile);
      showProgress(`Upload complete. Blob URL received for ${sourceFile.name}.`);
      payload = {
        source_url: blob.url,
        file_name: sourceFile.name,
        output_format: outputFormat,
        translate,
        media_type: "audio",
      };
    } else {
      if (!sourceUrl) {
        throw new Error("Choose a local file or enter a media URL.");
      }
      showProgress("Creating a background transcription job from your URL.");
      payload = {
        source_url: sourceUrl,
        file_name: sourceUrl.split("/").pop() || "media",
        output_format: outputFormat,
        translate,
        media_type: "audio",
      };
    }

    showProgress("Submitting job request to /api/jobs-create.");
    const result = await fetchJson("./api/jobs-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!result.ok || !result.payload?.ok || !result.payload?.job_url) {
      throw new Error(
        result.payload?.error || "Could not create the background job.",
      );
    }

    showProgress(`Job created. Redirecting to ${result.payload.job_url}.`);
    window.location.href = result.payload.job_url;
  } catch (error) {
    showProgress(
      error instanceof Error
        ? `Upload flow failed: ${error.message}`
        : "The background job could not be created.",
    );
  }
}

document
  .getElementById("mobile-form")
  .addEventListener("submit", submitMobileJob);
wireDropzone();
