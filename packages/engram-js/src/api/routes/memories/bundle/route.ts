/*
 - filename: packages/engram-js/src/api/routes/memories/bundle/route.ts
 - what is the file used for: rung 4 (coherence) — POST /api/memories/bundle?topic=X
   returns the composed, source-anchored knowledge bundle for a topic
   ("the skill, but better" — auto-derived from the live store, read-only).
*/

import { bad, fail } from "../../_kit";
import { composeBundle } from "../../../../services/clusterEngine";

export const memories_bundle_route = (app: any) => {
  app.post("/api/memories/bundle", async (req: any, res: any) => {
    const topic =
      typeof req.query?.topic === "string"
        ? req.query.topic.trim()
        : typeof req.body?.topic === "string"
        ? req.body.topic.trim()
        : "";
    if (!topic) return bad(res, "topic", "topic must be a non-empty string (query or body)");
    try {
      const result = await composeBundle(topic);
      if (!result) return res.status(404).json({ ok: false, err: "no_cluster", msg: `no coherent memory cluster found for topic "${topic}"` });
      res.json({ ok: true, ...result });
    } catch (e) {
      fail(res, "bundle_failed", e);
    }
  });
};
