const { buildMediaPlan, isAppMediaUrl, probeMedia } = require("./media-chunks");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const sourceUrl = String(body?.source_url || "");
    if (!isAppMediaUrl(sourceUrl)) {
      // No network request is made for arbitrary URLs, redirects or internal hosts.
      res.status(200).json({ ok: true, splitting_supported: false, split_required: false });
      return;
    }
    const plan = buildMediaPlan(await probeMedia(sourceUrl));
    console.log("[media-info] audio inspected", { duration_seconds: plan.duration_seconds, parts: plan.parts.length });
    res.status(200).json({
      ok: true,
      splitting_supported: true,
      duration_seconds: plan.duration_seconds,
      split_required: plan.split,
      part_count: plan.parts.length,
    });
  } catch (error) {
    console.error("[media-info] inspection failed", error.message);
    res.status(400).json({ ok: false, error: error.message });
  }
};
