# Implementation Plan: Memory Optimization Engine (enrichment)

> **Status:** PLANNED — not yet implemented. This is the third rung of the trust ladder: **calibration → integrity (validity) → optimization (enrichment)**. The engine takes the memories the user actually uses that are weakest (missing critical detail), finds the missing data from verified sources — the store itself, the codebase, and (opt-in) the web — and supersedes them with sourced, enriched successors. Every enrichment is diff-visible, audited, and reversible.

## Guardrails (non-negotiable — decided with the user)

1. **Never rewrite — supersede + diff.** Enrichment creates a sourced successor; the verbatim original stays in history via `superseded_at`. The audit tab shows before → after; undo restores the original and removes the successor.
2. **Sourced or rejected.** Every enrichment carries evidence: `file:line` (codebase), URL (web), or `memory_id` (store cross-link). Unsourced enrichments never reach the judge.
3. **Sector boundaries are sacred.** semantic + procedural only. Never genome (immutable), never episodic/emotional (preferences and experiences can't be "improved" by a crawl). `is_genome = false` enforced in the candidate query.
4. **Flag-first, like Tier 2.** The completeness rubric is a NEW rubric — it gets no mutation authority until validated. Candidates land in the Memory Audit tab as findings with verdict `enrich` (diff + sources shown); the user Applies. `EG_ENRICHMENT_ACTION` default `flag`.

## Design

### Selection (deterministic filter first — bounds judge cost)

- Pool: `sector IN ('semantic','procedural')`, `superseded_at IS NULL`, `embedding IS NOT NULL`, `is_genome = false`, no OPEN finding of the same check (the dedup guard from integrity).
- Deterministic pre-filter: order the pool by **usage** (`access_count` asc rarity, `decay_rate` low = stable, `reinforced_stability` if present) — take top `EG_ENRICHMENT_POOL_SIZE` (default 200).
- Judge-sample the top `EG_ENRICHMENT_BATCH_SIZE` (default 8) with the **completeness rubric** (`callJudge`, non-persisting): `{"score": 0-1, "reason": ..., "missing": "<what detail is absent>"}` where 0 = complete, 1 = critically incomplete.
- Candidates: `score ≥ EG_ENRICHMENT_MIN_INCOMPLETE` (default 0.6) AND usage above a floor (`EG_ENRICHMENT_MIN_USAGE`, default: access_count ≥ 1 OR reinforced_stability > 0.05 — i.e. the user has touched it).

### Enrichment sources (in order — cheapest/verifiable first)

1. **The store itself** — recall with the memory content as query (reuse the recall SQL); any memory with sim ≥ 0.85 whose content adds facts not in the candidate → cross-link evidence (`memory_id`).
2. **Codebase search** — `rg -l -i -m 5 <key terms> <roots>` over `EG_ENRICHMENT_SEARCH_ROOTS` (default `/home/ftr/Apps` — project dirs). Hard allowlist: roots must resolve inside the configured list; `execFile` with args array (no shell); `--max-count` to bound; excerpts capped (e.g. 3000 chars, `file:line` prefix). **Local, verifiable, the primary source for this user's project memories.**
3. **Web (opt-in)** — searxNcrawl (`auto_search_url`, already configured in Settings) JSON search, top K results, snippet extraction. **TECHNICAL facts only** (semantic/procedural already enforced), relevance-judged by the judge before inclusion, `EG_ENRICHMENT_WEB_ENABLED` default `false`.

### Enrichment build + mutation

- Compose `enriched = original + missing-detail answer(s)` — the LLM writes ONLY the added content (never rewrites the original verbatim text), each addition tagged with its source. Judge validates the composed version: factual, in-scope, no hallucination (second `callJudge`, `score ≥ 0.6` to pass).
- `enrichMemory(oldId, enrichedContent, sources)` in `durable/mutations.ts`: fetch old row → embed enriched content → INSERT successor (same user/project/sector, fresh uuid, fresh embedding, recorded_at=now) → `superseded_at = now` on the original → ONE audit row: operation `enrich`, `before_state` = old row (full), `after_state` = new row (full), `metadata.sources`.
- **Undo** (`undoAuditEntry` extension): delete the successor (id from after_state) + clear the original's `superseded_at`. Same pattern as delete/supersede undo.

### Findings + GUI (reuses everything)

- `check_name = 'enrichment_candidate'`, `severity = 'medium'`, `action_taken = 'flag'`, verdict `enrich`, detail = `{score, reason, missing, sources[], old_content, new_content}`.
- Memory Audit tab: "Would do" column renders **Enrich memory (sourced)**; expanded finding shows sources + old/new side by side; **Apply** performs the enrichment (human = approval, no gate needed — same as integrity Apply); audit trail shows the `enrich` row with sources; undo restores.
- Gate status card gains nothing new — the same automatic gate (calibration/MAD) applies; the enrichment rubric's own validation is covered by flag-first (same stance as Tier 2).

### Config (Settings → General → Enrichment, live getters)

| Key | Default | Meaning |
|---|---|---|
| `EG_ENRICHMENT_ENABLED` | `false` | master switch |
| `EG_ENRICHMENT_ACTION` | `flag` | `flag` (safe) / `apply` |
| `EG_ENRICHMENT_INTERVAL_MS` | `86400000` | schedule |
| `EG_ENRICHMENT_POOL_SIZE` | `200` | deterministic usage filter |
| `EG_ENRICHMENT_BATCH_SIZE` | `8` | judge-sampled per run |
| `EG_ENRICHMENT_MIN_INCOMPLETE` | `0.6` | completeness score bar |
| `EG_ENRICHMENT_MIN_USAGE` | `access_count ≥ 1` | "used most" floor |
| `EG_ENRICHMENT_SEARCH_ROOTS` | `/home/ftr/Apps` | codebase search allowlist |
| `EG_ENRICHMENT_WEB_ENABLED` | `false` | web crawl opt-in |
| `EG_ENRICHMENT_MAX_WEB_RESULTS` | `5` | per candidate |

### API

- `POST /api/dashboard/enrichment/run` — manual run now.
- `GET /api/dashboard/enrichment/status` — enabled/action/last run.
- Apply/Dismiss reuse `/api/dashboard/integrity/findings/:id/resolve` (extended for verdict `enrich`).
- `POST /api/dashboard/memory-audit/:id/undo` — already handles the new `enrich` operation.

### Files changed (planned)

| File | Change |
|---|---|
| `packages/engram-js/src/services/enrichmentEngine.ts` | NEW — selection, completeness rubric, source pipeline (store/codebase/web), build+validate |
| `packages/engram-js/src/durable/mutations.ts` | `enrichMemory()` + `undoAuditEntry` handles `enrich` |
| `packages/engram-js/src/services/integrityEngine.ts` | `resolveFinding` apply branch for verdict `enrich` |
| `packages/engram-js/src/api/routes/dashboard/enrichment/route.ts` | NEW — run/status |
| `packages/engram-js/src/api/routes/index.ts` | register |
| `packages/engram-js/src/services/settingsService.ts` | `general.enrichment_*` GENERAL_SETTINGS |
| `packages/engram-js/src/api/index.ts` | scheduler start (beside consolidation + integrity) |
| `apps/web/src/App.tsx` | "Would do: Enrich memory (sourced)", sources + old/new diff in expanded finding |
| `readme.md` / `AGENTS.md` | docs |

### Verification plan

1. `tsc` clean; containers rebuilt; settings surface.
2. Manual run against the LIVE store with `EG_ENRICHMENT_ACTION=flag`: confirm findings appear for genuinely thin, used memories (pilot: the "PDF reports are generated using jsPDF 2.5.1 and html2canvas-pro…" memory — codebase search must surface the full-bleed/multi-page facts with `file:line`).
3. Confirm no episodic/genome/emotional memories ever enter the pool.
4. Apply one candidate → verify: successor exists with fresh embedding, original superseded, audit `enrich` row with sources, "Would do" → done; **undo** → successor removed, original active.
5. Confirm flag-first blocks mutation when `EG_ENRICHMENT_ACTION=flag` even with the gate open; web stays off by default.
6. No data harmed: verbatim original preserved in all cases (bi-temporal history intact).

## Open decisions

- [DECIDE] Enrichment action default `flag` (same stance as Tier 2 — new rubric, no mutation authority until validated) — **leaning: yes**.
    - No, with the system we have in place if something were to happen, it could be undone, still track 100%, but allow it to happen. At some point the agents must be trusted to make the right call, and if they don't I can click the undo button.
- [DECIDE] Web enrichment default OFF; codebase + store-first only initially — **leaning: yes** (inward-first philosophy).
    - Default to on. It is there for a reason, it should be used
- [DECIDE] Default search roots `/home/ftr/Apps` — **leaning: yes** (project dirs; adjust via Settings).
    - This one is trickier, the Apps directory is a good default, but what if it needs info that is in .ftr, or .hermes? Not everything is in the Apps folder, there needs to be a mechanism in place for this, perhaps a "review" for access to places not in Apps?
- [DECIDE] Successor gets a fresh embedding via `embed()` — **leaning: yes** (otherwise the enriched memory recalls as the thin original).
    - Yes, otherwise the entire process is for nothing
- [DECIDE] Enrichment writes ONE audit row (operation `enrich`, before/after full rows) so undo is a single click — **leaning: yes**.
    - 100% yes, it needs to be automatic, but restorable if there is a mishap

---

## ✅ Implementation Summary (2026-08-07)

Implemented + deployed. Open decisions resolved per user (edited in doc):
- **Action defaults `apply`** — agents are trusted; the audit + undo are the safety net. Verified: 4 real enrichments applied in the first run.
- **Web ON by default** — searxNcrawl via the existing `AutoSearchEngine`; sources carry URLs (verified: DeepWiki + langfuse.com/docs snippets with `[src:N]` tags in the enriched text).
- **Access-request mechanism** (user's idea): when codebase search finds no evidence in the allowed roots and `~/.hermes` / `~/.ftr` exist un-granted, a `enrichment_access_request` finding appears — **Apply = grant** (persists into `EG_ENRICHMENT_SEARCH_ROOTS` via `saveSettings`), Dismiss = deny.
- Fresh embedding on successors. ✅ One audit row (`enrich`, before/after full rows) + one-click undo. ✅ (undo verified: successor removed, original restored, `undo_enrich` audit row written)

### Files changed
- `services/enrichmentEngine.ts` (NEW) — selection (used-most × completeness rubric), sources in order store → codebase (rg over allowlisted roots, file:line) → web, compose + validate judge calls, access-request findings, run lock.
- `durable/mutations.ts` — `enrichMemory()` (successor + supersede + one audit row) + `undoAuditEntry` `enrich` branch.
- `services/integrityEngine.ts` — `resolveFinding` handles `enrichment_access_request` (grant) + `enrichment_candidate` apply; run lock.
- `embeddings/embed.ts` — `normalizeEmbedding()` (providers may return numeric strings).
- `api/routes/dashboard/enrichment/route.ts` (NEW) + register + scheduler; settings `general.enrichment_*`.
- `apps/web` — "Run enrichment now" button, Would-do: "Enrich memory (sourced)" / "Grant access to <root>", Enrichment settings group.

### ⚠️ Bugs found & fixed during verification
1. **`::halfvec` bind convention**: node-pg serializes JS arrays as `{"0.1","0.2"}` (quoted) which pgvector REJECTS ("invalid input syntax for type halfvec"). The codebase convention (repository `asVector`) is to bind embeddings as **JSON strings** (`[0.1,0.2]`). Every embed-fed bind in the new engines now uses `JSON.stringify(normalizeEmbedding(...))`. Also: the current embedding provider returns values as numeric STRINGS — normalize first.
2. **Concurrent runs**: manual + scheduled runs overlapped → the same memory enriched twice (two successors). Fixed with an in-process run lock in BOTH engines (`{skipped: true, reason: "already in progress"}`). The redundant successor from the overlap was superseded manually.
3. Config note: `env.vec_dim` (1536) ≠ column dim (halfvec(768)); when the embedding provider is down, the synthetic fallback (1536-dim) fails dim checks and enrichments skip gracefully — safe degrade.

### Verification
- Live run: sampled 5, 4 candidates enriched with sourced content (compaction-trigger memory gained the 167K-token detail from DeepWiki; Langfuse memory gained the data-model concepts), successors embedded, originals superseded, `enrich` audit rows with sources; undo round-trip verified; access-request path code-verified.
