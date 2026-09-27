import * as tus from "tus-js-client";

const CHUNK_SIZE = 50 * 1024 * 1024;
const TICKET_PREFIX = "video2text:nas-ticket:";

function ticketStorageKey(file) {
  return `${TICKET_PREFIX}${file.name}:${file.size}:${file.lastModified}`;
}

function readSavedTicket(file) {
  try {
    const raw = window.localStorage.getItem(ticketStorageKey(file));
    if (!raw) return null;
    const ticket = JSON.parse(raw);
    if (!ticket?.upload_token || !ticket?.job_id || ticket.expires_at * 1000 <= Date.now()) {
      window.localStorage.removeItem(ticketStorageKey(file));
      return null;
    }
    return ticket;
  } catch {
    return null;
  }
}

function saveTicket(file, ticket) {
  try {
    window.localStorage.setItem(ticketStorageKey(file), JSON.stringify(ticket));
  } catch {
    // Upload still works when Safari private mode blocks persistent storage.
  }
}

function clearTicket(file) {
  try {
    window.localStorage.removeItem(ticketStorageKey(file));
  } catch {
    // Nothing to clear when persistent storage is unavailable.
  }
}

async function requestTicket(file, options) {
  const response = await fetch("/api/nas-ticket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      file_name: file.name,
      file_size: file.size,
      content_type: file.type || "application/octet-stream",
      output_format: options.outputFormat,
      translate: options.translate,
      source_language: options.sourceLanguage || "auto",
      translation_provider: options.translationProvider || "minimax",
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || "Could not create the NAS upload ticket.");
  }
  saveTicket(file, payload);
  return payload;
}

export function isNasPreviewMode() {
  const params = new URLSearchParams(window.location.search);
  return window.location.pathname === "/nas" || params.get("storage") === "nas";
}

export async function uploadFileToNas(file, options) {
  const ticket = readSavedTicket(file) || await requestTicket(file, options);
  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: ticket.upload_endpoint,
      chunkSize: CHUNK_SIZE,
      retryDelays: [0, 1_000, 3_000, 5_000, 10_000],
      removeFingerprintOnSuccess: true,
      headers: { "X-Upload-Token": ticket.upload_token },
      metadata: {
        filename: file.name,
        filetype: file.type || "application/octet-stream",
        job_id: ticket.job_id,
      },
      onError(error) {
        reject(error);
      },
      onProgress(bytesUploaded, bytesTotal) {
        const percentage = bytesTotal ? (bytesUploaded / bytesTotal) * 100 : 0;
        options.onProgress?.({ bytesUploaded, bytesTotal, percentage });
      },
      onSuccess() {
        clearTicket(file);
        resolve(ticket);
      },
    });

    upload.findPreviousUploads()
      .then((previousUploads) => {
        if (previousUploads.length > 0) {
          upload.resumeFromPreviousUpload(previousUploads[0]);
          options.onResume?.();
        }
        upload.start();
      })
      .catch((error) => {
        options.onResumeUnavailable?.(error);
        upload.start();
      });
  });
}
