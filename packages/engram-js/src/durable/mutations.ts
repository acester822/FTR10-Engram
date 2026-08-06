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

// Full row incl. embedding so a hard-delete can be UNDONE faithfully
// (before_state stored on every mutation carries everything needed to restore).
const ROW_SELECT = `id, user_id, project_id, content, sector, is_genome, memory_tier, importance_tier, importance_score, recorded_at, superseded_at, embedding, embedding_synthetic, decay_rate, access_count, metadata`;

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

// ── Undo ─────────────────────────────────────────────────────────────────
// Reverses an audited mutation using its before_state. Supersede = clear
// superseded_at (trivially reversible). Delete = re-insert the full row
// (embedding restored from before_state). Update/reclassify = write back the
// captured fields. Every undo writes its own audit row so the trail is
// complete and an undo is never itself undoable.

export async function undoAuditEntry(
  auditId: string,
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const rows = await pg_all(`SELECT * FROM public.audit_log WHERE id = $1`, [auditId]);
  if (!rows.length) return { ok: false, error: "audit entry not found" };
  const a = rows[0];
  if (a.event_type === "memory_undo") return { ok: false, error: "cannot undo an undo" };
  const op = a.operation;
  const targetId = a.target_id;
  const before = a.before_state ?? null;

  if (op === "supersede") {
    const cur = await pg_all(`SELECT id, superseded_at FROM public.memories WHERE id = $1`, [targetId]);
    if (!cur.length) return { ok: false, error: "memory no longer exists" };
    if (!cur[0].superseded_at) return { ok: false, message: "memory is not superseded — nothing to undo" };
    await pg_run(`UPDATE public.memories SET superseded_at = NULL WHERE id = $1`, [targetId]);
    await recordMemoryAudit({
      actor_id: "user",
      actor_type: "user",
      event_type: "memory_undo",
      operation: "undo_supersede",
      target_table: "memories",
      target_id: targetId,
      before_state: { superseded_at: cur[0].superseded_at },
      after_state: { superseded_at: null },
      metadata: { undo_of: auditId },
    });
    return { ok: true, message: "supersede undone — memory active again" };
  }

  if (op === "delete") {
    if (!before || !before.id) return { ok: false, error: "before_state missing — cannot restore this delete" };
    const exists = await pg_all(`SELECT id FROM public.memories WHERE id = $1`, [before.id]);
    if (exists.length) return { ok: false, error: "memory already exists" };
    await pg_run(
      `INSERT INTO public.memories
         (id, user_id, project_id, content, sector, is_genome, memory_tier, importance_tier, importance_score,
          recorded_at, superseded_at, embedding, embedding_synthetic, decay_rate, access_count, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::halfvec, $13, $14, $15, $16::jsonb)`,
      [
        before.id,
        before.user_id ?? "anonymous",
        before.project_id ?? null,
        before.content ?? "",
        before.sector ?? "semantic",
        before.is_genome ?? false,
        before.memory_tier ?? "active",
        before.importance_tier ?? "medium",
        before.importance_score ?? 0.5,
        before.recorded_at ?? new Date().toISOString(),
        before.superseded_at ?? null,
        before.embedding ?? null,
        before.embedding_synthetic ?? false,
        before.decay_rate ?? 0.1,
        before.access_count ?? 0,
        JSON.stringify(before.metadata ?? {}),
      ],
    );
    await recordMemoryAudit({
      actor_id: "user",
      actor_type: "user",
      event_type: "memory_undo",
      operation: "undo_delete",
      target_table: "memories",
      target_id: before.id,
      before_state: { deleted: true },
      after_state: { id: before.id, content: before.content, sector: before.sector },
      metadata: { undo_of: auditId },
    });
    return { ok: true, message: "delete undone — memory restored" };
  }

  if (op === "update" || op === "reclassify") {
    if (!before || !targetId) return { ok: false, error: "before_state missing — cannot undo" };
    const cur = await pg_all(`SELECT id, content, sector, is_genome, decay_rate FROM public.memories WHERE id = $1`, [targetId]);
    if (!cur.length) return { ok: false, error: "memory no longer exists" };
    const sets: string[] = [];
    const params: any[] = [targetId];
    if (before.content !== undefined && before.content !== cur[0].content) {
      params.push(before.content);
      sets.push(`content = $${params.length}`);
    }
    if (before.sector !== undefined && before.sector !== cur[0].sector) {
      params.push(before.sector);
      sets.push(`sector = $${params.length}`);
    }
    if (before.is_genome !== undefined && before.is_genome !== cur[0].is_genome) {
      params.push(before.is_genome);
      sets.push(`is_genome = $${params.length}`);
    }
    if (before.decay_rate !== undefined && before.decay_rate !== cur[0].decay_rate) {
      params.push(before.decay_rate);
      sets.push(`decay_rate = $${params.length}`);
    }
    if (sets.length) {
      await pg_run(`UPDATE public.memories SET ${sets.join(", ")} WHERE id = $1`, params);
    }
    await recordMemoryAudit({
      actor_id: "user",
      actor_type: "user",
      event_type: "memory_undo",
      operation: `undo_${op}`,
      target_table: "memories",
      target_id: targetId,
      before_state: { content: cur[0].content, sector: cur[0].sector },
      after_state: before,
      metadata: { undo_of: auditId },
    });
    return { ok: true, message: `${op} undone — fields restored` };
  }

  return { ok: false, error: `operation '${op}' is not undoable` };
}
