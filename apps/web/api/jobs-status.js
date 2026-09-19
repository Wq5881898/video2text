const { waitUntil } = require("@vercel/functions");
const {
  continuationCursor,
  jobResultPath,
  jobStatusPath,
  jobWorkPath,
  readJson,
  triggerJobContinuation,
  updateJobStatus,
} = require("./jobs-lib");

function continuationIsStale(payload) {
  const age = Date.now() - new Date(payload.updated_at || 0).getTime();
  if (payload?.status === "queued") return age > 60_000;
  if (payload?.status !== "processing") return false;
  if (["translation_paused", "transcription_paused"].includes(payload.stage)) {
    return true;
  }
  if (
    [
      "translation_checkpoint",
      "translation_resuming",
      "transcription_checkpoint",
      "transcription_resuming",
      "transcription_done",
    ].includes(payload.stage)
  ) {
    return age > 60_000;
  }
  return ["translating", "poll_transcription", "prepare_audio", "upload_to_gladia", "submit_transcription"].includes(payload.stage) && age > 360_000;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const jobId = String(req.query.job_id || "").trim();
  if (!jobId) {
    res.status(400).json({ ok: false, error: "job_id is required" });
    return;
  }

  try {
    const [payload, resultPayload] = await Promise.all([
      readJson(jobStatusPath(jobId)),
      readJson(jobResultPath(jobId)),
    ]);
    if (resultPayload) {
      res.status(200).json({
        ok: true,
        ...(payload || { job_id: jobId }),
        status: "completed",
        stage: "done",
        message: "Transcript is ready.",
        result: {
          output_filename: resultPayload.output_filename,
          segment_count: resultPayload.segment_count,
          translated: resultPayload.translated,
          media_type: resultPayload.media_type,
        },
        completed_at: resultPayload.completed_at,
      });
      return;
    }
    if (!payload) {
      res.status(404).json({ ok: false, error: "job status is not visible yet" });
      return;
    }
    if (continuationIsStale(payload)) {
      const work = await readJson(jobWorkPath(jobId));
      if (work) {
        if (Number(work.worker_lease?.expires_at) > Date.now()) {
          res.status(200).json({ ok: true, ...payload });
          return;
        }
        const nextIndex = continuationCursor(work);
        const total = Array.isArray(work.segments_en) ? work.segments_en.length : 0;
        const transcribing = work.stage === "transcribing";
        const resumedPayload = {
          ...payload,
          updated_at: new Date().toISOString(),
          status: "processing",
          stage: transcribing ? "transcription_resuming" : "translation_resuming",
          message: transcribing
            ? "Restarting transcription polling from the saved cloud job."
            : "Restarting translation from the last saved checkpoint.",
          ...(transcribing ? {} : { progress: { completed: nextIndex, total } }),
        };
        await updateJobStatus(jobId, resumedPayload);
        waitUntil(
          triggerJobContinuation(jobId, nextIndex).catch(async (error) => {
            console.error("[jobs-status] continuation restart failed", {
              jobId,
              nextIndex,
              error: error instanceof Error ? error.message : String(error),
            });
            await updateJobStatus(jobId, {
              ...resumedPayload,
              stage: transcribing ? "transcription_paused" : "translation_paused",
              message: transcribing
                ? "Transcription polling restart failed temporarily; the task page will retry."
                : "Translation restart failed temporarily; the task page will retry.",
            });
          }),
        );
        res.status(200).json({ ok: true, ...resumedPayload });
        return;
      }
    }
    res.status(200).json({ ok: true, ...payload });
  } catch (error) {
    console.error("[jobs-status] lookup failed", {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(503).json({
      ok: false,
      error: "Job status storage is temporarily unavailable. Retrying is safe.",
    });
  }
};
