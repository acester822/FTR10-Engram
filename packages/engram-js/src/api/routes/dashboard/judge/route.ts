/*
 - filename: packages/engram-js/src/api/routes/dashboard/judge/route.ts
 - what is the file used for: judge governance endpoints — calibration set
   CRUD, calibration runs (judge vs human labels), and consistency runs
   (re-score variance). The "trust the judge" checkpoint.
*/

import { bad, fail } from "../../_kit";
import {
  listCalibration,
  addCalibration,
  updateCalibration,
  deleteCalibration,
  runCalibration,
  runConsistency,
} from "../../../../services/traceGovernance";

export const dashboard_judge_route = (app: any) => {
  app.get("/api/dashboard/judge/calibration", async (_req: any, res: any) => {
    try {
      const entries = await listCalibration();
      res.json({ ok: true, entries });
    } catch (e) {
      fail(res, "calibration_list_failed", e);
    }
  });

  app.post("/api/dashboard/judge/calibration", async (req: any, res: any) => {
    try {
      const b = req.body || {};
      if (typeof b.trace_id !== "string" || !b.trace_id.trim()) {
        return bad(res, "trace_id", "trace_id is required");
      }
      const result = await addCalibration({
        trace_id: b.trace_id.trim(),
        dimension: String(b.dimension || ""),
        expected_score: Number(b.expected_score),
        note: typeof b.note === "string" ? b.note : undefined,
      });
      if (!result.ok) return bad(res, "calibration", result.error || "add failed");
      res.json({ ok: true, id: result.id });
    } catch (e) {
      fail(res, "calibration_add_failed", e);
    }
  });

  app.put("/api/dashboard/judge/calibration/:id", async (req: any, res: any) => {
    try {
      const b = req.body || {};
      const result = await updateCalibration(req.params.id, {
        expected_score: b.expected_score !== undefined ? Number(b.expected_score) : undefined,
        note: b.note !== undefined ? String(b.note) : undefined,
        active: b.active !== undefined ? !!b.active : undefined,
      });
      if (!result.ok) return bad(res, "calibration", result.error || "update failed");
      res.json({ ok: true });
    } catch (e) {
      fail(res, "calibration_update_failed", e);
    }
  });

  app.delete("/api/dashboard/judge/calibration/:id", async (req: any, res: any) => {
    try {
      const removed = await deleteCalibration(req.params.id);
      res.json({ ok: true, removed });
    } catch (e) {
      fail(res, "calibration_delete_failed", e);
    }
  });

  // Re-score every calibration entry (fresh judge call, non-persisting) and
  // compare against the human-labeled expected score.
  app.post("/api/dashboard/judge/run-calibration", async (req: any, res: any) => {
    try {
      const tolerance = Number(req.body?.tolerance) || 0.15;
      const result = await runCalibration(tolerance);
      res.json({ ok: true, ...result });
    } catch (e) {
      fail(res, "calibration_run_failed", e);
    }
  });

  // v4.7.11: SSE variant of run-calibration — streams one `entry` event per
  // calibration verdict as it lands, then a `done` event with the full summary.
  // The GUI renders a live run feed (llama-swap activity-style) instead of a
  // blank spinner while the judge re-scores each entry serially.
  app.post("/api/dashboard/judge/run-calibration/stream", async (req: any, res: any) => {
    const tolerance = Number(req.body?.tolerance) || 0.15;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    try {
      const result = await runCalibration(tolerance, (entry, index, total) => {
        res.write(`event: entry\ndata: ${JSON.stringify({ index, total, ...entry })}\n\n`);
      });
      res.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
    } catch (e: any) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: e?.message || String(e) })}\n\n`);
    } finally {
      res.end();
    }
  });

  // Re-score a random sample N times (non-persisting) and report variance.
  app.post("/api/dashboard/judge/consistency", async (req: any, res: any) => {
    try {
      const samples = Number(req.body?.samples) || 5;
      const repeats = Number(req.body?.repeats) || 3;
      const result = await runConsistency(samples, repeats);
      res.json({ ok: true, ...result });
    } catch (e) {
      fail(res, "consistency_run_failed", e);
    }
  });
};
