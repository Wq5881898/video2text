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

let pollTimer = null;
let lastResult = null;

function jobIdFromPath() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function renderStatus(payload) {
  const status = document.getElementById("job-status");
  const stage = document.getElementById("job-stage");
  const jobId = document.getElementById("job-id");
  const updated = document.getElementById("job-updated");
  const message = document.getElementById("job-message");
  const log = document.getElementById("job-log");
  const jobCard = document.getElementById("job-card");

  jobId.textContent = payload.job_id || jobIdFromPath();
  status.textContent = payload.status || "Unknown";
  stage.textContent = payload.stage || "Unknown";
  updated.textContent = payload.updated_at || "-";
  message.textContent = payload.message || "The job is still running.";
  log.textContent = JSON.stringify(payload, null, 2);
  jobCard.classList.toggle("status-error", payload.status === "failed");
}

function renderResult(payload) {
  const actions = document.getElementById("job-actions");
  const preview = document.getElementById("result-preview");
  const previewText = document.getElementById("result-preview-text");
  lastResult = payload;
  actions.hidden = false;
  preview.hidden = false;
  previewText.textContent = (payload.output_text || "")
    .split(/\r?\n/)
    .slice(0, 8)
    .join("\n");
}

function stopPolling() {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

async function refreshJob() {
  const id = jobIdFromPath();
  if (!id) {
    renderStatus({
      status: "failed",
      stage: "invalid_job_id",
      message: "No job ID was found in the page URL.",
      job_id: "-",
      updated_at: "-",
    });
    return;
  }

  const statusResponse = await fetchJson(
    `../api/jobs-status?job_id=${encodeURIComponent(id)}`,
  );
  if (!statusResponse.ok || !statusResponse.payload?.ok) {
    renderStatus({
      status: "failed",
      stage: "status_lookup_failed",
      message: statusResponse.payload?.error || "Could not load job status.",
      job_id: id,
      updated_at: "-",
    });
    return;
  }

  renderStatus(statusResponse.payload);

  if (statusResponse.payload.status === "completed") {
    const resultResponse = await fetchJson(
      `../api/jobs-result?job_id=${encodeURIComponent(id)}`,
    );
    if (resultResponse.ok && resultResponse.payload?.ok) {
      renderResult(resultResponse.payload);
    }
    stopPolling();
    return;
  }

  if (statusResponse.payload.status === "failed") {
    stopPolling();
    return;
  }

  stopPolling();
  pollTimer = window.setTimeout(refreshJob, 3000);
}

function downloadLastResult() {
  if (!lastResult?.output_text || !lastResult?.output_filename) {
    return;
  }
  const blob = new Blob([lastResult.output_text], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = lastResult.output_filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

document
  .getElementById("download-result")
  .addEventListener("click", downloadLastResult);
refreshJob();
