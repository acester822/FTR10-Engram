/*
 - filename: packages/engram-js/src/services/compoundSplitter.ts
 - what is the file used for: split compound memories (long multi-clause rows)
   into their constituent clause-facts. Motivation (user review, 2026-08-07):
   a fact stored as ONE clause inside a ~700-char compound gets diluted by the
   single embedding vector — the query "why do I see duplicate listings in the
   findings ledger" ranked the compound below the top 6, while the SAME clause
   as its own memory ranked #1 at 0.747. Deterministic (sentence splitting,
   zero LLM, zero fabrication — same philosophy as the link backfill), audited
   via the shared mutation primitives, original superseded (bi-temporal,
   undoable). Idempotent: only active rows are candidates.
*/

import { run_async as pg_run, all_async as pg_all } from "../database/connection";
import { embed, normalizeEmbedding } from "../embeddings/embed";
import { supersedeMemories } from "../durable/mutations";
import { logger } from "../utils/logger";

const MAX_COMPOUND_LEN = 400; // rows longer than this are candidates
const MIN_CLAUSE_LEN = 40; // fragments shorter than this merge onto the previous clause

export function splitClauses(content: string): string[] {
  const parts = content
    .replace(/\.\s+/g, ".\u0000")
    .replace(/;\s+/g, ";\u0000")
    .split("\u0000")
    .map((s) => s.trim())
    .filter(Boolean);
  const clauses: string[] = [];
  for (const p of parts) {
    const last = clauses[clauses.length - 1];
    if (last && p.length < MIN_CLAUSE_LEN) clauses[clauses.length - 1] = `${last} ${p}`;
    else clauses.push(p);
  }
  return clauses;
}

let running = false;

/** Chunk a long memory into clause-windows (memory_windows) for chunk-boosted
 *  recall (v4.7.6). The table already existed (hybrid's windowed-embedding leg)
 *  but was never populated — clause chunks let recall surface a specific fact
 *  buried in a long memory (the compound-dilution class). Idempotent per call. */
export async function chunkMemory(id: string, content: string): Promise<number> {
  if (!content || content.length <= MAX_COMPOUND_LEN) return 0;
  const clauses = splitClauses(content).filter((c) => c.length >= MIN_CLAUSE_LEN);
  if (clauses.length < 2) return 0;
  let pos = 0;
  let n = 0;
  for (const clause of clauses) {
    const start = content.indexOf(clause, pos);
    const end = start >= 0 ? start + clause.length : pos + clause.length;
    pos = end;
    try {
      const vec = normalizeEmbedding(await embed(clause));
      await pg_run(
        `INSERT INTO public.memory_windows (memory_id, window_index, start_pos, end_pos, embedding)
         VALUES ($1, $2, $3, $4, $5::halfvec)`,
        [id, n, start >= 0 ? start : 0, end, JSON.stringify(vec)],
      ).catch(() => {});
      n++;
    } catch {
      /* embed flake — skip this clause */
    }
  }
  return n;
}

/** One-time backfill: chunk every active long memory that has no windows yet. */
export async function chunkBackfill(limit = 200): Promise<{ checked: number; chunked: number; windows: number }> {
  const rows = await pg_all(
    `SELECT id, content FROM public.memories
     WHERE superseded_at IS NULL AND length(content) > $1
       AND NOT EXISTS (SELECT 1 FROM public.memory_windows w WHERE w.memory_id = memories.id)
     LIMIT ${Math.min(Math.max(Number(limit) || 200, 1), 500)}`,
    [MAX_COMPOUND_LEN],
  );
  let chunked = 0;
  let windows = 0;
  for (const r of rows) {
    const n = await chunkMemory(r.id, String(r.content || "")).catch(() => 0);
    if (n > 0) chunked++;
    windows += n;
  }
  if (rows.length) logger.info({ module: "compoundSplitter", checked: rows.length, chunked, windows }, `chunk backfill done`);
  return { checked: rows.length, chunked, windows };
}

export async function runCompoundSplit(): Promise<{
  checked: number;
  compounds: number;
  facts: number;
  superseded: number;
  failed: number;
  skipped_running?: boolean;
}> {
  if (running) return { checked: 0, compounds: 0, facts: 0, superseded: 0, failed: 0, skipped_running: true };
  running = true;
  try {
    const rows = await pg_all(
      `SELECT id, user_id, project_id, content, sector, memory_tier, importance_tier, importance_score, decay_rate, metadata
       FROM public.memories WHERE superseded_at IS NULL AND length(content) > $1`,
      [MAX_COMPOUND_LEN],
    );
    let compounds = 0;
    let facts = 0;
    let superseded = 0;
    let failed = 0;
    for (const m of rows) {
      const clauses = splitClauses(String(m.content || "")).filter((c) => c.length >= MIN_CLAUSE_LEN);
      if (clauses.length < 2) continue; // long single sentence — not a compound
      compounds++;
      try {
        const newIds: string[] = [];
        for (const clause of clauses) {
          const vec = normalizeEmbedding(await embed(clause));
          const id = crypto.randomUUID();
          await pg_run(
            `INSERT INTO public.memories
               (id, user_id, project_id, content, sector, is_genome, memory_tier, importance_tier,
                importance_score, recorded_at, superseded_at, embedding, embedding_synthetic, decay_rate, access_count, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), NULL, $10::halfvec, $11, $12, 0, $13::jsonb)`,
            [
              id,
              m.user_id ?? "anonymous",
              m.project_id ?? null,
              clause,
              m.sector,
              false,
              m.memory_tier ?? "active",
              m.importance_tier,
              m.importance_score,
              JSON.stringify(vec),
              false,
              m.decay_rate ?? 0.1,
              JSON.stringify({ ...(m.metadata ?? {}), split_from: m.id }),
            ],
          );
          newIds.push(id);
        }
        await supersedeMemories([m.id], "compound-split", {
          check: "compound_split",
          facts: newIds,
          length: String(m.content || "").length,
        });
        facts += newIds.length;
        superseded++;
      } catch (e: any) {
        failed++;
        logger.warn({ module: "compoundSplitter", id: m.id, err: e?.message }, `split failed`);
      }
    }
    logger.info({ module: "compoundSplitter", checked: rows.length, compounds, facts, superseded, failed }, `compound split pass done`);
    return { checked: rows.length, compounds, facts, superseded, failed };
  } finally {
    running = false;
  }
}
