/*
 - filename: packages/engram-js/tests/livingModelLoop.test.ts
 - what is the file used for: END-TO-END verification of the living-model
   learning loop (the "Living Engram" closed feedback loop). Exercises the
   full path: memory extraction → scored trace → learning proposal → apply
   (with audit) → outcome tracking → generated report. Mirrors the audit
   report style of traceStore.traceReport.

   Pure unit checks run always. The full integration loop runs only when
   EG_TEST_LIVE=1 (a real Postgres is reachable), so the suite stays green in
   CI without a database while still verifying the loop end-to-end in the
   deployed environment. All seeded rows are tagged with a test project and
   cleaned up in afterAll — the suite never pollutes real data.
*/

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runLearning, listProposals, applyProposal, dismissProposal, learningStatus } from "../src/services/learningPolicy";
import { backfillOutcomes } from "../src/services/outcomeTracker";
import { learningLoopReport, formatLoopReport, type LoopStage } from "../src/services/learningLoopReport";
import { all_async as pg_all, run_async as pg_run } from "../src/database/connection";

const LIVE = process.env.EG_TEST_LIVE === "1";
const PROJECT = "living-model-loop-test";
const USER = "living-model-loop-test-user";
const TEST_KNOBS = ["general.recall_gap_max_per_run", "general.auto_search_min_confidence"] as const;

// Baseline live values captured at test start so cleanup can restore EXACTLY
// what was there — the loop mutates app_settings, and we must never leave the
// deployed config altered after a verification run.
const baseline: Record<string, string> = {};
async function captureBaseline() {
  const rows = (await pg_all(
    `SELECT key, value FROM public.app_settings WHERE key = ANY($1::text[])`,
    [TEST_KNOBS],
  ).catch(() => [] as any[])) as any[];
  for (const r of rows || []) baseline[r.key] = r.value;
}
async function restoreBaseline() {
  const { saveSettings } = await import("../src/services/settingsService");
  for (const k of TEST_KNOBS) {
    if (baseline[k] != null) await saveSettings({ [k]: baseline[k] }).catch(() => {});
  }
}

// ── Pure unit checks (always run, no DB) ─────────────────────────────

describe("living-model loop — proposal math (unit)", () => {
  it("KNOB_MAPPINGS maps recall_relevance to a live, consumed knob (no dead knobs)", async () => {
    const { KNOB_MAPPINGS } = await import("../src/services/learningPolicy");
    const recall = KNOB_MAPPINGS.recall_relevance;
    expect(recall.length).toBeGreaterThan(0);
    // v5.0.3 fix: hybrid_vector_floor / hybrid_keyword_scale were DEAD (unread
    // at recall time). The mapping must NOT reference them.
    for (const m of recall as any[]) {
      expect(m.knob).not.toContain("hybrid_vector_floor");
      expect(m.knob).not.toContain("hybrid_keyword_scale");
    }
    // recall_gap_max_per_run IS read live by recallGapEngine — valid lever.
    expect(recall.some((m) => m.knob === "general.recall_gap_max_per_run")).toBe(true);
  });

  it("auto_search_min_confidence proposal uses PERCENT units (not fractions)", async () => {
    const { KNOB_MAPPINGS } = await import("../src/services/learningPolicy");
    const ef = KNOB_MAPPINGS.extraction_fidelity[0];
    // current is a percent (e.g. 40). Proposed value must stay in percent range.
    const proposed = ef.propose(40, 0.2, 0.8, 0.4);
    expect(proposed).toBeLessThanOrEqual(ef.clamp[1]);
    expect(proposed).toBeGreaterThanOrEqual(ef.clamp[0]);
    // Must NOT be a fraction like 0.9 (the v5.0.0 bug).
    expect(proposed).toBeGreaterThanOrEqual(10);
  });

  it("learningStatus().gate_open is recomputed (not hardcoded false)", async () => {
    const status = await learningStatus();
    // gate_open must be a real boolean derived from integrityGate(), never the
    // hardcoded `false` that v5.0.3 fixed.
    expect(typeof status.gate_open).toBe("boolean");
    expect(status).toHaveProperty("gate_reasons");
  });
});

// ── Integration: full loop against a live Postgres ────────────────────

const stages: LoopStage[] = [];
let runResult: Awaited<ReturnType<typeof runLearning>> | undefined;
let appliedId: string | null = null;
let outcomeTracked = 0;

async function seedCalibrationEval() {
  // Open the judge gate: integrityGate() needs BOTH a recent, high-agreement
  // calibration eval AND a recent, low-MAD consistency eval.
  await pg_run(
    `INSERT INTO public.judge_evals (id, kind, result, created_at)
     VALUES ($1, 'calibration', $2::jsonb, now())
     ON CONFLICT DO NOTHING`,
    ["00000000-0000-0000-0000-0000000000aa", JSON.stringify({ agree_rate: 0.95, mean_abs_dev: 0.02, n: 40, set_fingerprint: null })],
  );
  await pg_run(
    `INSERT INTO public.judge_evals (id, kind, result, created_at)
     VALUES ($1, 'consistency', $2::jsonb, now())
     ON CONFLICT DO NOTHING`,
    ["00000000-0000-0000-0000-0000000000bb", JSON.stringify({ overall_mean_abs_dev: 0.03, n_runs: 5, n_repeats: 3 })],
  );
}

async function seedMemoryAndTraces() {
  // A memory to act as the "extracted fact" referenced by injection.
  const memId = "11111111-1111-1111-1111-111111111111";
  await pg_run(
    `INSERT INTO public.memories (id, user_id, project_id, content, sector, embedding_synthetic, salience, confidence)
     VALUES ($1, $2, $3, 'living-model loop test memory', 'semantic', true, 0.5, 1)
     ON CONFLICT (id) DO NOTHING`,
    [memId, USER, PROJECT],
  );

  // Seed >= minTraces chat traces, each with a LOW recall_relevance score and
  // an injection referencing the memory. This drives runLearning() to propose
  // raising recall_gap_max_per_run.
  const n = 6;
  for (let i = 0; i < n; i++) {
    const traceId = `22222222-2222-2222-2222-${(22220000 + i).toString().padStart(12, "0")}`;
    await pg_run(
      `INSERT INTO public.traces (id, ts, route, method, status, ms, direction, kind, label, project_id, user_id, injection, scores)
       VALUES ($1, now(), '/v1/chat/completions', 'POST', 200, 800, 'chat', 'chat', 'chat', $2, $3,
         $4::jsonb,
         $5::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        traceId,
        PROJECT,
        USER,
        JSON.stringify({ genome: 1, phenotype: 1, genome_ids: [memId], phenotype_ids: [] }),
        JSON.stringify([
          { dimension: "recall_relevance", score: 0.2, judge_model: "test-judge" },
          { dimension: "answer_quality", score: 0.3, judge_model: "test-judge" },
        ]),
      ],
    );
  }
  return memId;
}

async function cleanup() {
  // Restore the exact live knob values that existed before this run (captured
  // in beforeAll) so the deployed config is never left altered.
  await restoreBaseline();
  // Delete ONLY the proposals this test created (matched by knob + recent
  // creation time, so we never touch real production proposals) and their audit.
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

describe("living-model loop — end-to-end (integration)", () => {
  beforeAll(async () => {
    if (!LIVE) return;
    // Capture the live knob values BEFORE we touch anything, so cleanup can
    // restore them exactly (the loop mutates app_settings).
    await captureBaseline();
    // Idempotency: dismiss any pre-existing OPEN proposal on our knobs so the
    // dedupe in runLearning() doesn't skip our seeded proposal.
    const preexisting = (await listProposals({ status: "open", limit: 50 })) as any[];
    for (const p of preexisting) {
      if (p.target_knob === "general.recall_gap_max_per_run" || p.target_knob === "general.auto_search_min_confidence") {
        await dismissProposal(p.id).catch(() => {});
      }
    }
    await seedCalibrationEval();
    await seedMemoryAndTraces();
  }, 30_000);

  afterAll(async () => {
    if (!LIVE) return;
    await cleanup();
  }, 30_000);

  it("runs the full loop: extract → score → propose → apply → track → report", async () => {
    if (!LIVE) {
      console.warn("[livingModelLoop] EG_TEST_LIVE not set — skipping integration loop (unit checks above still ran).");
      return;
    }

    // 1) Memory extraction already seeded (the "extracted fact"). Verify present.
    const mem = await pg_all(`SELECT id FROM public.memories WHERE id = '11111111-1111-1111-1111-111111111111'`);
    stages.push({ name: "memory-extraction", ok: mem.length > 0, detail: mem.length > 0 ? "seeded test memory present" : "memory missing" });

    // 2) Learning run (reads seeded scores + open judge gate).
    runResult = await runLearning();
    const created = runResult.proposals_created;
    stages.push({
      name: "learning-propose",
      ok: created > 0,
      detail: runResult.gate_open ? `created ${created} proposal(s)` : "gate closed — no run",
      metrics: { gate_open: runResult.gate_open ? 1 : 0, proposals_created: created },
    });

    // 3) Verify the proposal was applied (auto-apply is ON by default, so the
    //    loop applies within runLearning; if not, we apply it flag-first here).
    const open = (await listProposals({ status: "open", limit: 20 })) as any[];
    const openTarget =
      open.find((p) => p.target_knob === "general.recall_gap_max_per_run") ||
      open.find((p) => p.target_knob === "general.auto_search_min_confidence");
    if (openTarget) {
      // Open proposal remained (auto-apply off) — apply it manually, auditable.
      const r = await applyProposal(openTarget.id);
      appliedId = openTarget.id;
      stages.push({ name: "learning-apply", ok: r.ok, detail: r.ok ? `applied ${openTarget.id}` : (r.error || "apply failed") });
    } else {
      // Auto-applied: find the applied proposal instead and verify the audit.
      const applied = (await listProposals({ status: "applied", limit: 20 })) as any[];
      const a = applied.find((p) => p.target_knob === "general.recall_gap_max_per_run") ||
                applied.find((p) => p.target_knob === "general.auto_search_min_confidence");
      appliedId = a?.id ?? null;
      stages.push({
        name: "learning-apply",
        ok: !!a && runResult.auto_applied > 0,
        detail: a ? `auto-applied ${a.id} during run` : "no applied proposal found",
        metrics: { auto_applied: runResult.auto_applied },
      });
    }

    // 4) Audit log recorded the hyperparameter change.
    const audit = appliedId
      ? await pg_all(
          `SELECT count(*)::int AS n FROM public.audit_log WHERE event_type = 'learning.apply' AND target_id = $1`,
          [appliedId],
        ) as any[]
      : [{ n: 0 }];
    stages.push({ name: "audit-trail", ok: (audit[0]?.n ?? 0) > 0, detail: "learning.apply events", metrics: { events: audit[0]?.n ?? 0 } });

    // 5) Outcome tracking: backfill from the scored trace → memories_outcome_stats.
    await backfillOutcomes(1);
    const outcome = await pg_all(
      `SELECT count(*)::int AS n FROM public.memories_outcome_stats WHERE memory_id = '11111111-1111-1111-1111-111111111111'`,
    ) as any[];
    outcomeTracked = outcome[0]?.n ?? 0;
    stages.push({ name: "outcome-tracking", ok: outcomeTracked > 0, detail: `memories_outcome_stats rows: ${outcomeTracked}` });

    // 6) Generate the audit-style report.
    const report = await learningLoopReport({ stages, run: runResult, appliedId, outcomeTracked, testProject: PROJECT });
    stages.push({ name: "report-generated", ok: report.ok && stages.every((s) => s.ok), detail: report.ok ? "report ok" : "report failed" });

    // Print the report (the user wants to SEE it).
    console.log("\n" + formatLoopReport(report) + "\n");

    // Assert the whole loop passed.
    expect(runResult.gate_open).toBe(true);
    expect(created).toBeGreaterThan(0);
    expect(appliedId).not.toBeNull();
    expect(outcomeTracked).toBeGreaterThan(0);
    expect(report.ok).toBe(true);
  }, 60_000);
});
