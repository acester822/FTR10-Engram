/*
 - filename: packages/engram-js/src/api/routes/dashboard/integrity/route.ts
 - what is the file used for: memory integrity engine endpoints —
   manual run, status (with the automatic gate), findings ledger, resolve.
*/

import { bad, fail } from "../../_kit";
import {
  runIntegrity,
  integrityStatus,
  listFindings,
  resolveFinding,
} from "../../../../services/integrityEngine";

export const dashboard_integrity_route = (app: any) => {
  app.post("/api/dashboard/integrity/run", async (_req: any, res: any) => {
    try {
      const result = await runIntegrity();
      res.json({ ok: true, ...result });
    } catch (e) {
      fail(res, "integrity_run_failed", e);
    }
  });

  app.get("/api/dashboard/integrity/status", async (_req: any, res: any) => {
    try {
      const status = await integrityStatus();
      res.json({ ok: true, ...status });
    } catch (e) {
      fail(res, "integrity_status_failed", e);
    }
  });

  app.get("/api/dashboard/integrity/findings", async (req: any, res: any) => {
    try {
      const q = req.query || {};
      const findings = await listFindings({
        status: typeof q.status === "string" ? q.status : undefined,
        severity: typeof q.severity === "string" ? q.severity : undefined,
        limit: q.limit !== undefined ? Number(q.limit) : 100,
      });
      res.json({ ok: true, findings });
    } catch (e) {
      fail(res, "integrity_findings_failed", e);
    }
  });

  app.post("/api/dashboard/integrity/findings/:id/resolve", async (req: any, res: any) => {
    try {
      const action = req.body?.action;
      if (action !== "dismiss" && action !== "apply") {
        return bad(res, "action", "must be 'dismiss' or 'apply'");
      }
      const ok = await resolveFinding(req.params.id, action, typeof req.body?.note === "string" ? req.body.note : undefined);
      if (!ok) return res.status(404).json({ err: "not_found" });
      res.json({ ok: true });
    } catch (e) {
      fail(res, "integrity_resolve_failed", e);
    }
  });
};
