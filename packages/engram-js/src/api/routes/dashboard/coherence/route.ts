/*
 - filename: packages/engram-js/src/api/routes/dashboard/coherence/route.ts
 - what is the file used for: coherence dashboard endpoints — the one-time
   legacy LINK BACKFILL (SQL-only, idempotent related_to edges between
   similar active memories; no LLM, no content mutation).
*/

import { fail } from "../../_kit";
import { linkBackfill } from "../../../../services/clusterEngine";

export const dashboard_coherence_route = (app: any) => {
  app.post("/api/dashboard/coherence/link-backfill", async (req: any, res: any) => {
    try {
      const limit = req.query?.limit !== undefined ? Number(req.query.limit) : undefined;
      const minSim = req.query?.min_sim !== undefined ? Number(req.query.min_sim) : undefined;
      const result = await linkBackfill({
        ...(Number.isFinite(limit) && limit ? { limit } : {}),
        ...(Number.isFinite(minSim) && minSim ? { minSim } : {}),
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      fail(res, "link_backfill_failed", e);
    }
  });
};
