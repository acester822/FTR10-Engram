# Changelog: Living Model — v5.0.3 fixup

**Date**: Aug 22, 2026

Three bugs in the v5.0.0 learning loop, found by verifying against the live
DB + running container (not by reading the code in isolation):

## Bug 1 — `learningStatus()` lied about health
The `/api/dashboard/learning/status` endpoint hardcoded `gate_open: false`,
so it reported the judge gate as always-closed. Recomputed the real
`integrityGate()` result instead. Live state: cal 0.83 ≥ 0.80, mad 0 ≤ 0.10,
age 2.2d < 7d → **gate is OPEN**. Status now returns the real `gate_open`
plus `gate_reasons[]`.

## Bug 2 — `auto_search_min_confidence` unit mismatch (would have broken auto-search)
The stored value + reader are PERCENT (40 ⇒ 0.40 via `/100` at read time).
v5.0.0 proposed `0.9` (a fraction). Applying it would have set the value to
`0.9` → read back as `0.009`, effectively disabling web auto-search.
Fix: proposals now use percent units (40 → ~37), clamped [10, 90].

## Bug 3 — dead knobs (`hybrid_vector_floor` / `hybrid_keyword_scale`)
Neither knob is read anywhere at recall time — nothing in `scoring.ts` /
`hybridSearch.ts` / `repository.ts` consumes them. Tuning them had **zero
effect**. (Confirmed by reading the fusion code: `hybridRecallScore` uses a
fixed `(vectorScore-0.25)/0.6` mapping with no floor/scale inputs.)
Fix: replaced the `recall_relevance` mapping with
`general.recall_gap_max_per_run` (a real, live-read lever — raise the
gap-fill cap when recall is weak). Removed the two dead settings definitions.

## Operational state after fix
- Rebuilt + redeployed engram image (compose `build` + `up -d`).
- Dismissed the 3 v5.0.0 proposals (all built on pre-fix unit/knob errors).
- Re-ran learning against the *fixed* judge scores (post-v5.0.1/v5.0.2):
  produced 2 correct, open proposals (auto-apply OFF by default):
  - `extraction_fidelity` → `auto_search_min_confidence` 40 → 37.2
  - `recall_relevance` → `recall_gap_max_per_run` 0 → 1
- Verified outcome pipeline end-to-end with a synthetic trace
  (genome_ids + answer_quality → backfill → `memories_tracked: 1`).
  Real chat turns now emit `genome_ids` (container restarted with the IDs
  code), so outcome stats populate automatically going forward.

## Auto-apply activated (user request, same session)
- `EG_LEARNING_AUTO_APPLY=true` and `EG_LEARNING_MAX_DELTA=10` pinned in
  `.env` (gitignored; local persistence). Default `maxAutoDelta=0.1` was too
  tight for integer/percent-scaled knobs, so normal deltas never self-applied;
  10 lets reasonable adjustments through while still bounding any single change.
- `EG_RECALL_GAP_MAX_PER_RUN` pinned in `.env` (=2 after auto-apply). NOTE:
  `recallGapEngine` reads raw `process.env.EG_RECALL_GAP_MAX_PER_RUN`, NOT the
  settings DB — so the applied value must be mirrored in `.env` or it reverts
  to the code default (10) on container restart. `auto_search_min_confidence`
  is read via the `liveSetting()` getter, so it survives via the settings DB
  without an env pin.
- Verified the full loop: `runLearning` now reports `proposals_created: 2,
  auto_applied: 2`, and `audit_log` records `learning.apply` events. After a
  clean `docker compose up -d` (re-reads `.env`), all values persist:
  `recall_gap_max_per_run=2`, `auto_search_min_confidence=34.64`,
  `gate_open=true`.

## Is it "being used" now?
The loop is **live, correctly gated, and self-applying small deltas**. It runs
on a daily schedule (`EG_LEARNING_INTERVAL_MS`, default 24h), proposes from
judge-score trends, and now auto-applies safe deltas (bounded by
`EG_LEARNING_MAX_DELTA`), writing every change to `learning_proposals` +
`audit_log` for review. Outcome tracking populates per real chat turn.
