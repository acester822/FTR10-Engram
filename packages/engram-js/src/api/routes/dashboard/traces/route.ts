/*
 - filename: packages/engram-js/src/api/routes/dashboard/traces/route.ts
 - what is the file used for: persistent trace store endpoints
   (list / get / score / clear / prune) for the web GUI Traces tab.
*/

import { bad, fail } from "../../_kit";
import {
  listTraces,
  getTrace,
  deleteAllTraces,
  pruneTraces,
} from "../../../../services/traceStore";
import { scoreTrace, TRACE_DIMENSIONS } from "../../../../services/traceScorer";

export const dashboard_traces_route = (app: any) => {
  app.get("/api/dashboard/traces", async (req: any, res: any) => {
    try {
      const q = req.query || {};
      const traces = await listTraces({
        route: typeof q.route === "string" ? q.route : undefined,
        direction: typeof q.direction === "string" ? q.direction : undefined,
        kind: typeof q.kind === "string" ? q.kind : undefined,
        status: typeof q.status === "string" ? q.status : undefined,
        model: typeof q.model === "string" ? q.model : undefined,
        sector: typeof q.sector === "string" ? q.sector : undefined,
        scored: typeof q.scored === "string" ? q.scored : undefined,
        since: typeof q.since === "string" ? q.since : undefined,
        until: typeof q.until === "string" ? q.until : undefined,
        limit: q.limit,
        offset: q.offset,
      });
      res.json({ total: traces.length, traces });
    } catch (e) {
      fail(res, "traces_list_failed", e);
    }
  });

  app.get("/api/dashboard/traces/:id", async (req: any, res: any) => {
    try {
      const trace = await getTrace(req.params.id);
      if (!trace) return res.status(404).json({ err: "not_found" });
      res.json({ trace });
    } catch (e) {
      fail(res, "traces_get_failed", e);
    }
  });

  app.post("/api/dashboard/traces/:id/score", async (req: any, res: any) => {
    try {
      const dim = req.body?.dimension;
      if (!TRACE_DIMENSIONS.includes(dim)) {
        return bad(res, "dimension", `must be one of: ${TRACE_DIMENSIONS.join(", ")}`);
      }
      const result = await scoreTrace(req.params.id, dim);
      if (!result.ok) {
        return res.status(422).json({ err: "score_failed", msg: result.error, raw: result.raw });
      }
      res.json({
        ok: true,
        score: result.score,
        reason: result.reason,
        judge_model: result.judge_model,
        ms: result.ms,
        ts: result.ts,
      });
    } catch (e) {
      fail(res, "traces_score_failed", e);
    }
  });

  // DELETE /prune must be registered BEFORE any DELETE /:id-style route.
  app.delete("/api/dashboard/traces/prune", async (req: any, res: any) => {
    try {
      const days = req.query?.days !== undefined ? Number(req.query.days) : undefined;
      const removed = await pruneTraces(Number.isFinite(days as number) ? (days as number) : undefined);
      res.json({ ok: true, removed });
    } catch (e) {
      fail(res, "traces_prune_failed", e);
    }
  });

  app.delete("/api/dashboard/traces", async (_req: any, res: any) => {
    try {
      const removed = await deleteAllTraces();
      res.json({ ok: true, removed });
    } catch (e) {
      fail(res, "traces_clear_failed", e);
    }
  });
};
