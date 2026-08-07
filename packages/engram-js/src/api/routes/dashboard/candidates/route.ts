/*
 - filename: packages/engram-js/src/api/routes/dashboard/candidates/route.ts
 - what is the file used for: manual drain of the extraction-candidates queue —
   POST /api/dashboard/candidates/process runs the real extraction pipeline
   over pending candidates.
*/

import { fail } from "../../_kit";
import { processPendingCandidates } from "../../../../services/candidateProcessor";

export const dashboard_candidates_route = (app: any) => {
  app.post("/api/dashboard/candidates/process", async (req: any, res: any) => {
    try {
      const limit = req.query?.limit !== undefined ? Number(req.query.limit) : 5;
      const result = await processPendingCandidates(Number.isFinite(limit) ? limit : 5);
      res.json({ ok: true, ...result });
    } catch (e) {
      fail(res, "candidate_processing_failed", e);
    }
  });
};
