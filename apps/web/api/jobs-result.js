const { jobResultPath, readJson } = require("./jobs-lib");

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
    const payload = await readJson(jobResultPath(jobId));
    if (!payload) {
      res.status(404).json({ ok: false, error: "result not ready" });
      return;
    }
    res.status(200).json({ ok: true, ...payload });
  } catch (error) {
    console.error("[jobs-result] lookup failed", {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(503).json({
      ok: false,
      error: "Job result storage is temporarily unavailable. Retrying is safe.",
    });
  }
};
