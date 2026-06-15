/*
   ____                   __  __                                 
  / __ \                 |  \/  |                                
 | |  | |_ __   ___ _ __ | \  / | ___ _ __ ___   ___  _ __ _   _ 
 | |  | | '_ \ / _ \ '_ \| |\/| |/ _ \ '_ ` _ \ / _ \| '__| | | |
 | |__| | |_) |  __/ | | | |  | |  __/ | | | | | (_) | |  | |_| |
  \____/| .__/ \___|_| |_|_|  |_|\___|_| |_| |_|\___/|_|   \__, |
        | |                                                 __/ |
        |_|                                                |___/ 
  CaviraOSS @ 2026

 - filename: packages/openmemory-js/src/api/routes/memories/explain_score/route.ts
 - what is the file used for: registers get /memories/:id/score-explain for flat score breakdown
*/

import { explainDurableMemory } from "../../../../durable/repository";
import { fail, type route_ctx } from "../../_kit";

export const memory_explain_score_route = (app: any, ctx: route_ctx) => {
  app.get("/memories/:id/score-explain", async (req: any, res: any) => {
    try {
      const explained = await explainDurableMemory(ctx.db, {
        id: req.params.id,
      });
      if (!explained) return res.status(404).json({ err: "not_found" });

      const scoreComponents = explained.score_components || {};
      const confidenceBreakdown = [
        { factor: "confidence", weight: 1, score: scoreComponents.confidence ?? 0 },
        { factor: "provenance", weight: 1, score: scoreComponents.provenance ?? 0 },
        { factor: "contradiction_penalty", weight: -1, score: (scoreComponents.contradiction_penalty ?? 0) * -1 },
        { factor: "contract_penalty", weight: -1, score: (scoreComponents.contract_penalty ?? 0) * -1 },
      ];

      const salienceBreakdown = [
        { factor: "salience", weight: 1, score: scoreComponents.salience ?? 0 },
        { factor: "provenance", weight: 1, score: scoreComponents.provenance ?? 0 },
        { factor: "contradiction_penalty", weight: -1, score: (scoreComponents.contradiction_penalty ?? 0) * -1 },
        { factor: "contract_penalty", weight: -1, score: (scoreComponents.contract_penalty ?? 0) * -1 },
      ];

      return res.json({
        confidence_breakdown: confidenceBreakdown,
        salience_breakdown: salienceBreakdown,
      });
    } catch (e: unknown) {
      fail(res, "explain_score_failed", e);
    }
  });
};
