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
  traceReport,
  traceFacets,
} from "../../../../services/traceStore";
import { scoreTrace, scoreAllUnscored, TRACE_DIMENSIONS } from "../../../../services/traceScorer";
import { generateSuggestions } from "../../../../services/traceSuggestions";
import { markTraceReviewed } from "../../../../services/traceStore";

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
        review: typeof q.review === "string" ? q.review : undefined,
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

  // Facets for GUI dropdowns (distinct routes/statuses from real data).
  // Registered before GET /:id so "facets" never matches as an id.
  app.get("/api/dashboard/traces/facets", async (_req: any, res: any) => {
    try {
      const facets = await traceFacets();
      res.json({ ok: true, ...facets });
    } catch (e) {
      fail(res, "traces_facets_failed", e);
    }
  });

  // Report aggregation — registered before GET /:id so "report" never matches
  // as an id. Pure SQL+JS aggregate (no LLM call) + deterministic suggestions.
  app.get("/api/dashboard/traces/report", async (req: any, res: any) => {
    try {
      const q = req.query || {};
      const statusRaw = q.status !== undefined && q.status !== "" ? Number(q.status) : undefined;
      const report = await traceReport({
        days: q.days !== undefined ? Number(q.days) : 7,
        from: typeof q.from === "string" && q.from ? q.from : undefined,
        to: typeof q.to === "string" && q.to ? q.to : undefined,
        route: typeof q.route === "string" && q.route ? q.route : undefined,
        direction: typeof q.direction === "string" && q.direction ? q.direction : undefined,
        status: Number.isFinite(statusRaw as number) ? (statusRaw as number) : undefined,
        limit: q.limit !== undefined ? Number(q.limit) : 10,
      });
      const suggestions = await generateSuggestions(report);
      res.json({ ok: true, report: { ...report, suggestions } });
    } catch (e) {
      fail(res, "traces_report_failed", e);
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

  app.post("/api/dashboard/traces/:id/review", async (req: any, res: any) => {
    try {
      const marked = await markTraceReviewed(req.params.id);
      if (!marked) return res.status(404).json({ err: "not_found" });
      res.json({ ok: true });
    } catch (e) {
      fail(res, "traces_review_failed", e);
    }
  });

  // Backfill: score every unscored eligible trace (bounded batch — re-invoke
  // for more). Registered before the :id routes so "score-unscored" never
  // matches as an id.
  app.post("/api/dashboard/traces/score-unscored", async (req: any, res: any) => {
    try {
      const raw = req.query?.limit !== undefined ? Number(req.query.limit) : 25;
      const result = await scoreAllUnscored(Number.isFinite(raw) ? raw : 25);
      res.json({ ok: true, ...result });
    } catch (e) {
      fail(res, "traces_score_all_failed", e);
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
