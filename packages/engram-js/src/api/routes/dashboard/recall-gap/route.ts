/*
 - filename: packages/engram-js/src/api/routes/dashboard/recall-gap/route.ts
 - what is the file used for: manual trigger of the recall-gap pass —
   POST /api/dashboard/recall-gap/run.
*/

import { fail } from "../../_kit";
import { runRecallGap } from "../../../../services/recallGapEngine";

export const dashboard_recall_gap_route = (app: any) => {
  app.post("/api/dashboard/recall-gap/run", async (_req: any, res: any) => {
    try {
      const result = await runRecallGap();
      res.json({ ok: true, ...result });
    } catch (e) {
      fail(res, "recall_gap_run_failed", e);
    }
  });
};
