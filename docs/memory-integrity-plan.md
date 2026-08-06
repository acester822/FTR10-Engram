# Implementation Plan: Memory Integrity Engine (auto-heal)

> **Status:** PLANNED — not yet implemented. This is the design for the memory-STORE integrity engine (the user's model): it runs against the `memories` table on a schedule and verifies memories are **complete** (embeddable), **valid** (true, not noise/false), and **coherent** (no contradictions/duplicates) — repairing by delete / supersede / merge / backfill, with every action audited and surfaced in a new "Memory Audit" tab. It is NOT a retrieval-side fix (re-recall with distilled queries is a separate, small add-on — see §Retrieval-path add-on).

## Overview

The judge governance foundation (v4.3.0) made scores trustworthy: calibration ≥ 80%, consistency MAD ≈ 0, policy thresholds, review loop. This engine is the first CONSUMER of that trust: it uses judge signals to find bad memories — and, critically, **only acts on them when the governance gates are green**. Two-tier automation:

- **Tier 1 (AUTO — deterministic, no LLM):** null/synthetic embeddings → backfill; empty content → delete; leaked secrets → delete; invalid sectors → reclassify; near-duplicate pairs → supersede older by newer. These are mechanical and safe.
- **Tier 2 (GATED — judge-assisted):** false/stale memory detection → delete/supersede, but ONLY if `calibration agree_rate ≥ EG_INTEGRITY_MIN_CALIBRATION (0.8)` AND `consistency MAD ≤ EG_INTEGRITY_MAX_MAD (0.1)`. Below the bar → checks still run, findings are flagged, but **no LLM-judged memory is touched**.

Everything (Tier 1 and 2) writes an `audit_log` row (`actor_id='auto-heal'`, before/after state, triggering check) and a finding in the findings ledger. The Memory Audit tab lists every changed/manipulated memory — nothing silent.

## Design

### Schema (v4.4.0-integrity)

- `integrity_runs` — `id uuid pk`, `started_at`, `completed_at`, `summary jsonb` (per-check counts), `tier2_enabled boolean` (gate state at run time).
- `integrity_findings` — `id uuid pk`, `run_id fk`, `check_name text`, `memory_id uuid nullable fk`, `severity text ('info'|'medium'|'high')`, `action_taken text ('none'|'backfill'|'delete'|'supersede'|'reclassify'|'flag')`, `detail jsonb` (e.g. judge score/reason, similarity, sector), `status text ('open'|'resolved'|'dismissed')`, `created_at`, `resolved_at`.
- `audit_log` already exists — reused (no new table): `actor_id='auto-heal'`, `actor_type='system'`, `event_type='integrity_repair'`, `target_table='memories'`, `before_state`/`after_state` jsonb.

### Phase 1 — Deterministic checks (Tier 1, AUTO)

| Check | Detection | Action |
|---|---|---|
| `null_embeddings` | active rows (`superseded_at IS NULL`, tier≠archived) with `embedding IS NULL` | backfill via `embed()` (batched UPDATEs — the proven backfill recipe); embed backend down → flag |
| `synthetic_embeddings` | `embedding_synthetic=true` | re-embed once; still synthetic → flag medium |
| `empty_content` | content empty/whitespace | delete (hard) |
| `secrets` | SECRET regexes from memory-cleanup rules | delete (hard) — the June incident rule |
| `invalid_sector` | sector ∉ 5-value enum | reclassify via `normalizeSector` (fallback 'semantic') + note in detail |
| `near_duplicates` | pairwise similarity > 0.92 (pgvector `<=>`) among active rows, or `isNearDuplicate` substring overlap | supersede the older row (newer wins) — reversible via clearing `superseded_at` |
| `contradictions_open` | `contradictions` rows with `status='open'` | **flag only** — never auto-resolve |
| `coverage_probes` | run the recall-eval case set (scripts/recall-eval-cases.ts) live; any case that previously hit but now returns 0 results | flag high — "a fact that should exist is no longer retrievable" (deleted? embedding lost? superseded?) |

### Phase 2 — Judge-assisted check (Tier 2, GATED)

- `false_memory_sampling` — sample `EG_INTEGRITY_SAMPLE_SIZE` (default 25) active memories per run (weighted toward old/never-accessed/low-salience). Judge each with a **memory-validity rubric** (new standalone judge call — NOT a trace dimension; rubric: "is this fact true, false, noise, or stale?" → `{score 0..1, reason}` where 0 = definitely false).
- Disposition:
  - `score < EG_INTEGRITY_DELETE_CONFIDENCE (0.15)` → delete candidate (Tier 2 gate required)
  - `score < 0.4` → supersede/flag candidate (Tier 2 gate required to act; else flag)
  - `score ≥ 0.4` → no action
- Judge call is non-persisting (the `persist:false` pattern).

### Two-tier policy (the safety core)

- **Tier 1 always runs** (deterministic, safe).
- **Tier 2 requires all gates:** calibration `agree_rate ≥ 0.8` AND consistency `overall_mean_abs_dev ≤ 0.1` (from the Governance tab). Gate state is captured per-run in `integrity_runs.tier2_enabled` and shown in the Memory Audit tab.
- **No LLM-judged deletion below the confidence bar** — low-confidence candidates stop at the review queue (extend the needs-review pattern to findings).
- **Off until you enable it:** `EG_INTEGRITY_ENABLED` default `false`; engine must be explicitly turned on in Settings, and the docs will say: don't enable Tier 2 until the Governance tab shows green numbers.

### Audit + Memory Audit tab

- Every mutation (delete/supersede/merge/backfill/reclassify) writes `audit_log` + a finding (`action_taken`, resolved at write time).
- Flagged findings stay `open` until a human dismisses or applies them.
- **Memory Audit tab (GUI):**
  - **Gate status card** — calibration %, MAD, Tier 2 ENABLED/DISABLED + why.
  - **Findings ledger** — check, memory snippet, severity, action taken, judge reason; filterable by status; open findings get Dismiss / Apply buttons.
  - **Audit trail** — every memory mutation (auto-heal AND manual GUI edits — [DECIDE] wire dashboard memory edit/delete to write audit_log too, so the tab is the complete "changed or manipulated" surface) with before → after, actor, reason, timestamp.

### Config (Settings → General → Integrity, live getters)

| Key | Default | Meaning |
|---|---|---|
| `EG_INTEGRITY_ENABLED` | `false` | master switch |
| `EG_INTEGRITY_INTERVAL_MS` | `86400000` (24h) | schedule (piggyback the consolidation scheduler boot path) |
| `EG_INTEGRITY_MIN_CALIBRATION` | `0.8` | Tier 2 gate |
| `EG_INTEGRITY_MAX_MAD` | `0.1` | Tier 2 gate |
| `EG_INTEGRITY_SAMPLE_SIZE` | `25` | judge-sampled memories per run |
| `EG_INTEGRITY_DELETE_CONFIDENCE` | `0.15` | judge score below this → delete candidate |

### API

- `POST /api/dashboard/integrity/run` — manual full run now.
- `GET /api/dashboard/integrity/status` — last run summary + gate state.
- `GET /api/dashboard/integrity/findings?status=&severity=&limit=` — findings ledger.
- `POST /api/dashboard/integrity/findings/:id/resolve {action:'dismiss'|'apply'}` — human disposition; `apply` performs the deferred repair (Tier 2 re-check at apply time).
- `GET /api/dashboard/memory-audit?limit=&actor=` — audit_log rows for `memories` (auto-heal + manual).

### Files changed (planned)

| File | Change |
|---|---|
| `packages/engram-js/src/durable/schema.ts` | `integrity_runs` + `integrity_findings` + version 4.4.0-integrity |
| `packages/engram-js/src/services/integrityEngine.ts` | NEW — checks, two-tier executor, gate checks, audit/finding writes |
| `packages/engram-js/src/services/traceScorer.ts` | export generic judge-call helper for the memory-validity rubric |
| `packages/engram-js/src/api/routes/dashboard/integrity/route.ts` | NEW — run/status/findings/resolve |
| `packages/engram-js/src/api/routes/dashboard/memory-audit/route.ts` | NEW — audit trail |
| `packages/engram-js/src/api/routes/index.ts` | register both |
| `packages/engram-js/src/services/settingsService.ts` | `general.integrity_*` GENERAL_SETTINGS |
| `packages/engram-js/src/api/index.ts` | start integrity scheduler beside consolidation |
| `apps/web/src/App.tsx` | Memory Audit tab (gates, findings, audit trail) |
| `readme.md` / `AGENTS.md` | docs |

### Verification plan

1. `tsc` clean + web build green; containers rebuilt.
2. Schema: `integrity_runs`/`integrity_findings` exist, version 4.4.0-integrity.
3. Tier 1 on the LIVE store: trigger run → findings appear for any real null-embedding/sector/dupe issues; deterministic repairs applied with audit rows (verify via psql + `/memory-audit`).
4. Tier 2 gate: with current calibration (0.83) + MAD (0) the gate is green → run a sample; confirm judge findings + that low-confidence candidates are FLAGGED, not deleted; then disable `EG_INTEGRITY_ENABLED` → run is a no-op.
5. Memory Audit tab renders gates + ledger + audit trail; resolve/dismiss round-trips work.
6. No data harmed: supersede-based repairs are reversible; deletions logged with before-state.

### Retrieval-path add-on (separate, later)

For the case where the store is healthy but retrieval misses (the 090f5c45 trace): on low `recall_relevance` traces, re-recall with a distilled query (strip filler / LLM-compress) and, if a high-similarity memory surfaces that the first pass missed, log a `retrieval_failure` finding. No data surgery. Small, independent of this engine.

## Open decisions

- [DECIDE] Tier 2 default OFF until calibration ≥ 0.8 — **leaning: yes** (matches "off until green").
- [DECIDE] Memory-validity rubric = standalone judge call (not a 4th trace dimension) — **leaning: yes** (keeps trace dimensions clean).
- [DECIDE] Near-dupe merge = supersede-older-by-newer (reversible) — **leaning: yes**.
- [DECIDE] Memory Audit tab also captures manual GUI memory edits via audit_log — **leaning: yes** (complete "changed or manipulated" surface).

---

## ✅ Implementation Summary

*(append here when implemented — files changed, plan↔reality deviations, config flags, verification performed)*
