/*
 - filename: packages/engram-js/src/api/routes/cognitive-context/route.ts
 - what is it for: POST /api/cognitive-context — returns a fully-SHAPED cognitive
   context block for sidecar hosts (e.g. the Hermes plugin). Inward recall first
   (genome + phenotype); outward web search ONLY when the confidence gate fails.
   Mirrors the proxy's composition in /v1/chat/completions but emits JSON so the
   host agent can place it without surrendering orchestration.

   Design notes:
   - The shaped block is returned as a single string intended for the HOST's
     per-turn user-message injection (NOT the system prompt), so it stays
     cache-safe for hosts like Hermes that pin the system prompt for the
     conversation's life.
   - Genome is cached (30s TTL) and only fetched live on a miss, exactly like the
     proxy path.
   - Outward web search reuses autoSearch.shouldSearch(topScore, query) — the same
     confidence-gated fallback the proxy uses. It is OFF when EG_AUTO_SEARCH_ENABLED
     is false or when the caller passes allow_web:false.
*/

import { bad, fail } from "../_kit";
import type { route_ctx } from "../_kit";
import { recallDurableMemories } from "../../../durable/repository";
import { embed } from "../../../embeddings/embed";
import { genomeCache } from "../../../services/genomeCache";
import { autoSearch } from "../../../services/autoSearch";
import { env } from "../../../configuration";

interface GenomeMemory {
  id: string;
  content: string;
}
interface PhenotypeMemory {
  id: string;
  content: string;
  sector: string;
  score: number;
}

/** Local copy of the proxy's delimiter-sanitizing helper (prevents prompt break-out). */
function sanitizeMemoryContent(content: string): string {
  return content.replace(/\[END?\s*ENGRAM[^\]]*\]/gi, "[ENGRAM CONTENT — REDACTED]");
}

/** Local copy of the proxy's buildCognitiveContext (kept route-local to avoid
 *  pulling the chat route's SSE helpers into a JSON endpoint). */
function buildCognitiveContext(
  genome: GenomeMemory[],
  phenotype: PhenotypeMemory[],
  webResults?: string,
): string {
  let ctx = "[ENGRAM COGNITIVE CONTEXT]\n";

  if (genome.length > 0) {
    ctx += "--- CORE DIRECTIVES (GENOME) ---\n";
    for (const m of genome) {
      ctx += `- ${sanitizeMemoryContent(m.content)}\n`;
    }
    ctx += "\n";
  }

  if (phenotype.length > 0) {
    ctx += "--- RECALLED CONTEXT (PHENOTYPE) ---\n";
    const grouped: Record<string, string[]> = {};
    for (const m of phenotype) {
      if (!grouped[m.sector]) grouped[m.sector] = [];
      grouped[m.sector].push(sanitizeMemoryContent(m.content));
    }
    for (const [sector, contents] of Object.entries(grouped)) {
      ctx += `[${sector.toUpperCase()}]\n`;
      for (const c of contents) {
        ctx += `- ${c}\n`;
      }
      ctx += "\n";
    }
  }

  if (webResults) {
    ctx += webResults;
  }

  ctx += "[END ENGRAM CONTEXT]\n";
  ctx +=
    "Use the above context silently to inform your response. Do not explicitly mention \"Engram\" or the context blocks unless directly asked about your memory.\n";
  return ctx;
}

export const cognitive_context_route = (app: any, ctx: route_ctx) => {
  app.post("/api/cognitive-context", async (req: any, res: any) => {
    const body = req.body || {};

    if (typeof body?.query !== "string" || body.query.trim().length === 0) {
      return bad(res, "query", "query must be a non-empty string");
    }

    const query = body.query.trim();
    const genomeLimit = Number.isFinite(Number(body.genome_limit))
      ? Math.max(1, Math.min(Number(body.genome_limit) || 15, 100))
      : 15;
    const phenotypeLimit = Number.isFinite(Number(body.phenotype_limit))
      ? Math.max(1, Math.min(Number(body.phenotype_limit) || 5, 100))
      : 5;
    const allowWeb =
      body.allow_web !== false && env.auto_search_enabled === true;

    const db = ctx.db;

    try {
      // ── Genome (cached, near-immutable) ──
      let genomeMemories: GenomeMemory[] = [];
      const cached = genomeCache.get();
      if (cached) {
        genomeMemories = cached;
      } else {
        const result = await ctx.db.query(
          `select id, content from "public"."memories" where is_genome = true and memory_tier != 'archived' order by recorded_at desc limit $1`,
          [genomeLimit],
        );
        genomeMemories = (result.rows || []).map((r: any) => ({
          id: r.id,
          content: r.content,
        }));
        genomeCache.set(genomeMemories);
      }

      // ── Phenotype (hybrid vector + keyword, same path as proxy) ──
      let phenotypeMemories: PhenotypeMemory[] = [];
      try {
        const embedding = await embed(query);
        const recalled = await recallDurableMemories(ctx.db, {
          query,
          mode: "associative",
          limit: phenotypeLimit,
          user_id:
            typeof body.user_id === "string" && body.user_id
              ? body.user_id
              : undefined,
          project_id:
            typeof body.project_id === "string" && body.project_id
              ? body.project_id
              : undefined,
          embedding: embedding.length ? embedding : undefined,
        });
        phenotypeMemories = (recalled.results || [])
          .slice(0, phenotypeLimit)
          .map((r: any) => ({
            id: r.id,
            content: r.content,
            sector: r.sector || "semantic",
            score: typeof r.score === "number" ? r.score : 0,
          }));
      } catch (err: any) {
        // Non-fatal: proceed with genome only.
        logger_warn("cognitive-context phenotype recall failed", err?.message);
      }

      // ── Gated outward web fallback (ONLY when inward recall is weak) ──
      let webContextBlock = "";
      let webUsed = false;
      if (allowWeb) {
        const topScore =
          phenotypeMemories.length > 0 ? phenotypeMemories[0].score : 0;
        if (autoSearch.shouldSearch(topScore, query)) {
          try {
            const queries = await autoSearch.generateQueries(query);
            if (queries.length > 0) {
              const searchResults = await autoSearch.search(queries);
              const fetched = await autoSearch.fetchContent(searchResults);
              if (fetched.length > 0) {
                webContextBlock = autoSearch.formatContext(fetched);
                webUsed = true;
              }
            }
          } catch (err: any) {
            logger_warn("cognitive-context auto-search failed", err?.message);
          }
        }
      }

      const context = buildCognitiveContext(
        genomeMemories,
        phenotypeMemories,
        webContextBlock,
      );

      return res.json({
        context,
        web_used: webUsed,
        genome_count: genomeMemories.length,
        phenotype_count: phenotypeMemories.length,
        shaped: true,
      });
    } catch (e: unknown) {
      fail(res, "cognitive_context_failed", e);
    }
  });
};

function logger_warn(where: string, msg?: string) {
  // Lightweight warn without importing the full logger signature mismatch.
  try {
    // eslint-disable-next-line no-console
    console.warn(`[cognitive-context] ${where}: ${msg ?? "unknown error"}`);
  } catch {
    /* swallow */
  }
}
