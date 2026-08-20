/*
 - filename: packages/engram-js/src/api/routes/dashboard/outcome/route.ts
 - what is the file used for: outcome-aware memory endpoints — stats, backfill.
*/

import { fail } from "../../_kit";
import { backfillOutcomes } from "../../../../services/outcomeTracker";

export const dashboard_outcome_route = (app: any) => {
  // Backfill outcome stats from historical traces
  app.post("/api/dashboard/outcome/backfill", async (req: any, res: any) => {
    try {
      const days = req.body?.days !== undefined ? Number(req.body.days) : 30;
      const count = await backfillOutcomes(days);
      res.json({ ok: true, traces_processed: count });
    } catch (e) {
      fail(res, "outcome_backfill_failed", e);
    }
  });

  // Outcome stats summary
  app.get("/api/dashboard/outcome/status", async (_req: any, res: any) => {
    try {
      const { all_async } = require("../../../../database/connection");
      const rows = await all_async(
        `SELECT
           count(*) FILTER (WHERE avg_answer_quality IS NOT NULL)::int AS memories_tracked,
           avg(avg_answer_quality) FILTER (WHERE avg_answer_quality IS NOT NULL) AS overall_avg_quality,
           sum(recall_count)::int AS total_recalls,
           count(*) FILTER (WHERE avg_answer_quality < 0.4 AND recall_count >= 3)::int AS harmful_memories,
           count(*) FILTER (WHERE avg_answer_quality > 0.7 AND recall_count >= 3)::int AS helpful_memories
         FROM public.memories_outcome_stats WHERE window_days = 7`,
        [],
      ).catch(() => [{}]);
      const r = rows[0] || {};
      res.json({
        ok: true,
        enabled: (process.env.EG_OUTCOME_TRACKING_ENABLED ?? "true").toLowerCase() !== "false",
        memories_tracked: r.memories_tracked || 0,
        overall_avg_quality: r.overall_avg_quality ? Number(r.overall_avg_quality).toFixed(3) : null,
        total_recalls: r.total_recalls || 0,
        harmful_memories: r.harmful_memories || 0,
        helpful_memories: r.helpful_memories || 0,
      });
    } catch (e) {
      fail(res, "outcome_status_failed", e);
    }
  });
};
