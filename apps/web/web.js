async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
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

async function submitPlaceholder(event) {
  event.preventDefault();
  const output = document.getElementById("transcribe-output");
  const inputMode = document.getElementById("input-mode").value;
  const sourceFile = document.getElementById("source-file").files[0];
  const sourceUrl = document.getElementById("source-url").value.trim();
  const outputFormat = document.getElementById("output-format").value;
  const translate = document.getElementById("translate").checked;
  output.textContent = "Submitting...";

  const body = {
    input_mode: inputMode,
    output_format: outputFormat,
    translate,
  };

  if (inputMode === "upload" && sourceFile) {
    body.file_name = sourceFile.name;
    body.file_size = sourceFile.size;
    body.file_type = sourceFile.type || null;
  }
  if (inputMode === "url") {
    body.source_url = sourceUrl;
  }

  try {
    const result = await fetchJson("./api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    output.textContent = JSON.stringify(
      {
        status: result.status,
        body: result.payload,
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

function syncInputMode() {
  const inputMode = document.getElementById("input-mode").value;
  const uploadField = document.getElementById("upload-field");
  const urlField = document.getElementById("url-field");
  uploadField.hidden = inputMode !== "upload";
  urlField.hidden = inputMode !== "url";
}

document.getElementById("refresh-status").addEventListener("click", refreshStatus);
document.getElementById("transcribe-form").addEventListener("submit", submitPlaceholder);
document.getElementById("input-mode").addEventListener("change", syncInputMode);
syncInputMode();
refreshStatus();
