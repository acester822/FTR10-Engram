/*
 - filename: packages/engram-js/src/services/traceGovernance.ts
 - what is the file used for: judge governance — CALIBRATION (curated traces
   with human-labeled expected scores, re-scored on demand to measure judge
   agreement) and CONSISTENCY (re-scoring a random sample N times to measure
   variance). This is the "trust the judge" checkpoint: before any score can
   drive an action (auto-heal, repair, delete), the judge itself must be
   calibrated, stable, and policy-governed. All scoring here is
   non-persisting (persist:false) — it never pollutes the trace store.
*/

import { all_async as pg_all, run_async as pg_run } from "../database/connection";
import { scoreTrace, autoScoreDimensionFor, TRACE_DIMENSIONS } from "./traceScorer";

// ── Calibration set CRUD ────────────────────────────────────────────────

export async function listCalibration(): Promise<any[]> {
  return pg_all(
    `SELECT c.id, c.trace_id, c.dimension, c.expected_score, c.note, c.active, c.created_at,
            t.route, t.ts, t.scores
     FROM public.judge_calibration c
     LEFT JOIN public.traces t ON t.id = c.trace_id
     ORDER BY c.created_at DESC`,
    [],
  );
}

export async function addCalibration(input: {
  trace_id: string;
  dimension: string;
  expected_score: number;
  note?: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!TRACE_DIMENSIONS.includes(input.dimension as any)) {
    return { ok: false, error: `dimension must be one of: ${TRACE_DIMENSIONS.join(", ")}` };
  }
  const exp = Number(input.expected_score);
  if (!Number.isFinite(exp) || exp < 0 || exp > 1) {
    return { ok: false, error: "expected_score must be a number 0..1" };
  }
  const rows = await pg_all(
    `INSERT INTO public.judge_calibration (trace_id, dimension, expected_score, note)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.trace_id, input.dimension, exp, input.note ?? null],
  );
  return { ok: true, id: rows[0]?.id };
}

export async function updateCalibration(
  id: string,
  patch: { expected_score?: number; note?: string; active?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const sets: string[] = [];
  const params: any[] = [];
  if (patch.expected_score !== undefined) {
    const exp = Number(patch.expected_score);
    if (!Number.isFinite(exp) || exp < 0 || exp > 1) return { ok: false, error: "expected_score must be 0..1" };
    params.push(exp);
    sets.push(`expected_score = $${params.length}`);
  }
  if (patch.note !== undefined) {
    params.push(patch.note);
    sets.push(`note = $${params.length}`);
  }
  if (patch.active !== undefined) {
    params.push(patch.active);
    sets.push(`active = $${params.length}`);
  }
  if (!sets.length) return { ok: false, error: "nothing to update" };
  params.push(id);
  await pg_run(`UPDATE public.judge_calibration SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
  return { ok: true };
}

export async function deleteCalibration(id: string): Promise<boolean> {
  const rows = await pg_all(`DELETE FROM public.judge_calibration WHERE id = $1 RETURNING id`, [id]);
  return rows.length > 0;
}

// ── Calibration run: re-score each entry fresh (non-persisting) vs human label ──

export async function runCalibration(
  tolerance = 0.15,
): Promise<{
  checked: number;
  agree: number;
  agree_rate: number | null;
  avg_abs_error: number | null;
  entries: Array<{
    id: string;
    trace_id: string;
    route: string | null;
    ts: string | null;
    dimension: string;
    expected: number;
    actual: number | null;
    match: boolean | null;
    note: string | null;
  }>;
}> {
  const entries = await listCalibration();
  const results: any[] = [];
  let agree = 0;
  let absErrSum = 0;
  for (const e of entries) {
    const r = await scoreTrace(e.trace_id, e.dimension, { persist: false });
    const actual = r.ok && r.score !== undefined ? r.score : null;
    const match = actual !== null ? Math.abs(actual - e.expected_score) <= tolerance : null;
    if (match === true) agree++;
    if (actual !== null) absErrSum += Math.abs(actual - e.expected_score);
    results.push({
      id: e.id,
      trace_id: e.trace_id,
      route: e.route ?? null,
      ts: e.ts ?? null,
      dimension: e.dimension,
      expected: e.expected_score,
      actual,
      match,
      note: e.note ?? null,
    });
  }
  return {
    checked: results.length,
    agree,
    agree_rate: results.length ? Math.round((agree / results.length) * 100) / 100 : null,
    avg_abs_error: results.length ? Math.round((absErrSum / results.length) * 1000) / 1000 : null,
    entries: results,
  };
}

// ── Consistency run: re-score a random sample N times, measure variance ──

export async function runConsistency(
  samples = 5,
  repeats = 3,
): Promise<{
  checked: number;
  repeats: number;
  overall_mean_abs_dev: number | null;
  per_trace: Array<{
    trace_id: string;
    route: string | null;
    dimension: string;
    scores: number[];
    mean: number;
    mad: number;
  }>;
}> {
  const rows = await pg_all(
    `SELECT id, route, label FROM public.traces ORDER BY random() LIMIT $1`,
    [Math.min(Math.max(samples, 1), 20)],
  );
  const perTrace: any[] = [];
  let sumMAD = 0;
  let n = 0;
  for (const t of rows) {
    const dim = autoScoreDimensionFor(t);
    if (!dim) continue;
    const scores: number[] = [];
    for (let i = 0; i < Math.min(Math.max(repeats, 1), 10); i++) {
      const r = await scoreTrace(t.id, dim, { persist: false });
      if (r.ok && r.score !== undefined) scores.push(r.score);
    }
    if (scores.length >= 2) {
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      const mad = scores.reduce((a, b) => a + Math.abs(b - mean), 0) / scores.length;
      sumMAD += mad;
      n++;
      perTrace.push({
        trace_id: t.id,
        route: t.route ?? null,
        dimension: dim,
        scores,
        mean: Math.round(mean * 100) / 100,
        mad: Math.round(mad * 100) / 100,
      });
    }
  }
  return {
    checked: perTrace.length,
    repeats,
    overall_mean_abs_dev: n ? Math.round((sumMAD / n) * 1000) / 1000 : null,
    per_trace: perTrace,
  };
}
