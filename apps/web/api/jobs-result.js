const { jobResultPath, readJson } = require("./jobs-lib");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const jobId = String(req.query.job_id || "").trim();
  if (!jobId) {
    res.status(400).json({ ok: false, error: "job_id is required" });
    return;
  }

  const payload = await readJson(jobResultPath(jobId));
  if (!payload) {
    res.status(404).json({ ok: false, error: "result not ready" });
    return;
  }

  res.status(200).json({ ok: true, ...payload });
};
