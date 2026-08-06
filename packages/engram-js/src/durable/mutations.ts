/*
 - filename: packages/engram-js/src/durable/mutations.ts
 - what is the file used for: SHARED memory mutation + audit primitives for the
   consolidation engine AND the memory integrity engine (v4.4.0-integrity).
   Both engines mutate memories through these functions ONLY — one mutation
   path, one audit format. Every mutation writes an audit_log row with
   before/after state, so the Memory Audit tab is the complete
   "changed or manipulated" surface (previously consolidation mutated via
   inline raw SQL with NO audit trail).
*/

import { all_async as pg_all, run_async as pg_run } from "../database/connection";
import { logger } from "../utils/logger";
import crypto from "node:crypto";

export interface AuditEntry {
  actor_id: string;
  actor_type?: string;
  event_type: string;
  user_id?: string;
  project_id?: string;
  target_table: string;
  target_id?: string | null;
  operation: string;
  before_state?: unknown;
  after_state?: unknown;
  metadata?: unknown;
}

export async function recordMemoryAudit(e: AuditEntry): Promise<void> {
  // audit_log.id is uuid pk WITHOUT a default — always supply one (the
  // pre-fix code omitted it and every audit insert silently failed).
  await pg_run(
    `INSERT INTO public.audit_log
       (id, user_id, project_id, actor_id, actor_type, event_type, target_table, target_id, operation, before_state, after_state, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb)`,
    [
      crypto.randomUUID(),
      e.user_id ?? null,
      e.project_id ?? null,
      e.actor_id,
      e.actor_type ?? "system",
      e.event_type,
      e.target_table,
      e.target_id ?? null,
      e.operation,
      e.before_state !== undefined ? JSON.stringify(e.before_state) : null,
      e.after_state !== undefined ? JSON.stringify(e.after_state) : null,
      e.metadata !== undefined ? JSON.stringify(e.metadata) : null,
    ],
  ).catch((err: any) => {
    logger.warn({ module: "mutations", err: err?.message }, "audit write failed");
  });
}

const ROW_SELECT = `id, user_id, project_id, content, sector, is_genome, memory_tier, importance_tier, importance_score, recorded_at, superseded_at`;

async function fetchRows(ids: string[]): Promise<any[]> {
  if (!ids.length) return [];
  return pg_all(`SELECT ${ROW_SELECT} FROM public.memories WHERE id = ANY($1::uuid[])`, [ids]);
}

/** Hard-delete memories with a per-row audit (before-state preserved). */
export async function hardDeleteMemories(
  ids: string[],
  actor = "auto-heal",
  metadata?: unknown,
): Promise<number> {
  const valid = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (!valid.length) return 0;
  const before = await fetchRows(valid);
  await pg_run(`DELETE FROM public.memories WHERE id = ANY($1::uuid[])`, [valid]);
  for (const row of before) {
    await recordMemoryAudit({
      actor_id: actor,
      event_type: "integrity_repair",
      operation: "delete",
      target_table: "memories",
      target_id: row.id,
      before_state: row,
      metadata,
    });
  }
  return before.length;
}

/** Soft-delete (supersede) memories — reversible by clearing superseded_at. */
export async function supersedeMemories(
  ids: string[],
  actor = "auto-heal",
  metadata?: unknown,
): Promise<number> {
  const valid = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (!valid.length) return 0;
  const before = await fetchRows(valid);
  const now = new Date().toISOString();
  await pg_run(`UPDATE public.memories SET superseded_at = now() WHERE id = ANY($1::uuid[])`, [valid]);
  for (const row of before) {
    await recordMemoryAudit({
      actor_id: actor,
      event_type: "integrity_repair",
      operation: "supersede",
      target_table: "memories",
      target_id: row.id,
      before_state: row,
      after_state: { ...row, superseded_at: now },
      metadata,
    });
  }
  return before.length;
}

/** Update a memory's content (+ optional metadata sector/is_genome/decay_rate —
 *  used by consolidation merge/update actions). `set_columns: true` also
 *  updates the is_genome/decay_rate COLUMNS (promote semantics — matches the
 *  original consolidation behavior exactly). */
export async function updateMemoryContent(
  id: string,
  content: string,
  actor = "auto-heal",
  opts: {
    sector?: string;
    is_genome?: boolean;
    decay_rate?: number;
    set_columns?: boolean;
    metadata?: unknown;
  } = {},
): Promise<boolean> {
  const before = await fetchRows([id]);
  if (!before.length) return false;
  const row = before[0];

  const sets: string[] = ["content = $2"];
  const params: any[] = [id, content];
  const jsonbSets: string[] = [];
  const colSets: string[] = [];
  if (opts.sector !== undefined) {
    params.push(opts.sector);
    jsonbSets.push(`'{sector}', to_jsonb($${params.length}::text)`);
  }
  if (opts.is_genome !== undefined) {
    params.push(opts.is_genome);
    jsonbSets.push(`'{is_genome}', to_jsonb($${params.length}::boolean)`);
    if (opts.set_columns) colSets.push(`is_genome = $${params.length}`);
  }
  if (opts.decay_rate !== undefined) {
    params.push(opts.decay_rate);
    jsonbSets.push(`'{decay_rate}', to_jsonb($${params.length}::numeric)`);
    if (opts.set_columns) colSets.push(`decay_rate = $${params.length}`);
  }
  let metaExpr = "metadata";
  for (const pair of jsonbSets) metaExpr = `jsonb_set(${metaExpr}, ${pair})`;
  if (jsonbSets.length) sets.push(`metadata = ${metaExpr}`);
  sets.push(...colSets);

  await pg_run(`UPDATE public.memories SET ${sets.join(", ")} WHERE id = $1`, params);
  await recordMemoryAudit({
    actor_id: actor,
    event_type: "integrity_repair",
    operation: "update",
    target_table: "memories",
    target_id: id,
    before_state: { content: row.content, sector: row.sector, is_genome: row.is_genome, decay_rate: row.decay_rate },
    after_state: {
      content,
      sector: opts.sector ?? row.sector,
      is_genome: opts.is_genome ?? row.is_genome,
      decay_rate: opts.decay_rate ?? row.decay_rate,
    },
    metadata: opts.metadata,
  });
  return true;
}

/** Reclassify a memory's sector (normalize BEFORE calling). */
export async function reclassifyMemorySector(
  id: string,
  sector: string,
  actor = "auto-heal",
  metadata?: unknown,
): Promise<boolean> {
  const before = await fetchRows([id]);
  if (!before.length) return false;
  const row = before[0];
  await pg_run(`UPDATE public.memories SET sector = $2 WHERE id = $1`, [id, sector]);
  await recordMemoryAudit({
    actor_id: actor,
    event_type: "integrity_repair",
    operation: "reclassify",
    target_table: "memories",
    target_id: id,
    before_state: { content: row.content, sector: row.sector },
    after_state: { content: row.content, sector },
    metadata,
  });
  return true;
}
