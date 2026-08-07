/*
 - filename: packages/engram-js/src/api/routes/dashboard/enrichment/route.ts
 - what is the file used for: memory optimization (enrichment) engine endpoints —
   manual run + status.
*/

import { fail } from "../../_kit";
import { runEnrichment, enrichmentLastRun, enrichmentEnabled, enrichmentAction } from "../../../../services/enrichmentEngine";

export const dashboard_enrichment_route = (app: any) => {
  app.post("/api/dashboard/enrichment/run", async (_req: any, res: any) => {
    try {
      const result = await runEnrichment();
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
