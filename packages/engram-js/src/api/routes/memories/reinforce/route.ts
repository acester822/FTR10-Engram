/*
 - filename: packages/engram-js/src/api/routes/memories/reinforce/route.ts
 - what is the file used for: registers post /memories/:id/reinforce for salience boosts
*/

import { reinforceDurableMemory } from "../../../../durable/repository";
import { local_reinforce } from "../../../../database/localstore";
import { genomeCache } from "../../../../services/genomeCache";
import { bad, fail, mem_ref, type reinforce_req, type route_ctx } from "../../_kit";

export const memory_reinforce_route = (app: any, ctx: route_ctx) => {
  app.post("/memories/:id/reinforce", async (req: any, res: any) => {
    const body = req.body as reinforce_req;
    if (body?.boost !== undefined && (typeof body.boost !== "number" || !Number.isFinite(body.boost) || body.boost < 0 || body.boost > 1))
      return bad(res, "boost", "boost must be a number between 0 and 1");

    try {
      const reinforced = ctx.mem ? await local_reinforce(req.params.id, body?.user_id, body?.boost) : await reinforceDurableMemory(ctx.db, {
        id: req.params.id,
        user_id: body?.user_id,
        boost: body?.boost,
      });
      if (!reinforced) return res.status(404).json({ err: "not_found" });
      genomeCache.invalidate();
      const out = { adapter: ctx.mem ? ctx.store : "durable-postgres", ...reinforced };
      return res.json({ ...out, memory: mem_ref(out) });
    } catch (e: unknown) {
      fail(res, "reinforce_failed", e);
    }
  });
};
