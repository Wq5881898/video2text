const { waitUntil } = require("@vercel/functions");
const {
  jobResultPath,
  jobWorkPath,
  readJson,
  renderJobResult,
  triggerJobContinuation,
  translateWorkBatch,
  updateJobStatus,
  verifyJobWorkerSignature,
  writeJson,
} = require("./jobs-lib");

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

  try {
    const work = await readJson(jobWorkPath(jobId));
    if (!work) {
      res.status(404).json({ ok: false, error: "job work checkpoint not found" });
      return;
    }
    const currentIndex = Math.max(0, Number(work.next_index) || 0);
    if (currentIndex !== requestedIndex) {
      res.status(200).json({
        ok: true,
        status: "stale_continuation_ignored",
        next_index: currentIndex,
      });
      return;
    }

    const total = work.segments_en.length;
    await updateJobStatus(jobId, {
      status: "processing",
      stage: "translating",
      message: `Translating subtitle segments ${currentIndex + 1}-${Math.min(currentIndex + 20, total)} of ${total}.`,
      request: work.job,
      progress: { completed: currentIndex, total },
    });

    const updated = await translateWorkBatch(work);
    await writeJson(jobWorkPath(jobId), updated);
    const nextIndex = updated.next_index;
    if (nextIndex >= total) {
      const result = renderJobResult(
        updated.job,
        updated.segments_en,
        updated.segments_zh,
      );
      await writeJson(jobResultPath(jobId), {
        job_id: jobId,
        completed_at: new Date().toISOString(),
        ...result,
      });
      await updateJobStatus(jobId, {
        status: "completed",
        stage: "done",
        message: "Transcript is ready.",
        request: updated.job,
        progress: { completed: total, total },
        result: {
          output_filename: result.output_filename,
          segment_count: result.segment_count,
          translated: result.translated,
          media_type: result.media_type,
        },
      });
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
    waitUntil(
      triggerJobContinuation(jobId, nextIndex).catch(async (error) => {
        console.error("[jobs-continue] unable to trigger next batch", {
          jobId,
          nextIndex,
          error: error instanceof Error ? error.message : String(error),
        });
        await updateJobStatus(jobId, {
          status: "processing",
          stage: "translation_paused",
          message: "The next translation batch could not start automatically.",
          request: updated.job,
          progress: { completed: nextIndex, total },
        });
      }),
    );
    res.status(200).json({ ok: true, status: "continued", next_index: nextIndex });
  } catch (error) {
    console.error("[jobs-continue] translation batch failed", {
      jobId,
      requestedIndex,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    await updateJobStatus(jobId, {
      status: "failed",
      stage: "translation_failed",
      message: "Translation failed before the next checkpoint was saved.",
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ ok: false, error: "translation batch failed" });
  }
};
