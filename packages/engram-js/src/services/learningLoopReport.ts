/*
 - filename: packages/engram-js/src/services/learningLoopReport.ts
 - what is the file used for: deterministic, explainable end-to-end verification
   report for the living-model learning loop. Mirrors the style of
   traceStore.traceReport (no LLM — grounded in real numbers + live store
   health). Consumed by the test suite and any "verify after major change"
   harness so a human can see exactly what passed/failed and why.
*/

import { all_async as pg_all, run_async as pg_run } from "../database/connection";
import { policyThresholds } from "./traceStore";
import { learningStatus } from "./learningPolicy";
import type { LearningRunResult } from "./learningPolicy";

export interface LoopStage {
  name: string;
  ok: boolean;
  detail: string;
  /** Free-form metrics for the stage (e.g. proposals_created: 2). */
  metrics?: Record<string, number | string>;
}

export interface LoopReport {
  ok: boolean;
  generated_at: string;
  /** The ordered stages that were exercised, each pass/fail. */
  stages: LoopStage[];
  /** Aggregate counters. */
  proposals_created: number;
  proposals_applied: number;
  outcome_memories_tracked: number;
  gate_open: boolean;
  /** Policy alerts surfaced from the live loop state (mirrors traceReport). */
  policy_alerts: Array<{ severity: "high" | "medium" | "info"; dimension: string | null; message: string }>;
  /** Human-readable remediation suggestions (deterministic). */
  suggestions: string[];
  /** Raw learning-run result for forensics. */
  run?: LearningRunResult;
}

/**
 * Build a report from a just-completed verification run. `stages` is the
 * ordered list of pass/fail stages produced by the harness; `run` is the
 * learning-run result; `appliedId` is the proposal we applied (if any);
 * `outcomeTracked` is how many memories_outcome_stats rows exist post-backfill.
 */
export async function learningLoopReport(opts: {
  stages: LoopStage[];
  run?: LearningRunResult;
  appliedId?: string | null;
  outcomeTracked?: number;
  testProject?: string;
}): Promise<LoopReport> {
  const policy = policyThresholds();
  const status = await learningStatus().catch(() => null);

  const proposalsCreated = opts.run?.proposals_created ?? 0;
  const proposalsApplied = opts.appliedId ? 1 : 0;
  const outcomeTracked = opts.outcomeTracked ?? 0;

  const policyAlerts: LoopReport["policy_alerts"] = [];
  if (status && !status.gate_open) {
    policyAlerts.push({
      severity: "high",
      dimension: null,
      message: `Judge gate is CLOSED — learning loop is paused. Reasons: ${(status.gate_reasons || []).join("; ") || "unknown"}`,
    });
  }
  if (proposalsCreated === 0 && (opts.run?.gate_open ?? false)) {
    policyAlerts.push({
      severity: "info",
      dimension: null,
      message: "Learning ran with gate open but produced no proposals — score windows are healthy or below min sample.",
    });
  }

  // Suggestions (deterministic, explainable — no LLM).
  const suggestions: string[] = [];
  for (const s of opts.stages) {
    if (!s.ok) {
      suggestions.push(`STAGE FAILED: ${s.name} — ${s.detail}`);
    }
  }
  if (proposalsApplied > 0) {
    suggestions.push(`Applied 1 proposal (${opts.appliedId}). Verify the knob change in Settings / app_settings and the audit_log (event_type=learning.apply).`);
  }
  if (policyAlerts.length === 0 && opts.stages.every((s) => s.ok)) {
    suggestions.push("All living-model loop stages passed. The loop is correctly extracting → scoring → proposing → applying → tracking outcomes. Safe to ship.");
  }

  const ok = opts.stages.length > 0 && opts.stages.every((s) => s.ok);

  return {
    ok,
    generated_at: new Date().toISOString(),
    stages: opts.stages,
    proposals_created: proposalsCreated,
    proposals_applied: proposalsApplied,
    outcome_memories_tracked: outcomeTracked,
    gate_open: status?.gate_open ?? false,
    policy_alerts: policyAlerts,
    suggestions,
    run: opts.run,
  };
}

/** Pretty-print a report (used by the test harness + any CLI). */
export function formatLoopReport(r: LoopReport): string {
  const lines: string[] = [];
  lines.push("╔══════════════════════════════════════════════════════════════╗");
  lines.push("║  LIVING-MODEL LOOP — END-TO-END VERIFICATION REPORT         ║");
  lines.push("╚══════════════════════════════════════════════════════════════╝");
  lines.push(`Result:        ${r.ok ? "PASS ✅" : "FAIL ❌"}`);
  lines.push(`Generated:     ${r.generated_at}`);
  lines.push(`Judge gate:    ${r.gate_open ? "OPEN" : "CLOSED"}`);
  lines.push(`Proposals:     created=${r.proposals_created} applied=${r.proposals_applied}`);
  lines.push(`Outcomes:      ${r.outcome_memories_tracked} memory/terms tracked`);
  lines.push("");
  lines.push("Stages:");
  for (const s of r.stages) {
    lines.push(`  ${s.ok ? "[PASS]" : "[FAIL]"} ${s.name}${s.detail ? ` — ${s.detail}` : ""}`);
    if (s.metrics) {
      for (const [k, v] of Object.entries(s.metrics)) {
        lines.push(`         · ${k}: ${v}`);
      }
    }
  }
  if (r.policy_alerts.length) {
    lines.push("");
    lines.push("Policy alerts:");
    for (const a of r.policy_alerts) lines.push(`  [${a.severity.toUpperCase()}] ${a.message}`);
  }
  if (r.suggestions.length) {
    lines.push("");
    lines.push("Suggestions:");
    for (const s of r.suggestions) lines.push(`  • ${s}`);
  }
  return lines.join("\n");
}
