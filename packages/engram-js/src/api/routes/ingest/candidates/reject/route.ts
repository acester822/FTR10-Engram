/*
 - filename: packages/engram-js/src/api/routes/ingest/candidates/reject/route.ts
 - what is the file used for: registers post /ingest/candidates/:id/reject for candidate rejection
*/

import { rejectExtractionCandidate } from "../../../../../durable/repository";
import { bad, fail, type reject_req, type route_ctx } from "../../../_kit";

export const candidate_reject_route = (app: any, ctx: route_ctx) => {
  app.post("/ingest/candidates/:id/reject", async (req: any, res: any) => {
    const body = (req.body || {}) as reject_req;
    if (typeof req.params?.id !== "string" || req.params.id.trim().length === 0)
      return bad(res, "id", "id must be a non-empty string");
    if (typeof body.reason !== "string" || body.reason.trim().length === 0)
      return bad(res, "reason", "reason must be a non-empty string");

    try {
      const rejected = await rejectExtractionCandidate(ctx.db, {
        candidate_id: req.params.id,
        reason: body.reason,
        user_id: body.user_id,
      });
      if (!rejected) return res.status(404).json({ err: "not_found" });
      return res.json({ adapter: "durable-postgres", candidate: rejected });
    } catch (e: unknown) {
      fail(res, "candidate_reject_failed", e);
    }
  });
};
