/*
 - filename: packages/engram-js/src/services/clusterEngine.ts
 - what is the file used for: rung 4 of the trust ladder — MEMORY COHERENCE.
   Turns scattered memory fragments into "living skills": given a topic, it
   discovers the memory cluster (anchor via vector recall → BFS over edges →
   similarity neighbors), then composes a dense, ordered, SOURCE-ANCHORED
   knowledge bundle (architecture → current state → conventions → pitfalls)
   with every statement tagged [src:N] and validated against hallucination /
   cross-project drift. READ-ONLY: bundles never write to the store; the
   memories stay the single authority. Bundles cache ≤ 5 min per topic purely
   for cost — the underlying memories are always re-read.
*/

import { all_async as pg_all } from "../database/connection";
import { embed, normalizeEmbedding } from "../embeddings/embed";
import { callJudge, parseJudge } from "./traceScorer";
import { logger } from "../utils/logger";

const LINK_TYPES = ["part_of", "derives_from", "related_to"];
const SIM_NEIGHBOR_MIN = 0.75;
const CLUSTER_MAX = 40;
const BUNDLE_TTL_MS = 5 * 60 * 1000;
const COMPOSE_MIN_SCORE = 0.6;

// ── Cluster discovery ────────────────────────────────────────────────────

export interface ClusterMemory {
  id: string;
  content: string;
  sector: string | null;
  sim?: number;
}

export async function discoverCluster(topic: string, opts: { limit?: number } = {}): Promise<{ anchor: ClusterMemory | null; memories: ClusterMemory[] }> {
  const limit = Math.min(opts.limit ?? CLUSTER_MAX, CLUSTER_MAX);
  let vec: number[];
  try {
    vec = normalizeEmbedding(await embed(topic));
  } catch (e: any) {
    logger.warn({ module: "clusterEngine", err: e?.message }, "embed failed — no cluster");
    return { anchor: null, memories: [] };
  }
  if (!vec.length) return { anchor: null, memories: [] };

  // 1. Anchor = the strongest active memory for the topic.
  const anchorRows = await pg_all(
    `SELECT id, content, sector, round((1 - (embedding <=> $1::halfvec))::numeric, 3) AS sim
     FROM public.memories
     WHERE superseded_at IS NULL AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::halfvec LIMIT 1`,
    [JSON.stringify(vec)],
  ).catch(() => []);
  const anchor: ClusterMemory | null = anchorRows[0] ? { id: anchorRows[0].id, content: anchorRows[0].content, sector: anchorRows[0].sector, sim: Number(anchorRows[0].sim) } : null;
  if (!anchor) return { anchor: null, memories: [] };

  // 2. BFS over edges (both directions, depth 2, coherence link types).
  const seen = new Set<string>([anchor.id]);
  const frontier = [anchor.id];
  for (let depth = 0; depth < 2 && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const rows = await pg_all(
        `SELECT source_memory_id, target_memory_id, edge_type FROM public.edges
         WHERE edge_type = ANY($1) AND (source_memory_id = $2 OR target_memory_id = $2)
         LIMIT 60`,
        [LINK_TYPES, id],
      ).catch(() => []);
      for (const r of rows) {
        const other = r.source_memory_id === id ? r.target_memory_id : r.source_memory_id;
        if (other && !seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
      }
    }
    frontier.length = 0;
    frontier.push(...next);
  }

  // 3. Similarity neighbors (fills in unlinked cluster members).
  if (seen.size < limit) {
    const simRows = await pg_all(
      `SELECT id, content, sector, round((1 - (embedding <=> $1::halfvec))::numeric, 3) AS sim
       FROM public.memories
       WHERE superseded_at IS NULL AND embedding IS NOT NULL
         AND id <> ALL($2)
         AND (1 - (embedding <=> $1::halfvec)) >= ${SIM_NEIGHBOR_MIN}
       ORDER BY embedding <=> $1::halfvec LIMIT ${limit}`,
      [JSON.stringify(vec), [...seen]],
    ).catch(() => []);
    for (const r of simRows) {
      if (seen.size >= limit) break;
      seen.add(r.id);
    }
  }

  const ids = [...seen].slice(0, limit);
  const memRows = await pg_all(
    `SELECT id, content, sector FROM public.memories WHERE id = ANY($1) AND superseded_at IS NULL`,
    [ids],
  ).catch(() => []);
  const byId = new Map(memRows.map((r: any) => [r.id, r]));
  const memories: ClusterMemory[] = ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((r: any) => ({ id: r.id, content: r.content, sector: r.sector }));
  return { anchor, memories };
}

// ── Bundle composition (read-only, sourced, validated) ───────────────────

export interface BundleResult {
  topic: string;
  bundle: string;
  anchor: ClusterMemory | null;
  members: ClusterMemory[];
  sources: { n: number; memory_id: string; content: string }[];
}

const bundleCache = new Map<string, { at: number; result: BundleResult }>();

export async function composeBundle(topic: string): Promise<BundleResult | null> {
  const cached = bundleCache.get(topic);
  if (cached && Date.now() - cached.at < BUNDLE_TTL_MS) return cached.result;

  const { anchor, memories } = await discoverCluster(topic);
  if (!anchor || !memories.length) return null;

  // Compose: dense, ordered, every statement anchored [src:N].
  let composed = "";
  try {
    const c = await callJudge(
      `You are a memory cluster composer. Given a MEMORY CLUSTER about one project/topic (each memory numbered), compose a dense, coherent knowledge bundle ordered: architecture facts -> current state -> conventions -> pitfalls. Rules: (1) EVERY statement must be directly supported by a cluster memory and tagged [src:N] with its number; (2) never invent, never merge facts across different projects, never guess; (3) if a memory is vague or unanchorable, skip it; (4) plain text only, no JSON, no markdown headers. Return ONLY the composed text.`,
      `TOPIC: ${topic}\n\nCLUSTER MEMORIES:\n${memories.map((m, i) => `[${i + 1}] (${m.sector ?? "?"}) ${m.content}`).join("\n").slice(0, 8000)}`,
    );
    composed = c.ok && typeof c.content === "string" ? c.content.trim() : "";
  } catch (e: any) {
    logger.warn({ module: "clusterEngine", err: e?.message }, "compose failed");
    return null;
  }
  if (!composed) return null;

  // Validate: no hallucination, no cross-project drift, anchored.
  try {
    const v = await callJudge(
      `You are a strict bundle validator. Given a TOPIC, a COMPOSED BUNDLE, and the SOURCE MEMORIES it claims to summarize, judge whether every statement in the bundle is directly supported by a source memory (tagged [src:N]), stays on the topic's project, and invents nothing. Respond ONLY with JSON: {"score": <0.0-1.0>, "reason": "<one sentence>"} where 0 = terrible and 1 = perfect.`,
      `TOPIC:\n${topic}\n\nBUNDLE:\n${composed}\n\nSOURCE MEMORIES:\n${memories.map((m, i) => `[${i + 1}] ${m.content}`).join("\n").slice(0, 8000)}`,
    );
    const parsed = v.ok ? parseJudge(v.content || "") : null;
    if (!parsed || parsed.score < COMPOSE_MIN_SCORE) {
      logger.warn({ module: "clusterEngine", reason: parsed?.reason }, "bundle validation rejected");
      return null;
    }
  } catch {
    return null; // validation is mandatory — no validation, no bundle
  }

  const result: BundleResult = {
    topic,
    bundle: composed,
    anchor,
    members: memories,
    sources: memories.map((m, i) => ({ n: i + 1, memory_id: m.id, content: m.content })),
  };
  bundleCache.set(topic, { at: Date.now(), result });
  return result;
}

export function clearBundleCache(): void {
  bundleCache.clear();
}
