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
import { all_async as pg_all } from "../../../database/connection";
import { recallDurableMemories } from "../../../durable/repository";
import { embed } from "../../../embeddings/embed";
import { genomeCache } from "../../../services/genomeCache";
import { composeBundle } from "../../../services/clusterEngine";
import { autoSearch } from "../../../services/autoSearch";
import { env } from "../../../configuration";

/** Redis-backed increment for the repo-tip session counter. Best-effort —
 *  a redis failure just skips the tip (the context block never breaks). */
let tipClient: any = null;
async function redisIncr(key: string, ttlSec = 86400): Promise<number> {
  try {
    if (!tipClient) {
      const { createClient } = await import("redis");
      tipClient = createClient({ url: env.valkey_url, socket: { connectTimeout: 1000 }, disableOfflineQueue: true });
      tipClient.on("error", () => undefined);
      await Promise.race([
        tipClient.connect(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("redis connect timeout")), 1200)),
      ]);
    }
    const n = await tipClient.incr(key);
    if (n === 1) await tipClient.expire(key, ttlSec).catch(() => undefined);
    return n;
  } catch {
    return 0; // no redis → no tip (fail-open on the counter, never on context)
  }
}

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

      // ── Coherence rung (v4.6.0): project-context bundle — "the skill, but
      //    better". Detected topic (explicit body.topic or a project-phrase in
      //    the query) → composed, source-anchored bundle. Optional + guarded:
      //    a bundle failure NEVER breaks the context block. ──
      let bundleBlock = "";
      let bundleTopic =
        typeof body.topic === "string" && body.topic.trim()
          ? body.topic.trim()
          : detectTopic(query);
      if (bundleTopic) {
        try {
          const bundle = await composeBundle(bundleTopic);
          if (bundle) {
            bundleBlock = `\n### PROJECT CONTEXT (${bundleTopic}) ###\n${bundle.bundle}\n`;
          }
        } catch {
          /* bundle is optional — never break the context */
        }
      }
      const finalContext = bundleBlock ? bundleBlock + "\n" + context : context;

      // ── Repo baseline tip (v4.7.0-repo-index): if the user is continuously
      //    working in a location that has NOT been indexed, suggest the Repos
      //    tab once per session (Redis-backed session counter). Honest
      //    wording, toggleable, never automatic. ──
      let repoTip = "";
      const tipEnabled = (process.env.EG_REPO_TIP_ENABLED ?? "true").toLowerCase() !== "false";
      const sessionId = typeof body.session_id === "string" && body.session_id ? body.session_id : null;
      if (tipEnabled && sessionId && bundleTopic) {
        try {
          const rows = await pg_all(
            `SELECT 1 FROM public.repos WHERE status = 'ready'
             AND (name ILIKE $1 OR source ILIKE $2) LIMIT 1`,
            [`%${bundleTopic}%`, `%${bundleTopic}%`],
          ).catch(() => []);
          if (!rows.length) {
            const redisKey = `repo_tip:${sessionId}`;
            const n = await redisIncr(redisKey);
            if (n === 3) {
              repoTip = `\n[NOTE] You're working on "${bundleTopic}" and this repo is not indexed — add baseline knowledge (Web GUI → Repos → Add Repo).`;
            }
          }
        } catch {
          /* tip is optional — never break the context */
        }
      }

      return res.json({
        context: repoTip ? finalContext + repoTip : finalContext,
        web_used: webUsed,
        bundle_used: Boolean(bundleBlock),
        bundle_topic: bundleTopic ?? null,
        repo_tip: repoTip ? true : false,
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

const TOPIC_STOP = new Set(["the", "a", "an", "this", "that", "my", "our", "your", "it", "them", "there", "here", "some", "any"]);

/** Conservative project-topic detection for "I'm working on Engram" style
 *  queries. Explicit body.topic always wins; this is the fallback. */
function detectTopic(query: string): string | null {
  const m = query.match(/(?:working on|working with|working in|work on|work with|about the|for the|in the)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9_.-]{2,})/i);
  const t = m?.[1];
  if (!t) return null;
  const lower = t.toLowerCase();
  if (TOPIC_STOP.has(lower)) return null;
  return t;
}
