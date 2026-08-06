# Implementation Plan: Judge Governance (Calibration, Consistency, Policy, Review)

> **Status:** ✅ IMPLEMENTED 2026-08-06 — see the Implementation Summary at the bottom.

## Why this exists

The LLM judge drives the trace-scoring loop that will eventually gate **auto-healing / auto-optimizing memory** (detect missing data, false memories, and repair them). Before any score may drive an action (delete, rewrite, append), the judge itself must be:
1. **Calibrated** — agrees with human labels on a curated set,
2. **Stable** — gives the same score on re-score,
3. **Policy-governed** — thresholds are declared, configurable, and alerts fire,
4. **Reviewed** — low-scored traces carry a needs-review flag until a human opens them.

This is the governance foundation for the future repair engine. Every repair action will additionally write to `audit_log` and surface in a dedicated UI tab (next phase).

## Design

### Schema (v4.3.0-governance)
- `traces.reviewed_at timestamptz` — when the trace was reviewed/acknowledged.
- `judge_calibration` table: `trace_id` FK (on delete cascade), `dimension` (closed enum), `expected_score` (0..1, HUMAN label), `note`, `active`, `created_at`.

### Calibration
- CRUD via `/api/dashboard/judge/calibration` (GET/POST/PUT/DELETE) — GUI: Governance tab.
- `POST /api/dashboard/judge/run-calibration` — re-scores every active entry with a **fresh, non-persisting** judge call and compares to the human label within a tolerance (default 0.15). Reports `{checked, agree, agree_rate, avg_abs_error, entries[{expected, actual, match}]}`.

### Consistency
- `POST /api/dashboard/judge/consistency {samples, repeats}` — random sample of eligible traces, each re-scored N times (non-persisting), per-trace + overall **mean absolute deviation (MAD)**. Low MAD = stable judge.

### Policy thresholds
- Settings → General → **Policy** (`general.policy_good_threshold` / `general.policy_bad_threshold`, env `EG_POLICY_GOOD_THRESHOLD` / `EG_POLICY_BAD_THRESHOLD`; defaults 0.7 / 0.4; bad forced below good).
- Consumed by: `traceReport` distribution buckets + `worst` cutoff, `traceSuggestions` conditions, `listTraces`/`getTrace` needs-review computation, GUI ScorePill colors (via facets `policy`).
- `policy_alerts` in the report: dimension average below bad threshold (n≥3) → high; below good → medium; failed requests → high. Rendered as red/amber banners in the report panel.

### Review loop
- A trace `needs_review` = has any score < bad threshold AND `reviewed_at IS NULL` (computed in SQL, returned by `listTraces` + `getTrace`).
- `POST /api/dashboard/traces/:id/review` sets `reviewed_at`.
- GUI: red "needs review" badge on list rows, "Needs review" filter option, auto-clear when the trace detail is opened, and a Needs Review queue in the Governance tab with per-row "Mark reviewed".

### GUI — Governance tab
- **Judge Calibration**: add form (trace id / dimension / expected / note), list with expected vs last-actual + match, Run calibration → agreement card + avg abs error.
- **Score Consistency**: samples × repeats inputs, Run → overall MAD + per-trace score table.
- **Needs Review**: unreviewed low-scored traces with reasons + Mark reviewed.

## Implementation Summary

### Files changed

| File | Change |
|---|---|
| `packages/engram-js/src/durable/schema.ts` | `judge_calibration` table + `traces.reviewed_at` + version 4.3.0-governance |
| `packages/engram-js/src/services/traceStore.ts` | `policyThresholds()`, `needs_review` in list/get, `markTraceReviewed`, report `policy` + `policy_alerts`, distribution/worst use policy |
| `packages/engram-js/src/services/traceScorer.ts` | `scoreTrace(..., {persist})` — non-persisting scoring for governance runs |
| `packages/engram-js/src/services/traceGovernance.ts` | NEW — calibration CRUD + `runCalibration` + `runConsistency` |
| `packages/engram-js/src/services/traceSuggestions.ts` | all thresholds read from policy (no hardcoded 0.7/0.4) |
| `packages/engram-js/src/api/routes/dashboard/judge/route.ts` | NEW — calibration + consistency endpoints |
| `packages/engram-js/src/api/routes/dashboard/traces/route.ts` | `review` filter, `POST /:id/review` |
| `packages/engram-js/src/api/routes/index.ts` | register judge route |
| `packages/engram-js/src/services/settingsService.ts` | `general.policy_*` GENERAL_SETTINGS |
| `apps/web/src/App.tsx` | Governance tab (calibration/consistency/review queue), needs-review badge + auto-clear, review filter, report policy-alert banners, ScorePill policy thresholds, Settings Policy group |

### Verification (live, on the deployed containers)

- Schema: `judge_calibration` created, `traces.reviewed_at` added, version 4.3.0-governance.
- Seeded 6 calibration entries (human labels: gold recall 0.9, strong 0.8, mixed 0.45, weak 0.25, extraction 0.7, failed-chat 0.0).
- **Calibration run: 5/6 agreement (83%), avg abs error 0.067** — the mismatch (extraction_fidelity: expected 0.7, judge 0.5) is the actionable signal: the judge grades extraction lower than a human.
- **Consistency run: 5 traces × 3 repeats → overall MAD 0** — perfectly stable judge.
- Review queue: 5 flagged, `POST /:id/review` clears; policy alerts render with correct severity (answer_quality 0.17 high, recall 0.51 medium, 1 failed request high).

### Notes / next phase

- Calibration labels are MY seed judgments — review/adjust in the Governance tab (Remove + re-add, or PUT via API).
- The **auto-heal/repair engine** (detect missing/false memories, repair, and a dedicated "changed data" audit tab) builds on this: calibrated judge → scored signals → deterministic repair actions → `audit_log` writes → user-facing audit tab. Nothing repairs until calibration + consistency are green.
