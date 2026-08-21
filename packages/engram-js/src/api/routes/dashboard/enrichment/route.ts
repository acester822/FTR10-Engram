/*
 - filename: packages/engram-js/src/api/routes/dashboard/enrichment/route.ts
 - what is the file used for: memory optimization (enrichment) engine endpoints —
   manual run + status.
*/

import { fail } from "../../_kit";
import { runEnrichment, enrichmentLastRun, enrichmentEnabled, enrichmentAction } from "../../../../services/enrichmentEngine";

export const dashboard_enrichment_route = (app: any) => {
  app.post("/api/dashboard/enrichment/run", async (req: any, res: any) => {
    try {
      // v5.0.2: optional one-time backfill sweep — ?sweep=1&batch=N (N ≤ 50).
      // Processes N candidates per invocation and marks swept-but-unactionable
      // memories so repeated invocations advance through the store. Omit the
      // params for the normal scheduled-style run (unchanged).
      const q = req.query || {};
      const sweep = q.sweep === "1" || q.sweep === "true";
      const batch = Number(q.batch);
      const result = await runEnrichment({
        sweep,
        batch: Number.isFinite(batch) ? batch : undefined,
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      fail(res, "enrichment_run_failed", e);
    }
  });

  app.get("/api/dashboard/enrichment/status", async (_req: any, res: any) => {
    try {
      res.json({ ok: true, enabled: enrichmentEnabled(), action: enrichmentAction(), last_run: enrichmentLastRun() });
    } catch (e) {
      fail(res, "enrichment_status_failed", e);
    }
  });
};
