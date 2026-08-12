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
    console.log("[jobs-create] request received", {
      hasSourceUrl: Boolean(body?.source_url),
      fileName: body?.file_name,
      outputFormat: body?.output_format,
      translate: body?.translate,
      mediaType: body?.media_type,
    });

    const sourceUrl = String(body.source_url || "").trim();
    const fileName = String(body.file_name || "").trim();
    const outputFormat = String(body.output_format || "txt")
      .trim()
      .toLowerCase();
    const translate = Boolean(body.translate);
    const mediaType = String(body.media_type || "audio")
      .trim()
      .toLowerCase();

    if (!sourceUrl) {
      res.status(400).json({ ok: false, error: "source_url is required" });
      return;
    }
    if (!fileName) {
      res.status(400).json({ ok: false, error: "file_name is required" });
      return;
    }
    if (!["txt", "srt"].includes(outputFormat)) {
      res
        .status(400)
        .json({ ok: false, error: "output_format must be txt or srt" });
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

    console.log("[jobs-create] job accepted", { jobId, fileName, outputFormat, translate });

    await updateJobStatus(jobId, {
      status: "queued",
      stage: "queued",
      request: job,
      result_path: jobResultPath(jobId),
      status_path: jobStatusPath(jobId),
    });

    waitUntil(
      (async () => {
        try {
          await updateJobStatus(jobId, {
            status: "processing",
            stage: "preparing",
            message: "Preparing job on the cloud runtime.",
            request: job,
          });
          const result = await processJob(job, {
            onStage: async (stage, message, extra = {}) => {
              await updateJobStatus(jobId, {
                status: "processing",
                stage,
                message,
                request: job,
                ...extra,
              });
            },
          });
          await writeJson(jobResultPath(jobId), {
            job_id: jobId,
            completed_at: new Date().toISOString(),
            ...result,
          });
          await updateJobStatus(jobId, {
            status: "completed",
            stage: "done",
            message: "Transcript is ready.",
            request: job,
            result: {
              output_filename: result.output_filename,
              segment_count: result.segment_count,
              translated: result.translated,
              media_type: result.media_type,
            },
          });
          console.log("[jobs-create] job completed", { jobId, output: result.output_filename });
        } catch (error) {
          console.error("[jobs-create] background processing failed", {
            jobId,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
          await updateJobStatus(jobId, {
            status: "failed",
            stage: "failed",
            message: "The job failed before a result was produced.",
            request: job,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })(),
    );

    res.status(200).json({
      ok: true,
      status: "accepted",
      job_id: jobId,
      job_url: `/jobs/${jobId}`,
      status_path: `/api/jobs-status?job_id=${jobId}`,
      result_path: `/api/jobs-result?job_id=${jobId}`,
    });
  } catch (error) {
    console.error("[jobs-create] request failed", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
