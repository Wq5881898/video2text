import { upload as uploadToBlob } from "https://esm.sh/@vercel/blob/client?bundle";

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

async function refreshStatus() {
  const output = document.getElementById("status-output");
  output.textContent = "Loading...";
  try {
    const [health, capabilities] = await Promise.all([
      fetchJson("./api/health", { method: "GET" }),
      fetchJson("./api/capabilities", { method: "GET" }),
    ]);
    output.textContent = JSON.stringify(
      {
        health: health.payload,
        capabilities: capabilities.payload,
      },
      null,
      2,
    );
  } catch (error) {
    output.textContent = JSON.stringify(
      {
        ok: false,
        error: String(error),
      },
      null,
      2,
    );
  }
}

let processingTimer = null;
let processingStartedAt = 0;

function stopProcessingTimer() {
  if (processingTimer !== null) {
    window.clearInterval(processingTimer);
    processingTimer = null;
  }
}

function formatElapsedSeconds() {
  if (!processingStartedAt) {
    return "0s";
  }
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - processingStartedAt) / 1000),
  );
  return `${seconds}s`;
}

function renderPendingState(stage = "Preparing request", detail = "") {
  const panel = document.getElementById("result-panel");
  const box = document.getElementById("result-summary");
  const actions = document.getElementById("result-actions");
  const preview = document.getElementById("result-preview");
  panel.hidden = false;
  actions.hidden = true;
  preview.hidden = true;
  box.innerHTML = `
    <div class="result-card">
      <div class="result-grid">
        <div><strong>Status</strong><span>Processing</span></div>
        <div><strong>Stage</strong><span>${stage}</span></div>
        <div><strong>Elapsed</strong><span>${formatElapsedSeconds()}</span></div>
      </div>
      <p class="result-message">${detail || "Processing your media. This can take a little while for longer files."}</p>
    </div>
  `;
}

function startProcessingTimer(stage, detail) {
  processingStartedAt = Date.now();
  stopProcessingTimer();
  processingTimer = window.setInterval(() => {
    renderPendingState(stage, detail);
  }, 1000);
}

function updateProcessingStage(stage, detail = "") {
  renderPendingState(stage, detail);
}

function renderResultSummary(payload, sourceKind) {
  const panel = document.getElementById("result-panel");
  const box = document.getElementById("result-summary");
  const actions = document.getElementById("result-actions");
  const preview = document.getElementById("result-preview");
  const previewText = document.getElementById("result-preview-text");
  panel.hidden = false;
  stopProcessingTimer();

  if (!payload?.ok || !payload?.result) {
    const message =
      payload?.message || payload?.error || "The request did not complete.";
    box.innerHTML = `
      <div class="result-card status-error">
        <div class="result-grid">
          <div><strong>Status</strong><span>Failed</span></div>
          <div><strong>Source</strong><span>${sourceKind === "upload" ? "Local file" : sourceKind === "url" ? "URL" : "Unknown"}</span></div>
        </div>
        <p class="result-message">${message}</p>
      </div>
    `;
    actions.hidden = true;
    preview.hidden = true;
    return;
  }

  const result = payload.result;
  const previewLines = (result.output_text || "")
    .split(/\r?\n/)
    .slice(0, 8)
    .join("\n");
  window.__video2textLastResult = result;
  box.innerHTML = `
    <div class="result-card">
      <div class="result-grid">
        <div><strong>Status</strong><span>Completed</span></div>
        <div><strong>Source</strong><span>${sourceKind === "upload" ? "Local file" : "URL"}</span></div>
        <div><strong>Output</strong><span>${result.output_filename}</span></div>
        <div><strong>Translation</strong><span>${result.translated ? "On" : "Off"}</span></div>
      </div>
      <p class="result-message">Your transcript is ready. Preview it below or download the full result.</p>
    </div>
  `;
  previewText.textContent = previewLines || "Preview unavailable.";
  actions.hidden = false;
  preview.hidden = false;
}

async function submitPlaceholder(event) {
  event.preventDefault();
  const output = document.getElementById("transcribe-output");
  const sourceFile = document.getElementById("source-file").files[0];
  const sourceUrl = document.getElementById("source-url").value.trim();
  const outputFormat = document.getElementById("output-format").value;
  const translate = document.getElementById("translate").checked;
  window.__video2textLastResult = null;
  output.textContent = "Starting request...";
  startProcessingTimer(
    "Preparing request",
    "Checking your input and preparing the cloud request.",
  );

  try {
    let result;
    if (sourceFile) {
      updateProcessingStage(
        "Uploading file",
        "Uploading your media to cloud storage before transcription starts.",
      );
      output.textContent = "Uploading media to cloud storage...";
      const blob = await uploadToBlob(sourceFile.name, sourceFile, {
        access: "public",
        handleUploadUrl: "./api/blob-upload",
        multipart: sourceFile.size > 5_000_000,
        onUploadProgress(progress) {
          updateProcessingStage(
            "Uploading file",
            `Uploaded ${Math.round(progress.percentage)}% of your file.`,
          );
          output.textContent = JSON.stringify(
            {
              stage: "blob_upload",
              file_name: sourceFile.name,
              file_size: sourceFile.size,
              uploaded: progress.loaded,
              total: progress.total,
              percentage: progress.percentage,
            },
            null,
            2,
          );
        },
      });
      updateProcessingStage(
        "Transcribing",
        "Upload completed. The cloud runtime is transcribing your media now.",
      );
      output.textContent = "Blob upload completed. Starting transcription...";
      result = await fetchJson("./api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input_mode: "url",
          source_url: blob.url,
          file_name: sourceFile.name,
          output_format: outputFormat,
          translate,
        }),
      });
    } else {
      if (!sourceUrl) {
        throw new Error("Choose a local file or enter a media URL.");
      }
      updateProcessingStage(
        "Transcribing",
        "The cloud runtime is downloading and transcribing your source URL.",
      );
      output.textContent = "Transcribing from source URL...";
      result = await fetchJson("./api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input_mode: "url",
          source_url: sourceUrl,
          output_format: outputFormat,
          translate,
        }),
      });
    }

    output.textContent = JSON.stringify(
      { status: result.status, body: result.payload },
      null,
      2,
    );
    renderResultSummary(result.payload, sourceFile ? "upload" : "url");
  } catch (error) {
    output.textContent = JSON.stringify(
      {
        ok: false,
        error: String(error),
      },
      null,
      2,
    );
    renderResultSummary(
      {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      },
      sourceFile ? "upload" : sourceUrl ? "url" : "none",
    );
  }
}

function downloadLastResult() {
  const result = window.__video2textLastResult;
  if (!result?.output_text || !result?.output_filename) {
    return;
  }
  const blob = new Blob([result.output_text], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = result.output_filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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

document
  .getElementById("refresh-status")
  .addEventListener("click", refreshStatus);
document
  .getElementById("transcribe-form")
  .addEventListener("submit", submitPlaceholder);
document
  .getElementById("download-result")
  .addEventListener("click", downloadLastResult);
wireDropzone();
refreshStatus();
