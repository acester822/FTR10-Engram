/*
 - filename: packages/engram-js/src/durable/chunks.ts
 - what is the file used for: recall-time CHUNK BOOST + window backfill.
   v4.7.6: memory_windows (token-window embeddings, written by
   WindowedEmbedder at write time) existed but was empty — the store's long
   memories predate the windowed-embedding feature. The scored /recall path
   also never joined windows (only HybridSearch did). This module (1) boosts
   recall results whose clause-chunk matches the query better than the
   memory's own embedding (the compound-dilution class), and (2) backfills
   windows for pre-existing long memories using the SAME WindowedEmbedder so
   there is exactly one window source of truth.
*/

import { all_async as pg_all, run_async as pg_run } from "../database/connection";
import { WindowedEmbedder } from "../services/windowedEmbedder";
import { logger } from "../utils/logger";

/** Recall-time chunk boost: a memory whose window-chunk matches the query
 *  better than its own embedding gets the chunk score (max-pool), so a
 *  specific fact buried in a long memory surfaces. Best-effort, additive —
 *  never lowers an existing score. */
export async function chunkBoost(
  query: number[] | string,
  results: Array<{ id: string; score?: number | null }>,
  schema = process.env.EG_PG_SCHEMA || "public",
): Promise<number> {
  if (!results.length) return 0;
  const emb = Array.isArray(query) ? query : [];
  if (!emb.length) return 0;
  const ids = results.map((r) => r.id).filter(Boolean);
  if (!ids.length) return 0;
  let boosted = 0;
  try {
    const cRes = await pg_all(
      `SELECT memory_id, max(1 - (embedding <=> $1::halfvec)) AS sim
       FROM ${schema}.memory_windows WHERE memory_id = ANY($2::uuid[])
       GROUP BY memory_id`,
      [JSON.stringify(emb), ids],
    ).catch(() => []);
    const chunkSim = new Map<string, number>();
    for (const r of cRes) chunkSim.set(r.memory_id, Number(r.sim));
    for (const r of results) {
      const cs = chunkSim.get(r.id);
      if (cs !== undefined && cs > Number(r.score ?? 0)) {
        r.score = Math.round(cs * 1000) / 1000;
        boosted++;
      }
    }
  } catch {
    /* best-effort */
  }
  return boosted;
}

/** Backfill windows for active long memories that have none, using the SAME
 *  WindowedEmbedder as the write path (one window source of truth). */
export async function backfillWindows(limit = 200): Promise<{ checked: number; windowed: number; skipped: number }> {
  const rows = await pg_all(
    `SELECT id, content FROM public.memories
     WHERE superseded_at IS NULL AND length(content) > 300
       AND NOT EXISTS (SELECT 1 FROM public.memory_windows w WHERE w.memory_id = memories.id)
     LIMIT ${Math.min(Math.max(Number(limit) || 200, 1), 500)}`,
    [],
  );
  const embedder = new WindowedEmbedder({
    query: async (sql: string, params?: unknown[]) => {
      const rows2 = await pg_all(sql, params ?? []);
      return { rows: rows2 };
    },
  });
  let windowed = 0;
  for (const r of rows) {
    try {
      await embedder.embedMemory(r.id, String(r.content || ""));
      windowed++;
    } catch {
      /* skip on embed flake */
    }
  }
  if (rows.length) logger.info({ module: "chunks", checked: rows.length, windowed }, `window backfill done`);
  return { checked: rows.length, windowed, skipped: rows.length - windowed };
}
