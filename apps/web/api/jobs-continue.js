const { waitUntil } = require("@vercel/functions");
const crypto = require("node:crypto");
const { BlobPreconditionFailedError } = require("@vercel/blob");
const {
  continuationCursor,
  jobResultPath,
  jobWorkPath,
  readJson,
  renderJobResult,
  triggerJobContinuation,
  transcribeWorkWindow,
  translateWorkBatch,
  updateJobStatus,
  verifyJobWorkerSignature,
  writeJson,
} = require("./jobs-lib");

function scheduleContinuation({
  jobId,
  nextIndex,
  work,
  pausedStage,
  pausedMessage,
  progress,
}) {
  waitUntil(
    triggerJobContinuation(jobId, nextIndex).catch(async (error) => {
      console.error("[jobs-continue] unable to trigger next continuation", {
        jobId,
        nextIndex,
        workStage: work.stage,
        error: error instanceof Error ? error.message : String(error),
      });
      await updateJobStatus(jobId, {
        status: "processing",
        stage: pausedStage,
        message: pausedMessage,
        request: work.job,
        ...(progress ? { progress } : {}),
      });
    }),
  );
}

async function completeJob(jobId, work, segmentsZh = null) {
  const result = renderJobResult(work.job, work.segments_en, segmentsZh);
  await writeJson(jobResultPath(jobId), {
    job_id: jobId,
    completed_at: new Date().toISOString(),
    ...result,
  });
  await writeJson(jobWorkPath(jobId), {
    ...work,
    stage: "completed",
    updated_at: new Date().toISOString(),
  });
  await updateJobStatus(jobId, {
    status: "completed",
    stage: "done",
    message: "Transcript is ready.",
    request: work.job,
    progress: {
      completed: work.segments_en.length,
      total: work.segments_en.length,
    },
    result: {
      output_filename: result.output_filename,
      segment_count: result.segment_count,
      translated: result.translated,
      media_type: result.media_type,
    },
  });
  return result;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const jobId = String(body.job_id || "").trim();
  const requestedIndex = Math.max(0, Number(body.next_index) || 0);
  if (!/^job_[a-f0-9]{12}$/.test(jobId)) {
    res.status(400).json({ ok: false, error: "invalid job_id" });
    return;
  }
  if (
    !verifyJobWorkerSignature(
      jobId,
      requestedIndex,
      req.headers["x-video2text-job-signature"],
    )
  ) {
    res.status(401).json({ ok: false, error: "invalid continuation signature" });
    return;
  }

  let work;
  let workEtag;
  let leaseOwned = false;
  async function saveWork(updated) {
    const saved = await writeJson(jobWorkPath(jobId), updated, { ifMatch: workEtag });
    workEtag = saved.etag;
    work = updated;
  }
  async function releaseLease() {
    if (!leaseOwned) return;
    await saveWork({ ...work, worker_lease: null });
    leaseOwned = false;
  }
  try {
    const record = await readJson(jobWorkPath(jobId), { withMetadata: true });
    if (!record) {
      res.status(404).json({ ok: false, error: "job work checkpoint not found" });
      return;
    }
    work = record.value;
    workEtag = record.etag;
    if (work.stage === "completed") {
      res.status(200).json({ ok: true, status: "completed" });
      return;
    }

    const savedIndex = continuationCursor(work);
    if (savedIndex !== requestedIndex) {
      res.status(200).json({
        ok: true,
        status: "stale_continuation_ignored",
        next_index: savedIndex,
      });
      return;
    }

    if (work.stage === "transcribing") {
      if (Number(work.worker_lease?.expires_at) > Date.now()) {
        res.status(200).json({ ok: true, status: "worker_already_running" });
        return;
      }
      if (!workEtag) throw new Error("Checkpoint ETag is missing; refusing a duplicate paid submission");
      await saveWork({
        ...work,
        worker_lease: { id: crypto.randomUUID(), expires_at: Date.now() + 360000 },
      });
      leaseOwned = true;
      const transcription = await transcribeWorkWindow(work, {
        maxIterations: 10,
        onCheckpoint: saveWork,
        onStage: async (stage, message, extra = {}) => updateJobStatus(jobId, {
          status: "processing", stage, message, request: work.job, ...extra,
        }),
      });
      work = transcription.work;
      await releaseLease();
      if (!transcription.done) {
        await updateJobStatus(jobId, {
          status: "processing",
          stage: "transcription_checkpoint",
          message: transcription.prepared
            ? `Audio will be processed in ${work.media_plan.parts.length} part(s).`
            : `Transcribed ${transcription.progress.completed} of ${transcription.progress.total} audio parts. Continuing automatically.`,
          request: work.job,
          gladia_job_id: work.gladia_job_id,
          progress: transcription.progress,
        });
        scheduleContinuation({
          jobId,
          nextIndex: continuationCursor(work),
          work,
          pausedStage: "transcription_paused",
          pausedMessage: "Transcription polling paused temporarily; the task page will retry.",
          progress: transcription.progress,
        });
        res.status(200).json({ ok: true, status: "transcription_continued" });
        return;
      }

      const segmentsEn = work.segments_en;
      await updateJobStatus(jobId, {
        status: "processing",
        stage: "transcription_done",
        message: `Transcript received with ${segmentsEn.length} segments.`,
        request: work.job,
        progress: { completed: 0, total: segmentsEn.length },
      });
      if (!work.job.translate) {
        await completeJob(jobId, work);
        res.status(200).json({ ok: true, status: "completed" });
        return;
      }
    }

    if (work.stage === "rendering" && !work.job.translate) {
      await completeJob(jobId, work);
      res.status(200).json({ ok: true, status: "completed" });
      return;
    }

    const total = work.segments_en.length;
    const currentIndex = Math.max(0, Number(work.next_index) || 0);
    await updateJobStatus(jobId, {
      status: "processing",
      stage: "translating",
      message: `Translating subtitle segments ${currentIndex + 1}-${Math.min(currentIndex + 20, total)} of ${total}.`,
      request: work.job,
      progress: { completed: currentIndex, total },
    });

    const updated = await translateWorkBatch({ ...work, stage: "translating" });
    await writeJson(jobWorkPath(jobId), updated);
    const nextIndex = updated.next_index;
    if (nextIndex >= total) {
      await completeJob(jobId, updated, updated.segments_zh);
      res.status(200).json({ ok: true, status: "completed", next_index: total });
      return;
    }

    await updateJobStatus(jobId, {
      status: "processing",
      stage: "translation_checkpoint",
      message: `Translated ${nextIndex} of ${total} subtitle segments.`,
      request: updated.job,
      progress: { completed: nextIndex, total },
    });
    scheduleContinuation({
      jobId,
      nextIndex,
      work: updated,
      pausedStage: "translation_paused",
      pausedMessage: "The next translation batch could not start automatically.",
      progress: { completed: nextIndex, total },
    });
    res.status(200).json({ ok: true, status: "continued", next_index: nextIndex });
  } catch (error) {
    if (error instanceof BlobPreconditionFailedError) {
      res.status(200).json({ ok: true, status: "worker_already_running" });
      return;
    }
    if (leaseOwned) {
      await releaseLease().catch((releaseError) => console.error("[jobs-continue] lease release failed", releaseError.message));
    }
    const transcribing = work?.stage === "transcribing";
    console.error("[jobs-continue] continuation failed", {
      jobId,
      requestedIndex,
      workStage: work?.stage,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    await updateJobStatus(jobId, {
      status: "failed",
      stage: transcribing ? "transcription_failed" : "translation_failed",
      message: transcribing
        ? "Transcription failed before a checkpoint could be completed."
        : "Translation failed before the next checkpoint was saved.",
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ ok: false, error: "job continuation failed" });
  }
};
