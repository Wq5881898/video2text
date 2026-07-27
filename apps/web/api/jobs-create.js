const { waitUntil } = require("@vercel/functions");
const {
  jobResultPath,
  jobStatusPath,
  makeJobId,
  processJob,
  updateJobStatus,
  writeJson,
} = require("./jobs-lib");

function readJsonBody(req) {
  if (req.body && typeof req.body !== "string") {
    return Promise.resolve(req.body);
  }
  if (req.body && typeof req.body === "string") {
    return Promise.resolve(JSON.parse(req.body));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const sourceUrl = String(body.source_url || "").trim();
    const fileName = String(body.file_name || "").trim();
    const outputFormat = String(body.output_format || "txt").trim().toLowerCase();
    const translate = Boolean(body.translate);
    const mediaType = String(body.media_type || "audio").trim().toLowerCase();

    if (!sourceUrl) {
      res.status(400).json({ ok: false, error: "source_url is required" });
      return;
    }
    if (!fileName) {
      res.status(400).json({ ok: false, error: "file_name is required" });
      return;
    }
    if (!["txt", "srt"].includes(outputFormat)) {
      res.status(400).json({ ok: false, error: "output_format must be txt or srt" });
      return;
    }

    const jobId = makeJobId();
    const job = {
      job_id: jobId,
      source_url: sourceUrl,
      file_name: fileName,
      output_format: outputFormat,
      translate,
      media_type: mediaType,
      created_at: new Date().toISOString(),
    };

    await updateJobStatus(jobId, {
      status: "queued",
      stage: "queued",
      request: job,
      result_path: jobResultPath(jobId),
      status_path: jobStatusPath(jobId),
    });

    waitUntil((async () => {
      try {
        await updateJobStatus(jobId, { status: "processing", stage: "transcribing", request: job });
        const result = await processJob(job);
        await writeJson(jobResultPath(jobId), {
          job_id: jobId,
          completed_at: new Date().toISOString(),
          ...result,
        });
        await updateJobStatus(jobId, {
          status: "completed",
          stage: "done",
          request: job,
          result: {
            output_filename: result.output_filename,
            segment_count: result.segment_count,
            translated: result.translated,
            media_type: result.media_type,
          },
        });
      } catch (error) {
        await updateJobStatus(jobId, {
          status: "failed",
          stage: "failed",
          request: job,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })());

    res.status(200).json({
      ok: true,
      status: "accepted",
      job_id: jobId,
      status_path: `/api/jobs-status?job_id=${jobId}`,
      result_path: `/api/jobs-result?job_id=${jobId}`,
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
