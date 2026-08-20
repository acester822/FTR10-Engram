/*
 - filename: packages/engram-js/src/api/routes/dashboard/curriculum/route.ts
 - what is the file used for: curriculum engine endpoints — manual run, status.
*/

import { fail } from "../../_kit";
import { runCurriculum, curriculumEngine } from "../../../../services/curriculumEngine";

export const dashboard_curriculum_route = (app: any) => {
  app.post("/api/dashboard/curriculum/run", async (_req: any, res: any) => {
    try {
      const result = await runCurriculum();
      res.json({ ok: true, ...result });
    } catch (e) {
      fail(res, "curriculum_run_failed", e);
    }
  });

  app.get("/api/dashboard/curriculum/status", async (_req: any, res: any) => {
    try {
      res.json({
        ok: true,
        enabled: (process.env.EG_CURRICULUM_ENABLED ?? "false").toLowerCase() === "true",
        interval_ms: Number(process.env.EG_CURRICULUM_INTERVAL_MS) || 168 * 60 * 60 * 1000,
      });
    } catch (e) {
      fail(res, "curriculum_status_failed", e);
    }
  });
};
