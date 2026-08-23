# Changelog — 2026-08-23: Living-Model Loop Test Suite + Pre-existing Fixes

## What changed
Extended the existing vitest suite (`packages/engram-js/tests/`) to verify the
living-model learning loop **end-to-end** after every major change, plus fixed
two pre-existing suite failures.

### New: `tests/livingModelLoop.test.ts` (integration + unit)
Drives the full closed loop against the live store and emits an audit-style
report (mirrors `traceStore.traceReport` — deterministic, no LLM):

1. **memory-extraction** — seeds a test memory (the "extracted fact").
2. **learning-propose** — seeds scored chat traces (low `recall_relevance` +
   `answer_quality`), opens the judge gate (calibration + consistency evals),
   runs `runLearning()` → asserts ≥1 proposal.
3. **learning-apply** — verifies the proposal was applied (auto-apply is on by
   default; manual apply path is also exercised when auto-apply is off) and the
   `audit_log` (`event_type=learning.apply`) was written.
4. **outcome-tracking** — `backfillOutcomes()` populates
   `memories_outcome_stats`.
5. **report-generated** — `learningLoopReport()` produces the PASS/FAIL report.

Pure unit checks (always run, no DB): `KNOB_MAPPINGS` excludes the dead
`hybrid_vector_floor`/`hybrid_keyword_scale` knobs; `auto_search_min_confidence`
proposals stay in **percent** units; `learningStatus().gate_open` is recomputed
(not the hardcoded `false` v5.0.3 fixed).

Integration runs only when `EG_TEST_LIVE=1` (a real Postgres is reachable), so
the suite stays green in CI without a database. All seeded rows are cleaned up
in `afterAll`, and the loop's mutations to `app_settings` are restored to a
captured **baseline** — the deployed config is never left altered.

### New: `src/services/learningLoopReport.ts`
Deterministic, explainable end-to-end verification report builder
(`learningLoopReport` / `formatLoopReport`) — the "report generated at the end
similar to the audit report."

### Fixed: `learningPolicy.ts` (`require` → `import`)
`runLearning`/`learningStatus` used `require("./integrityEngine")` and
`envKeyForKnob` used `require("./settingsService")`. These fail under ESM test
runners (vitest), silently swallowing the judge gate and causing the loop to
bail. Replaced with top-level `import` (no behavior change in the CJS server
bundle). Also exported `KNOB_MAPPINGS` / `KnobMapping` for the test.

### Fixed: `vitest.config.ts` + `tests/setup.ts`
Added `setupFiles: ['tests/setup.ts']` which calls `loadSettings()` once — the
same in-memory settings cache the server populates at startup — so model
resolution (`generative.compaction`, etc.) behaves identically in tests and
production. This fixed the pre-existing `compactionEngine.test.ts` failure.

### Fixed: `schema.test.ts` snapshot
Regenerated — `buildDurableSchemaSql` now legitimately emits the
`app_settings`, `traces`, `learning_proposals`, and `memories_outcome_stats`
tables added by the living-model work (additive growth, no altered/dropped
lines).

### Prod config fix
Set `generative.compaction` in `app_settings` (it was unset → compaction would
have thrown in production too). It now resolves to the same model as
`generative.model`.

## Verification
`EG_TEST_LIVE=1 npx vitest run` → **71 passed (7 files)**, including the new
loop test. Live `app_settings` confirmed unchanged after the run
(`recall_gap_max_per_run=2`, `auto_search_min_confidence=34.64`), 0 stray
proposals/traces left behind.
