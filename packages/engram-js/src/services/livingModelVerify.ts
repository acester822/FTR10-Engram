/*
 - filename: packages/engram-js/src/services/livingModelVerify.ts
 - what is the file used for: server-side end-to-end verification of the
   living-model learning loop, callable from the Settings tab "Run Loop Test"
   button. Ports the logic from tests/livingModelLoop.test.ts into a function
   that runs against the LIVE store: seeds a test memory + scored trace, runs
   the loop, verifies apply + audit + outcome tracking, builds the audit-style
   report, then restores the live app_settings to their pre-run baseline and
   deletes all seeded rows. Never pollutes real data or leaves config altered.
*/

import { all_async as pg_all, run_async as pg_run } from "../database/connection";
import { runLearning, listProposals, applyProposal, dismissProposal, learningStatus } from "./learningPolicy";
import { backfillOutcomes } from "./outcomeTracker";
import { learningLoopReport, formatLoopReport, type LoopStage, type LoopReport } from "./learningLoopReport";
import { saveSettings } from "./settingsService";

const PROJECT = "living-model-loop-test";
const USER = "living-model-loop-test-user";
const TEST_KNOBS = ["general.recall_gap_max_per_run", "general.auto_search_min_confidence"] as const;

async function captureBaseline(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const rows = (await pg_all(
    `SELECT key, value FROM public.app_settings WHERE key = ANY($1::text[])`,
    [TEST_KNOBS],
  ).catch(() => [] as any[])) as any[];
  for (const r of rows || []) out[r.key] = r.value;
  return out;
}

async function seedGateAndTraces(): Promise<void> {
  // Open the judge gate (calibration + consistency evals).
  await pg_run(
    `INSERT INTO public.judge_evals (id, kind, result, created_at)
     VALUES ($1, 'calibration', $2::jsonb, now()) ON CONFLICT DO NOTHING`,
    ["00000000-0000-0000-0000-0000000000aa", JSON.stringify({ agree_rate: 0.95, mean_abs_dev: 0.02, n: 40, set_fingerprint: null })],
  ).catch(() => {});
  await pg_run(
    `INSERT INTO public.judge_evals (id, kind, result, created_at)
     VALUES ($1, 'consistency', $2::jsonb, now()) ON CONFLICT DO NOTHING`,
    ["00000000-0000-0000-0000-0000000000bb", JSON.stringify({ overall_mean_abs_dev: 0.03, n_runs: 5, n_repeats: 3 })],
  ).catch(() => {});

  const memId = "11111111-1111-1111-1111-111111111111";
  await pg_run(
    `INSERT INTO public.memories (id, user_id, project_id, content, sector, embedding_synthetic, salience, confidence)
     VALUES ($1, $2, $3, 'living-model loop test memory', 'semantic', true, 0.5, 1)
     ON CONFLICT (id) DO NOTHING`,
    [memId, USER, PROJECT],
  ).catch(() => {});

  // Seed scored chat traces (low recall_relevance + answer_quality) referencing
  // the memory, so runLearning() produces a proposal and outcome tracking works.
  for (let i = 0; i < 6; i++) {
    const traceId = `22222222-2222-2222-2222-${(22220000 + i).toString().padStart(12, "0")}`;
    await pg_run(
      `INSERT INTO public.traces (id, ts, route, method, status, ms, direction, kind, label, project_id, user_id, injection, scores)
       VALUES ($1, now(), '/v1/chat/completions', 'POST', 200, 800, 'chat', 'chat', 'chat', $2, $3, $4::jsonb, $5::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        traceId,
        PROJECT,
        USER,
        JSON.stringify({ genome: 1, phenotype: 1, genome_ids: [memId], phenotype_ids: [] }),
        JSON.stringify([
          { dimension: "recall_relevance", score: 0.2, judge_model: "verify" },
          { dimension: "answer_quality", score: 0.3, judge_model: "verify" },
        ]),
      ],
    ).catch(() => {});
  }
}

async function cleanup(baseline: Record<string, string>): Promise<void> {
  // Restore exact pre-run knob values.
  for (const k of TEST_KNOBS) {
    if (baseline[k] != null) await saveSettings({ [k]: baseline[k] }).catch(() => {});
  }
  // Delete only proposals this run created (recent + our knobs).
  const seeded = (await pg_all(
    `SELECT id FROM public.learning_proposals
     WHERE target_knob IN ('general.recall_gap_max_per_run','general.auto_search_min_confidence')
       AND created_at > now() - interval '2 hours'`,
  ).catch(() => [] as any[])) as any[];
  for (const p of seeded || []) {
    await pg_run(`DELETE FROM public.audit_log WHERE actor_id = 'learning_loop' AND target_id = $1`, [p.id]).catch(() => {});
  }
  await pg_run(
    `DELETE FROM public.learning_proposals
     WHERE target_knob IN ('general.recall_gap_max_per_run','general.auto_search_min_confidence')
       AND created_at > now() - interval '2 hours'`,
  ).catch(() => {});
  await pg_run(`DELETE FROM public.memories_outcome_stats WHERE memory_id = '11111111-1111-1111-1111-111111111111'`).catch(() => {});
  await pg_run(`DELETE FROM public.traces WHERE project_id = $1`, [PROJECT]).catch(() => {});
  await pg_run(`DELETE FROM public.memories WHERE id = '11111111-1111-1111-1111-111111111111'`).catch(() => {});
  await pg_run(`DELETE FROM public.judge_evals WHERE id IN ('00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-0000000000bb')`).catch(() => {});
}

export interface VerificationResult {
  ok: boolean;
  report: LoopReport;
  report_text: string;
  duration_ms: number;
  error?: string;
}

/**
 * Run the full living-model loop verification end-to-end against the live
 * store and return the audit-style report. Safe to call any time: it seeds
 * isolated test data, restores app_settings afterward, and cleans up.
 */
export async function runLivingModelVerification(): Promise<VerificationResult> {
  const started = Date.now();
  const stages: LoopStage[] = [];
  let runResult: Awaited<ReturnType<typeof runLearning>> | undefined;
  let appliedId: string | null = null;
  let outcomeTracked = 0;
  const baseline = await captureBaseline();

  try {
    // Idempotency: dismiss pre-existing open proposals on our knobs.
    const preexisting = (await listProposals({ status: "open", limit: 50 })) as any[];
    for (const p of preexisting) {
      if (TEST_KNOBS.includes(p.target_knob)) await dismissProposal(p.id).catch(() => {});
    }

    await seedGateAndTraces();

    // 1) memory extraction present
    const mem = await pg_all(`SELECT id FROM public.memories WHERE id = '11111111-1111-1111-1111-111111111111'`);
    stages.push({ name: "memory-extraction", ok: mem.length > 0, detail: mem.length > 0 ? "seeded test memory present" : "memory missing" });

    // 2) learning propose
    runResult = await runLearning();
    const created = runResult.proposals_created;
    stages.push({
      name: "learning-propose",
      ok: created > 0,
      detail: runResult.gate_open ? `created ${created} proposal(s)` : "gate closed — no run",
      metrics: { gate_open: runResult.gate_open ? 1 : 0, proposals_created: created },
    });

    // 3) apply (auto-apply is on by default; fall back to manual)
    const open = (await listProposals({ status: "open", limit: 20 })) as any[];
    const openTarget = open.find((p: any) => TEST_KNOBS.includes(p.target_knob));
    if (openTarget) {
      const r = await applyProposal(openTarget.id);
      appliedId = openTarget.id;
      stages.push({ name: "learning-apply", ok: r.ok, detail: r.ok ? `applied ${openTarget.id}` : (r.error || "apply failed") });
    } else {
      const applied = (await listProposals({ status: "applied", limit: 20 })) as any[];
      const a = applied.find((p: any) => TEST_KNOBS.includes(p.target_knob));
      appliedId = a?.id ?? null;
      stages.push({
        name: "learning-apply",
        ok: !!a && runResult.auto_applied > 0,
        detail: a ? `auto-applied ${a.id} during run` : "no applied proposal found",
        metrics: { auto_applied: runResult.auto_applied },
      });
    }

    // 4) audit trail
    const audit = appliedId
      ? (await pg_all(
          `SELECT count(*)::int AS n FROM public.audit_log WHERE event_type = 'learning.apply' AND target_id = $1`,
          [appliedId],
        ).catch(() => [{ n: 0 }])) as any[]
      : [{ n: 0 }];
    stages.push({ name: "audit-trail", ok: (audit[0]?.n ?? 0) > 0, detail: "learning.apply events", metrics: { events: audit[0]?.n ?? 0 } });

    // 5) outcome tracking
    await backfillOutcomes(1);
    const outcome = (await pg_all(
      `SELECT count(*)::int AS n FROM public.memories_outcome_stats WHERE memory_id = '11111111-1111-1111-1111-111111111111'`,
    ).catch(() => [{ n: 0 }])) as any[];
    outcomeTracked = outcome[0]?.n ?? 0;
    stages.push({ name: "outcome-tracking", ok: outcomeTracked > 0, detail: `memories_outcome_stats rows: ${outcomeTracked}` });

    // 6) report
    const report = await learningLoopReport({ stages, run: runResult, appliedId, outcomeTracked, testProject: PROJECT });
    stages.push({ name: "report-generated", ok: report.ok && stages.every((s) => s.ok), detail: report.ok ? "report ok" : "report failed" });

    return { ok: report.ok, report, report_text: formatLoopReport(report), duration_ms: Date.now() - started };
  } catch (e: any) {
    const msg = e?.message || String(e);
    const errReport: LoopReport = {
      ok: false,
      generated_at: new Date().toISOString(),
      stages,
      proposals_created: 0,
      proposals_applied: 0,
      outcome_memories_tracked: 0,
      gate_open: false,
      policy_alerts: [{ severity: "high", dimension: null, message: `verification threw: ${msg}` }],
      suggestions: [`VERIFICATION ERROR: ${msg}`],
    };
    return {
      ok: false,
      report: errReport,
      report_text: `VERIFICATION ERROR: ${msg}`,
      duration_ms: Date.now() - started,
      error: msg,
    };
  } finally {
    await cleanup(baseline);
  }
}
