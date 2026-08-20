/*
 - filename: packages/engram-js/src/api/routes/dashboard/learning/route.ts
 - what is the file used for: living-model learning loop endpoints —
   list proposals, manual run, apply/dismiss/revert, status.
*/

import { bad, fail } from "../../_kit";
import {
  runLearning,
  listProposals,
  applyProposal,
  dismissProposal,
  revertProposal,
  learningStatus,
} from "../../../../services/learningPolicy";

export const dashboard_learning_route = (app: any) => {
  // Learning status (gate state, proposal counts)
  app.get("/api/dashboard/learning/status", async (_req: any, res: any) => {
    try {
      const status = await learningStatus();
      res.json({ ok: true, ...status });
    } catch (e) {
      fail(res, "learning_status_failed", e);
    }
  });

  // Manual trigger
  app.post("/api/dashboard/learning/run", async (_req: any, res: any) => {
    try {
      const result = await runLearning();
      res.json({ ok: true, ...result });
    } catch (e) {
      fail(res, "learning_run_failed", e);
    }
  });

  // List proposals (filter: status=open|applied|dismissed|reverted)
  app.get("/api/dashboard/learning/proposals", async (req: any, res: any) => {
    try {
      const q = req.query || {};
      const proposals = await listProposals({
        status: typeof q.status === "string" ? q.status : undefined,
        limit: q.limit !== undefined ? Number(q.limit) : 50,
      });
      res.json({ ok: true, proposals });
    } catch (e) {
      fail(res, "learning_proposals_failed", e);
    }
  });

  // Apply a proposal
  app.post("/api/dashboard/learning/proposals/:id/apply", async (req: any, res: any) => {
    try {
      const r = await applyProposal(req.params.id);
      if (!r.ok) return res.status(400).json({ err: r.error || "apply_failed" });
      res.json({ ok: true });
    } catch (e) {
      fail(res, "learning_apply_failed", e);
    }
  });

  // Dismiss a proposal
  app.post("/api/dashboard/learning/proposals/:id/dismiss", async (req: any, res: any) => {
    try {
      await dismissProposal(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      fail(res, "learning_dismiss_failed", e);
    }
  });

  // Revert an applied proposal (restores previous knob value)
  app.post("/api/dashboard/learning/proposals/:id/revert", async (req: any, res: any) => {
    try {
      const reason = typeof req.body?.reason === "string" ? req.body.reason : "manual revert";
      await revertProposal(req.params.id, reason);
      res.json({ ok: true });
    } catch (e) {
      fail(res, "learning_revert_failed", e);
    }
  });
};
