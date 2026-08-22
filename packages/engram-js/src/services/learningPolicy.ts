/*
 - filename: packages/engram-js/src/services/learningPolicy.ts
 - what is the file used for: living-model learning loop — reads judge score
   trends from traces, proposes hyperparameter adjustments (flag-first),
   and optionally auto-applies small deltas. Every change writes an
   audit_log row via settingsService.applySetting.
*/

import crypto from "node:crypto";
import { all_async as pg_all, run_async as pg_run } from "../database/connection";
import { policyThresholds } from "./traceStore";
import { saveSettings } from "./settingsService";
import { logger } from "../utils/logger";

// ── Configuration ─────────────────────────────────────────────────────

const DEFAULTS = {
  intervalMs: 24 * 60 * 60 * 1000,    // daily
  windowDays: 7,
  minTraces: 10,
  maxAutoDelta: 0.1,
  trendDeclineThreshold: -0.02,
};

// ── Types ─────────────────────────────────────────────────────────────

export interface LearningProposal {
  id: string;
  dimension: "recall_relevance" | "extraction_fidelity" | "answer_quality";
  metric: "avg" | "trend_slope" | "count_below_bad";
  observed_value: number;
  threshold_breached: number;
  target_knob: string;
  current_value: string;
  proposed_value: string;
  rationale: string;
  status: "open" | "applied" | "dismissed" | "reverted";
  created_at: string;
  applied_at?: string;
  applied_by?: string;
  reverted_at?: string;
  revert_reason?: string;
}

export interface ScoreWindow {
  dimension: string;
  avg: number;
  count: number;
  slope: number;
  countBelowBad: number;
  dailyAvgs: number[];
}

// ── Knob mapping: dimension → knob ───────────────────────────────────
// Each entry: the knob to adjust, and a function that produces the proposed
// new value from the current value and the observed score.

interface KnobMapping {
  knob: string;
  label: string;
  direction: "lower_is_better" | "raise_is_better";
  propose: (current: number, avg: number, good: number, bad: number) => number;
  clamp: [number, number];
}

const KNOB_MAPPINGS: Record<string, KnobMapping[]> = {
  recall_relevance: [
    // Low recall → trust keyword evidence more (lower floor so weak vectors
    // don't crowd out keyword matches)
    {
      knob: "general.hybrid_vector_floor",
      label: "Vector probability floor",
      direction: "lower_is_better",
      propose: (current, avg, good, bad) => {
        // Nudge floor down by up to 0.05 to let more keyword results in
        return Math.max(0.1, current - 0.05 * (bad - avg));
      },
      clamp: [0.05, 0.5],
    },
    {
      knob: "general.hybrid_keyword_scale",
      label: "Keyword probability scale",
      direction: "raise_is_better",
      propose: (current, avg, good, bad) => {
        return Math.min(3.0, current + 0.2 * (bad - avg));
      },
      clamp: [1.0, 4.0],
    },
  ],
  extraction_fidelity: [
    // Low extraction → tighten DO-NOT-EXTRACT by lowering the floor? No, that's
    // in the prompt. Instead raise the auto-search confidence so missing facts
    // get fetched from the web.
    {
      knob: "general.auto_search_min_confidence",
      label: "Auto-search confidence threshold",
      direction: "lower_is_better",
      propose: (current, avg, good, bad) => {
        return Math.max(0.3, current - 0.05);
      },
      clamp: [0.1, 0.9],
    },
  ],
  answer_quality: [
    // Low answer quality with high injection → reduce injection count
    {
      knob: "general.compact_trigger",
      label: "Compaction trigger (messages)",
      direction: "raise_is_better",
      propose: (current, avg, good, bad) => {
        // Higher trigger = less context injection pressure per turn
        return Math.min(200, current + 10);
      },
      clamp: [20, 500],
    },
  ],
};

// ── Config readers ───────────────────────────────────────────────────

function intervalMs(): number {
  const n = Number(process.env.EG_LEARNING_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULTS.intervalMs;
}
function windowDays(): number {
  const n = Number(process.env.EG_LEARNING_WINDOW_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULTS.windowDays;
}
function autoApply(): boolean {
  return (process.env.EG_LEARNING_AUTO_APPLY ?? "false").toLowerCase() === "true";
}
function maxAutoDelta(): number {
  const n = Number(process.env.EG_LEARNING_MAX_DELTA);
  return Number.isFinite(n) && n > 0 ? n : DEFAULTS.maxAutoDelta;
}
function minTraces(): number {
  const n = Number(process.env.EG_LEARNING_MIN_TRACES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULTS.minTraces;
}

// ── Score aggregation ────────────────────────────────────────────────

/** Compute per-dimension score stats from traces in the window. */
async function computeScoreWindows(days: number): Promise<ScoreWindow[]> {
  const dims = ["recall_relevance", "extraction_fidelity", "answer_quality"] as const;
  const windows: ScoreWindow[] = [];

  for (const dimension of dims) {
    // Daily averages for slope computation
    const dailyRows = await pg_all(
      `SELECT date_trunc('day', ts)::date AS day,
              avg((s->>'score')::float) AS day_avg,
              count(*) AS day_count
       FROM public.traces t, jsonb_array_elements(t.scores) s
       WHERE t.scores IS NOT NULL
         AND t.ts > now() - ($1::int * interval '1 day')
         AND (s->>'dimension') = $2
         AND (s->>'score') IS NOT NULL
       GROUP BY day
       ORDER BY day ASC`,
      [days, dimension],
    ).catch(() => []);

    if (!dailyRows || dailyRows.length === 0) continue;

    const dailyAvgs: number[] = dailyRows.map((r: any) =>
      Number.isFinite(Number(r.day_avg)) ? Number(r.day_avg) : null,
    ).filter((v: number | null) => v !== null) as number[];

    if (dailyAvgs.length === 0) continue;

    // Overall avg + count
    const overall = await pg_all(
      `SELECT avg((s->>'score')::float) AS avg_score,
              count(*) AS total,
              count(*) FILTER (WHERE (s->>'score')::float < $3) AS below_bad
       FROM public.traces t, jsonb_array_elements(t.scores) s
       WHERE t.scores IS NOT NULL
         AND t.ts > now() - ($1::int * interval '1 day')
         AND (s->>'dimension') = $2
         AND (s->>'score') IS NOT NULL`,
      [days, dimension, policyThresholds().bad],
    ).catch(() => []);

    const avg = Number(overall?.[0]?.avg_score ?? 0);
    const count = Number(overall?.[0]?.total ?? 0);
    const countBelowBad = Number(overall?.[0]?.below_bad ?? 0);

    // Linear regression slope on daily avgs
    let slope = 0;
    if (dailyAvgs.length >= 2) {
      const n = dailyAvgs.length;
      const xMean = (n - 1) / 2;
      const yMean = dailyAvgs.reduce((a, b) => a + b, 0) / n;
      let num = 0,
        den = 0;
      for (let i = 0; i < n; i++) {
        num += (i - xMean) * (dailyAvgs[i] - yMean);
        den += (i - xMean) ** 2;
      }
      slope = den > 0 ? num / den : 0;
    }

    windows.push({ dimension, avg, count, slope, countBelowBad, dailyAvgs });
  }

  return windows;
}

// ── Knob reading ─────────────────────────────────────────────────────

function readKnob(knob: string): number {
  const v = process.env[envKeyForKnob(knob)];
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function envKeyForKnob(knob: string): string {
  // knob is like "general.hybrid_vector_floor" → env EG_HYBRID_VECTOR_FLOOR
  const short = knob.replace(/^general\./, "").replace(/^hybrid_/, "HYBRID_").replace(/^auto_search_/, "AUTO_SEARCH_").toUpperCase();
  // Build the env key from the GENERAL_SETTINGS lookup instead
  const { GENERAL_SETTINGS } = require("./settingsService");
  const def = GENERAL_SETTINGS.find((d: any) => d.key === knob);
  return def?.env || `EG_${short}`;
}

// ── Proposal creation ────────────────────────────────────────────────

async function createProposal(
  dimension: string,
  metric: string,
  observedValue: number,
  thresholdBreached: number,
  knob: string,
  currentValue: number,
  proposedValue: number,
  rationale: string,
): Promise<LearningProposal> {
  const id = crypto.randomUUID();
  await pg_run(
    `INSERT INTO public.learning_proposals
       (id, dimension, metric, observed_value, threshold_breached,
        target_knob, current_value, proposed_value, rationale, status)
     VALUES ($1, $2, $3, $4, $5, $6::text, $7::text, $8::text, $9, 'open')`,
    [id, dimension, metric, observedValue, thresholdBreached, knob, String(currentValue), String(proposedValue), rationale],
  ).catch((err: any) => {
    logger.warn({ module: "learningPolicy", err: err?.message }, "failed to write proposal");
  });

  return {
    id,
    dimension: dimension as LearningProposal["dimension"],
    metric: metric as LearningProposal["metric"],
    observed_value: observedValue,
    threshold_breached: thresholdBreached,
    target_knob: knob,
    current_value: String(currentValue),
    proposed_value: String(proposedValue),
    rationale,
    status: "open",
    created_at: new Date().toISOString(),
  };
}

/** Apply a proposal: update the env key in app_settings + audit_log. */
export async function applyProposal(id: string): Promise<{ ok: boolean; error?: string }> {
  const rows = await pg_all(
    `SELECT target_knob, proposed_value, current_value, status
     FROM public.learning_proposals WHERE id = $1`,
    [id],
  ).catch(() => []);

  const row = rows?.[0];
  if (!row) return { ok: false, error: "proposal not found" };
  if (row.status !== "open") return { ok: false, error: `proposal is ${row.status}` };

  try {
    await saveSettings({ [row.target_knob]: String(row.proposed_value) });
  } catch (err: any) {
    return { ok: false, error: err?.message || "save failed" };
  }

  const envKey = envKeyForKnob(row.target_knob);
  process.env[envKey] = String(row.proposed_value);

  await pg_run(
    `UPDATE public.learning_proposals
     SET status = 'applied', applied_at = now(), applied_by = $2
     WHERE id = $1`,
    [id, "learning_loop"],
  ).catch(() => {});

  // Write audit log for the hyperparameter change
  await pg_run(
    `INSERT INTO public.audit_log
       (id, user_id, project_id, actor_id, actor_type, event_type, target_table, target_id, operation, before_state, after_state, metadata)
     VALUES ($1, null, null, 'learning_loop', 'system', 'learning.apply', 'learning_proposals', $2, 'apply', $3::jsonb, $4::jsonb, $5::jsonb)`,
    [
      crypto.randomUUID(),
      id,
      JSON.stringify({ knob: row.target_knob, value: row.current_value }),
      JSON.stringify({ knob: row.target_knob, value: row.proposed_value }),
      JSON.stringify({ dimension: row.dimension, metric: row.metric, observed_value: row.observed_value }),
    ],
  ).catch(() => {});

  logger.info({ module: "learningPolicy", id, knob: row.target_knob, value: row.proposed_value }, "proposal applied");
  return { ok: true };
}

export async function dismissProposal(id: string): Promise<void> {
  await pg_run(`UPDATE public.learning_proposals SET status = 'dismissed' WHERE id = $1`, [id]).catch(() => {});
}

export async function revertProposal(id: string, reason: string): Promise<void> {
  const rows = await pg_all(
    `SELECT target_knob, current_value, proposed_value, dimension FROM public.learning_proposals WHERE id = $1`,
    [id],
  ).catch(() => []);
  const row = rows?.[0];
  if (!row) return;
  try {
    await saveSettings({ [row.target_knob]: String(row.current_value) });
  } catch { /* noop */ }
  const envKey = envKeyForKnob(row.target_knob);
  process.env[envKey] = String(row.current_value);

  await pg_run(
    `UPDATE public.learning_proposals
     SET status = 'reverted', reverted_at = now(), revert_reason = $2
     WHERE id = $1`,
    [id, reason],
  ).catch(() => {});

  // Audit log for the revert
  await pg_run(
    `INSERT INTO public.audit_log
       (id, user_id, project_id, actor_id, actor_type, event_type, target_table, target_id, operation, before_state, after_state, metadata)
     VALUES ($1, null, null, 'learning_loop', 'system', 'learning.revert', 'learning_proposals', $2, 'revert', $3::jsonb, $4::jsonb, $5::jsonb)`,
    [
      crypto.randomUUID(),
      id,
      JSON.stringify({ knob: row.target_knob, value: row.proposed_value }),
      JSON.stringify({ knob: row.target_knob, value: row.current_value }),
      JSON.stringify({ reason, dimension: row.dimension }),
    ],
  ).catch(() => {});
}

// ── The learning run ─────────────────────────────────────────────────

export interface LearningRunResult {
  ran_at: string;
  gate_open: boolean;
  proposals_created: number;
  auto_applied: number;
  windows: Array<{ dimension: string; avg: number; count: number; slope: number }>;
}

export async function runLearning(): Promise<LearningRunResult> {
  const result: LearningRunResult = {
    ran_at: new Date().toISOString(),
    gate_open: false,
    proposals_created: 0,
    auto_applied: 0,
    windows: [],
  };

  // Gate: reuse integrity engine's judge gate (calibration + consistency + freshness)
  try {
    const { integrityGate } = require("./integrityEngine");
    const gate = await integrityGate();
    if (!gate.open) {
      logger.info({ module: "learningPolicy", reasons: gate.reasons }, "skipped — judge gate closed");
      return result;
    }
    result.gate_open = true;
  } catch {
    // If gate can't be checked, fail safe
    logger.info({ module: "learningPolicy" }, "skipped — judge gate unavailable");
    return result;
  }

  const windows = await computeScoreWindows(windowDays());
  const { good, bad } = policyThresholds();

  for (const w of windows) {
    result.windows.push({ dimension: w.dimension, avg: w.avg, count: w.count, slope: w.slope });

    if (w.count < minTraces()) {
      logger.debug({ module: "learningPolicy", dim: w.dimension, count: w.count }, "insufficient traces");
      continue;
    }

    // Determine if intervention is needed
    const isBad = w.avg < bad;
    const isDeclining = w.slope < DEFAULTS.trendDeclineThreshold;
    const metric = isBad ? "avg" : isDeclining ? "trend_slope" : null;
    if (!metric) continue;

    const observedValue = isBad ? w.avg : w.slope;
    const thresholdBreached = isBad ? bad : DEFAULTS.trendDeclineThreshold;

    // Find applicable knob(s) for this dimension
    const mappings = KNOB_MAPPINGS[w.dimension] || [];
    for (const mapping of mappings) {
      // Check for existing open proposal on this knob
      const existing = await pg_all(
        `SELECT id FROM public.learning_proposals
         WHERE target_knob = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
        [mapping.knob],
      ).catch(() => []);
      if (existing && existing.length > 0) continue;

      const current = readKnob(mapping.knob);
      const proposed = mapping.propose(current, w.avg, good, bad);
      const clamped = Math.max(mapping.clamp[0], Math.min(mapping.clamp[1], proposed));

      // Only propose if the change is meaningful (>1% shift)
      if (Math.abs(clamped - current) / (current || 1) < 0.01) continue;

      const rationale = `${w.dimension} ${metric}=${observedValue.toFixed(3)} ` +
        `(threshold ${thresholdBreached}, n=${w.count}, slope=${w.slope.toFixed(4)}) → ` +
        `${mapping.label}: ${current} → ${clamped}`;

      const proposal = await createProposal(
        w.dimension, metric, observedValue, thresholdBreached,
        mapping.knob, current, clamped, rationale,
      );
      result.proposals_created++;

      // Auto-apply small deltas if enabled
      if (autoApply() && Math.abs(clamped - current) <= maxAutoDelta()) {
        const r = await applyProposal(proposal.id);
        if (r.ok) result.auto_applied++;
      }
    }
  }

  logger.info(
    { module: "learningPolicy", proposals_created: result.proposals_created, auto_applied: result.auto_applied },
    "learning run complete",
  );
  return result;
}

// ── Proposal queries ─────────────────────────────────────────────────

export async function listProposals(filter: { status?: string; limit?: number } = {}): Promise<LearningProposal[]> {
  const params: unknown[] = [];
  const filters: string[] = [];
  if (filter.status) {
    params.push(filter.status);
    filters.push(`status = $${params.length}`);
  }
  const limit = Math.min(Math.max(filter.limit || 50, 1), 200);
  params.push(limit);

  return pg_all(
    `SELECT id, dimension, metric, observed_value, threshold_breached,
            target_knob, current_value, proposed_value, rationale, status,
            created_at, applied_at, applied_by, reverted_at, revert_reason
     FROM public.learning_proposals
     ${filters.length ? "WHERE " + filters.join(" AND ") : ""}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  ).catch(() => []);
}

// ── Status ───────────────────────────────────────────────────────────

export async function learningStatus(): Promise<{
  enabled: boolean;
  gate_open: boolean;
  last_run: string | null;
  open_proposals: number;
  total_proposals: number;
}> {
  const openRows = await pg_all(
    `SELECT count(*)::int AS n FROM public.learning_proposals WHERE status = 'open'`,
    [],
  ).catch(() => [{ n: 0 }]);
  const totalRows = await pg_all(
    `SELECT count(*)::int AS n FROM public.learning_proposals`,
    [],
  ).catch(() => [{ n: 0 }]);

  return {
    enabled: (process.env.EG_LEARNING_ENABLED ?? "true").toLowerCase() !== "false",
    gate_open: false,  // status check doesn't need to compute the full gate
    last_run: null,
    open_proposals: openRows[0]?.n || 0,
    total_proposals: totalRows[0]?.n || 0,
  };
}

// ── Scheduler ────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
export const learningEngine = {
  start(): void {
    if (timer) return;
    const tick = async () => {
      if ((process.env.EG_LEARNING_ENABLED ?? "true").toLowerCase() === "false") return;
      try {
        await runLearning();
      } catch (e: any) {
        logger.error({ module: "learningPolicy", err: e?.message }, "scheduled learning run failed");
      }
    };
    setTimeout(tick, 90000);  // 90s after boot (after engines warm up)
    timer = setInterval(tick, intervalMs());
  },
};
