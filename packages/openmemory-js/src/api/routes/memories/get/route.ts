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

 - filename: packages/openmemory-js/src/api/routes/memories/get/route.ts
 - what is the file used for: registers get /memories/:id for single memory fetch
*/

import { getDurableMemory } from "../../../../durable/repository";
import { local_get } from "../../../../database/localstore";
import { fail, type route_ctx } from "../../_kit";

export const memory_get_route = (app: any, ctx: route_ctx) => {
  app.get("/memories/:id", async (req: any, res: any) => {
    try {
      let memory: any;
      if (ctx.mem) {
        memory = await local_get(req.params.id, {
          user_id: req.query.user_id,
          project_id: req.query.project_id,
        });
      } else {
        memory = await getDurableMemory(ctx.db, {
          id: req.params.id,
          user_id: req.query.user_id,
          project_id: req.query.project_id,
        });
      }
      if (!memory) return res.status(404).json({ err: "not_found" });

      // Derive tier from bitemporal state
      const validTo = memory.bitemporal?.valid_to;
      let tier: string;
      if (!validTo) tier = "active";
      else {
        const now = new Date();
        const vt = new Date(validTo);
        const daysDiff = (now.getTime() - vt.getTime()) / (1000 * 60 * 60 * 24);
        if (daysDiff < 7) tier = "warm";
        else if (daysDiff < 30) tier = "cold";
        else tier = "archived";
      }

      // Derive sensitivity from contracts
      const contracts: Record<string, unknown> = typeof memory.contracts === "string" ? JSON.parse(memory.contracts) : (memory.contracts || {});
      let sensitivity: number;
      if (contracts.sensitivity === "restricted") sensitivity = 2;
      else if (contracts.sensitivity === "sensitive") sensitivity = 1;
      else sensitivity = 0;

      const out = {
        adapter: ctx.mem ? ctx.store : "durable-postgres",
        id: memory.id,
        content: memory.content,
        confidence: typeof memory.confidence === "number" ? memory.confidence : (memory.confidence?.confidence ?? 0),
        salience: typeof memory.salience === "number" ? memory.salience : (memory.confidence?.salience ?? 0),
        tier,
        sensitivity,
        user_id: memory.user_id ?? null,
        project_id: memory.project_id ?? null,
        recorded_at: memory.bitemporal?.recorded_at ?? "",
        observed_at: memory.bitemporal?.observed_at ?? "",
        valid_from: memory.bitemporal?.valid_from ?? null,
        valid_to: memory.bitemporal?.valid_to ?? null,
        provenance_sources: [], // Will be populated by explain route
        contradictions: [], // Will be populated by explain route
        versions: [], // Will be populated by explain route
      };

      return res.json(out);
    } catch (e: unknown) {
      fail(res, "get_failed", e);
    }
  });
};
