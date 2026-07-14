/*
 - filename: packages/engram-js/src/api/routes/ingest/conversation/route.ts
 - what is the file used for: registers POST /ingest/conversation — a thin
   endpoint that runs Engram's native memory extraction (logInteractionAsync)
   over a full conversation turn (user prompt + assistant reply). This is the
   exact same extraction path the /v1/chat/completions proxy uses, exposed as
   a standalone route so external orchestrators (e.g. Hermes) can feed Engram
   the entire reply and let Engram decide what to store. No auth gate — matches
   the open /v1/chat/completions route; lock down with EG_INTERNAL_API_KEY if
   exposing beyond a trusted LAN.
*/

import { bad, fail, type route_ctx } from "../../_kit";
import { logInteractionAsync } from "../../../../services/memoryLogger";

export const ingest_conversation_route = (app: any, ctx: route_ctx) => {
  app.post("/ingest/conversation", async (req: any, res: any) => {
    const body = req.body || {};
    const userPrompt = typeof body.user_prompt === "string" ? body.user_prompt : "";
    const llmResponse = typeof body.llm_response === "string" ? body.llm_response : "";
    const sessionId = typeof body.session_id === "string" ? body.session_id : undefined;
    const projectId = typeof body.project_id === "string" ? body.project_id : undefined;

    if (!userPrompt.trim() && !llmResponse.trim()) {
      return bad(res, "content", "user_prompt or llm_response is required");
    }

    try {
      // allowGenome=false: Hermes feeds the FULL turn but must NOT let extraction
      // auto-promote chat narration to immutable genome. Genome is reserved for
      // explicit engram_remember(genome:true) calls. Extraction here yields phenotype only.
      const r = await logInteractionAsync(userPrompt, llmResponse, sessionId, projectId, false);
      return res.json({
        adapter: "durable-postgres",
        extraction: {
          status: "processed",
          stored_count: r.storedCount,
          sectors: r.sectors || {},
        },
      });
    } catch (e: unknown) {
      fail(res, "ingest_conversation_failed", e);
    }
  });
};
