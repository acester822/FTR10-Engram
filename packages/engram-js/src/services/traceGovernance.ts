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

/** Persisted judge eval results (the AUTOMATIC integrity Tier-2 gate reads the
 *  latest of each kind). Written by runCalibration / runConsistency. */
export async function persistJudgeEval(kind: "calibration" | "consistency", result: unknown): Promise<void> {
  await pg_run(
    `INSERT INTO public.judge_evals (kind, result) VALUES ($1, $2::jsonb)`,
    [kind, JSON.stringify(result)],
  ).catch((e: any) => {
    // non-fatal — the gate treats missing evals as closed
    console.warn("judge eval persist failed", e?.message);
  });
}

export async function latestJudgeEval(kind: "calibration" | "consistency"): Promise<any | null> {
  const rows = await pg_all(
    `SELECT result, created_at FROM public.judge_evals WHERE kind = $1 ORDER BY created_at DESC LIMIT 1`,
    [kind],
  );
  return rows[0] || null;
}

/** Fingerprint of a calibration set — lets the gate detect that the set
 *  changed since the last run (a stored agree_rate for a different set is
 *  meaningless — the user's exact complaint: 'the scores seen there should
 *  be the scores the system is using'). */
export function setFingerprint(entries: Array<{ id: string; dimension: string; expected_score: number }>): string {
  const s = entries
    .map((e) => `${e.id}:${e.dimension}:${e.expected_score}`)
    .sort()
    .join("|");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `set:${entries.length}:${h}`;
}

export async function listCalibration(): Promise<any[]> {
  const rows = await pg_all(
    `SELECT c.id, c.trace_id, c.dimension, c.expected_score, c.note, c.active, c.created_at,
            t.route, t.ts, t.scores
     FROM public.judge_calibration c
     LEFT JOIN public.traces t ON t.id = c.trace_id
     ORDER BY c.created_at DESC`,
    [],
  );
  // Overlay the LAST RUN's per-entry verdicts — the numbers the gate uses.
  // The trace's stored scores are NOT shown here: they drift (rubric
  // changes, superseded stored memories) and the system never acts on them.
  const last = await latestJudgeEval("calibration");
  const byId = new Map<string, any>();
  for (const e of last?.result?.entries || []) byId.set(String(e.id), e);
  const runTs = last?.created_at ?? null;
  return rows.map((r: any) => {
    const run = byId.get(String(r.id));
    return {
      ...r,
      last_run_actual: run?.actual ?? null,
      last_run_match: run?.match ?? null,
      last_run_note: run?.note ?? null,
      last_run_ts: runTs,
    };
  });
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
  onEntry?: (entry: any, index: number, total: number) => void,
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
  const total = entries.length;
  let agree = 0;
  let absErrSum = 0;
  let unscorable = 0;
  const push = (entry: any) => {
    results.push(entry);
    // v4.7.11: live-progress hook — the GUI streams each verdict as it lands
    // (llama-swap activity-style) instead of waiting for the whole run.
    onEntry?.(entry, results.length - 1, total);
  };
  for (const e of entries) {
    // Honesty filter (v4.7.5): some traces cannot produce a MEANINGFUL score
    // for their dimension. The one systematic artifact class: extraction_fidelity
    // needs stored_memory_ids (receipt-era traces grade the receipt, not the
    // extraction output). Recall traces are deliberately picked by the user
    // with a label — that pick is authoritative (statement-form questions are
    // legit recall queries), so no query-form filter here.
    const tr = await pg_all(`SELECT response_body, request_body FROM public.traces WHERE id = $1`, [e.trace_id]);
    const row = tr[0];
    let scorable = true;
    let skipNote: string | null = null;
    if (!row) {
      scorable = false;
      skipNote = "trace deleted — cannot score";
    } else if (e.dimension === "extraction_fidelity") {
      const ids = (row.response_body as any)?.stored_memory_ids;
      if (!(Array.isArray(ids) && ids.length > 0)) {
        scorable = false;
        skipNote = "receipt-era trace (no stored_memory_ids) — fidelity cannot be scored";
      }
    }
    if (!scorable) {
      unscorable++;
      push({
        id: e.id,
        trace_id: e.trace_id,
        route: e.route ?? null,
        ts: e.ts ?? null,
        dimension: e.dimension,
        expected: e.expected_score,
        actual: null,
        match: null,
        note: skipNote,
      });
      continue;
    }
    const r = await scoreTrace(e.trace_id, e.dimension, { persist: false });
    const actual = r.ok && r.score !== undefined ? r.score : null;
    const match = actual !== null ? Math.abs(actual - e.expected_score) <= tolerance : null;
    if (match === true) agree++;
    if (actual !== null) absErrSum += Math.abs(actual - e.expected_score);
    push({
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
  const scored = results.length - unscorable;
  const result = {
    checked: results.length,
    scored,
    unscorable,
    agree,
    agree_rate: scored ? Math.round((agree / scored) * 100) / 100 : null,
    avg_abs_error: scored ? Math.round((absErrSum / scored) * 1000) / 1000 : null,
    set_fingerprint: setFingerprint(entries),
    entries: results,
  };
  await persistJudgeEval("calibration", result);
  return result;
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
  const result = {
    checked: perTrace.length,
    repeats,
    overall_mean_abs_dev: n ? Math.round((sumMAD / n) * 1000) / 1000 : null,
    per_trace: perTrace,
  };
  await persistJudgeEval("consistency", result);
  return result;
}
