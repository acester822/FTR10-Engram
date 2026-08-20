/*
 - filename: packages/engram-js/src/services/outcomeTracker.ts
 - what is the file used for: outcome-aware memory tracking — populates
   memories_outcome_stats from traces where a memory was injected, then
   exposes the outcome signal for decay and recall ranking.
*/

import { all_async as pg_all, run_async as pg_run } from "../database/connection";
import { policyThresholds } from "./traceStore";
import { logger } from "../utils/logger";

// ── Config ───────────────────────────────────────────────────────────

export function outcomeTrackingEnabled(): boolean {
  return (process.env.EG_OUTCOME_TRACKING_ENABLED ?? "true").toLowerCase() !== "false";
}
const decayPenalty = (): number => {
  const n = Number(process.env.EG_OUTCOME_DECAY_PENALTY);
  return Number.isFinite(n) && n > 0 ? n : 2.0;
};
const decayBoost = (): number => {
  const n = Number(process.env.EG_OUTCOME_DECAY_BOOST);
  return Number.isFinite(n) && n > 0 ? n : 0.5;
};
const recallPenalty = (): number => {
  const n = Number(process.env.EG_OUTCOME_RECALL_PENALTY);
  return Number.isFinite(n) && n > 0 ? n : 0.5;
};
const recallBoost = (): number => {
  const n = Number(process.env.EG_OUTCOME_RECALL_BOOST);
  return Number.isFinite(n) && n > 0 ? n : 1.2;
};
const minRecalls = (): number => {
  const n = Number(process.env.EG_OUTCOME_MIN_RECALS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
};

// ── Populate outcome stats from traces ───────────────────────────────

/**
 * For each chat trace that had injection, upsert outcome stats for every
 * injected memory: recall_count += 1, answer_quality_sum += <aq score>.
 * Fire-and-forget, idempotent (ON CONFLICT DO UPDATE).
 */
export async function ingestOutcomeFromTrace(traceId: string): Promise<void> {
  if (!outcomeTrackingEnabled()) return;

  const traceRows = await pg_all(
    `SELECT injection, scores FROM public.traces WHERE id = $1 AND scores IS NOT NULL`,
    [traceId],
  ).catch(() => []);

  const trace = traceRows?.[0];
  if (!trace) return;

  // Extract answer_quality score from the trace's scores array
  const aqScore = extractAnswerQuality(trace.scores);
  if (aqScore === null) return;

  // Extract injected memory IDs from the injection field
  const injection = trace.injection || {};
  const memoryIds: string[] = [
    ...(Array.isArray(injection.genome_ids) ? injection.genome_ids : []),
    ...(Array.isArray(injection.phenotype_ids) ? injection.phenotype_ids : []),
    ...(Array.isArray(injection.genome) ? injection.genome : []),
    ...(Array.isArray(injection.phenotype) ? injection.phenotype : []),
  ].filter((id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id));

  if (memoryIds.length === 0) return;

  for (const memoryId of memoryIds) {
    await pg_run(
      `INSERT INTO public.memories_outcome_stats
         (memory_id, window_days, recall_count, answer_quality_sum, answer_quality_count, last_calculated_at)
       VALUES ($1, 7, 1, $2, 1, now())
       ON CONFLICT (memory_id, window_days) DO UPDATE SET
         recall_count = public.memories_outcome_stats.recall_count + 1,
         answer_quality_sum = public.memories_outcome_stats.answer_quality_sum + $2,
         answer_quality_count = public.memories_outcome_stats.answer_quality_count + 1,
         last_calculated_at = now()`,
      [memoryId, aqScore],
    ).catch(() => {});
  }
}

function extractAnswerQuality(scores: any): number | null {
  if (!scores) return null;
  const arr = Array.isArray(scores) ? scores : JSON.parse(scores as string);
  if (!Array.isArray(arr)) return null;
  const aq = arr.find((s: any) => s.dimension === "answer_quality" && typeof s.score === "number");
  return aq ? aq.score : null;
}

// ── Outcome signal lookup ────────────────────────────────────────────

export interface OutcomeSignal {
  avg_answer_quality: number | null;
  recall_count: number;
  /** Multiplier for decay rate: >1 means decay faster (bad outcome),
   *  <1 means decay slower (good outcome), 1 = neutral. */
  decayMultiplier: number;
  /** Multiplier for recall score: >1 means rank higher, <1 means rank lower. */
  recallMultiplier: number;
}

const NEUTRAL: OutcomeSignal = {
  avg_answer_quality: null,
  recall_count: 0,
  decayMultiplier: 1.0,
  recallMultiplier: 1.0,
};

export function outcomeFor(memoryId: string, row?: any): OutcomeSignal {
  if (!row) return NEUTRAL;

  const avg = row.avg_answer_quality !== null && row.avg_answer_quality !== undefined
    ? Number(row.avg_answer_quality)
    : null;
  const recallCount = Number(row.recall_count ?? 0);

  if (avg === null || recallCount < minRecalls()) return NEUTRAL;

  const { good, bad } = policyThresholds();

  let decayMult = 1.0;
  let recallMult = 1.0;

  if (avg < bad) {
    // Memory drags answers down → decay faster, recall lower
    decayMult = decayPenalty();
    recallMult = recallPenalty();
  } else if (avg > good) {
    // Memory helps answers → decay slower, recall higher
    decayMult = decayBoost();
    recallMult = recallBoost();
  }

  return { avg_answer_quality: avg, recall_count: recallCount, decayMultiplier: decayMult, recallMultiplier: recallMult };
}

// ── Batch outcome lookup (for recall ranking) ────────────────────────

export async function outcomeBatch(memoryIds: string[]): Promise<Map<string, OutcomeSignal>> {
  if (memoryIds.length === 0) return new Map();
  const rows = await pg_all(
    `SELECT memory_id, avg_answer_quality, recall_count
     FROM public.memories_outcome_stats
     WHERE memory_id = ANY($1::uuid[]) AND window_days = 7`,
    [memoryIds],
  ).catch(() => []);

  const out = new Map<string, OutcomeSignal>();
  for (const row of rows || []) {
    out.set(row.memory_id, outcomeFor(row.memory_id, row));
  }
  return out;
}

// ── Backfill: scan all scored chat traces and populate stats ─────────

export async function backfillOutcomes(days = 30): Promise<number> {
  const traces = await pg_all(
    `SELECT id FROM public.traces
     WHERE label IN ('chat', 'out')
       AND injection IS NOT NULL
       AND scores IS NOT NULL
       AND ts > now() - ($1::int * interval '1 day')
     ORDER BY ts ASC`,
    [days],
  ).catch(() => []);

  let count = 0;
  for (const t of traces || []) {
    await ingestOutcomeFromTrace(t.id);
    count++;
  }
  logger.info({ module: "outcomeTracker", traces_processed: count }, "outcome backfill complete");
  return count;
}
