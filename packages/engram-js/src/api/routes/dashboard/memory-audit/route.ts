/*
 - filename: packages/engram-js/src/api/routes/dashboard/memory-audit/route.ts
 - what is the file used for: the memory audit trail — every mutation to the
   memories table (auto-heal, consolidation via shared primitives, manual GUI
   edits) with before/after state, actor, and reason. The "changed or
   manipulated data" surface the user demanded.
*/

import { all_async as pg_all } from "../../../../database/connection";
import { fail } from "../../_kit";

export const dashboard_memory_audit_route = (app: any) => {
  app.get("/api/dashboard/memory-audit", async (req: any, res: any) => {
    try {
      const q = req.query || {};
      const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
      const params: any[] = [limit];
      let whereSql = "";
      if (typeof q.actor === "string" && q.actor) {
        params.push(q.actor);
        whereSql = `WHERE actor_id = $${params.length}`;
      }
      const rows = await pg_all(
        `SELECT id, actor_id, actor_type, event_type, target_table, target_id, operation, before_state, after_state, metadata, recorded_at
         FROM public.audit_log
         ${whereSql}
         ORDER BY recorded_at DESC LIMIT $1`,
        params,
      );
      res.json({ ok: true, entries: rows });
    } catch (e) {
      fail(res, "memory_audit_failed", e);
    }
  });
};
