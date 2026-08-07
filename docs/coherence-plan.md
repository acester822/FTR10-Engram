# Implementation Plan: Memory Coherence (linked, contextual memory — rung 4)

> **Status:** PLANNED — not yet implemented. The fourth rung of the trust ladder: **calibration → integrity (validity) → optimization (enrichment) → coherence (context)**.
>
> **Problem this solves (user-observed):** the integrity engine keeps deleting memories like *"Important decision: restructure conditional rendering to safely handle undefined or empty data states."* — the judge is right (context-free, useless), but deleting is treating the symptom. The real failure is at **extraction time**: the turn contained the specifics (component, file, error, fix) and the extraction step stored only the announcement. The user's target: when they say *"I'm working on Engram,"* Engram should assemble a coherent, context-dense knowledge bundle — **like a Hermes skill, but auto-derived from the store, auto-maintained, and every sentence traceable to a real memory.**
>
> **Model:** *a skill is a static curated document; a memory cluster should be a living one.* Two halves: (1) extraction captures a **context frame** per fact and **links related facts** into clusters (the `edges` graph already exists and is barely used); (2) recall composes a **sourced bundle** from the cluster — read-only, validated, never cached stale.

## Guardrails (non-negotiable — same discipline as the other three rungs)

1. **The bundle is context, not fact.** It is injected into prompts, so it must be strictly source-anchored: every statement maps to a real memory (`[src:N]`), compose + validate judge passes (the enrichment pattern), unanchored statements are dropped — never invented. A wrong bundle is worse than no bundle.
2. **Bundles never write to the store.** Bundle composition is read-only context. It creates no memories, no edges, no audits. (The store stays the single authority; bundles are projections of it.)
3. **Never cached stale.** Bundles recompute per request (short TTL at most), so they cannot fossilize into outdated "skills." Live store always wins.
4. **Specifics or nothing.** The extraction rule: *a fact that would be meaningless without the surrounding conversation is not a fact — include the specifics or don't store it.* Measurable via the existing `extraction_fidelity` judge dimension + the calibration set.
5. **Sector boundaries unchanged.** Genome/episodic/emotional remain immutable; the intent/TODO gate stays (this plan reduces how often it fires by making extractions specific, it does not bypass it).

## Design

### P1 — Extraction context frame + write-time linking (root cause)

**Context frame** (extraction prompt change in the extraction module, same shape as compaction's `{summary, facts[]}` → now `{context, facts[], links[]}`):

- Before the facts list, the extraction call emits ONE line: `context: { project, module, file, topic }` — the concrete anchors of the turn (e.g. `project: engram`, `module: integrityEngine`, `file: services/integrityEngine.ts`). Attached to **every** fact from that turn as `metadata.context`.
- **Specifics-or-nothing rule** in the system directive: facts must contain the concrete what/where/why; a "decision" fact without its component + file + rationale is rejected by the model itself (and the existing `isWorthRemembering` floor stays as the last line).
- **Links**: `links: [{ from: <fact idx>, to: <fact idx>, type: "part_of" | "derives_from" | "related_to" }]` — extraction says which facts form a cluster (anchor = the overview/decision, satellites = the file/error/fix specifics). Only those three edge types are writable (exotic types stay manual).

**Write-time** (`rememberDurableMemory` chokepoint, already transactional):

- `metadata.context` persisted on each memory.
- Links become `edges` rows (`part_of`/`derives_from`/`related_to`) in the **same transaction** as the memory writes — no orphan edges.
- No new tables. Schema changes: none (edges + edge_types exist); memory metadata gains `context` + `cluster_anchor` markers where extraction designates them.

**Feedback loop**: ingest traces already score `extraction_fidelity` — the calibration set + report compare fidelity before/after this change; if specifics-or-nothing suppresses too much, relax to soft mode (store with context anchor only).

### P2 — Bundle composition (the "skill, but better")

New `clusterEngine.ts`:

1. **Cluster discovery** — given a topic (explicit param, or the project anchor of the top recall hit): start from the strongest matching memory, walk `edges` (part_of/derives_from/related_to) BFS + add high-similarity neighbors (≥ 0.75 sim), bounded (≤ 40 memories). Cluster = anchor + satellites. No cluster_anchor column needed — the anchor is computed (highest degree + oldest recorded_at).
2. **Composition** — compose rubric (same pattern as enrichment): order the bundle as *architecture facts → current state → conventions → pitfalls*, keep statements verbatim-anchored, tag each `[src:N]`, and **drop** anything that can't be anchored. Validate rubric: no cross-project drift (grounding), no hallucination, score ≥ 0.6 required.
3. **Read-only + TTL** — bundle is a projection; cache by topic for ≤ 5 min (like the 30s genome cache) purely for cost; the underlying memories are always re-read.
4. **Exposure** — `POST /api/memories/bundle?topic=engram` (new route) and integration into `/api/cognitive-context` (the Hermes plugin's `prefetch()`): when the plugin detects a project topic ("working on Engram"), the bundle block replaces the flat top-5 phenotype section for that topic; the flat recall stays as the general fallback.

### P3 — Cluster visibility + edge health

- **Mindmap tab** — render clusters (anchor + satellites + edge types) so the user can SEE the coherence the system is building; click a memory → its cluster.
- **Integrity check #9: `broken_links`** — edges whose target memory is superseded/deleted get flagged (and, with Tier-2 authority, pruned) — the graph cannot rot silently.
- **Memory Audit** — cluster membership shown on findings/detail where cheap.

### Files changed (planned)

| File | Change |
|---|---|
| `packages/engram-js/src/services/memoryLogger.ts` (extraction) | context frame + specifics-or-nothing directive + `{context, facts, links}` output |
| `packages/engram-js/src/durable/repository.ts` | `rememberDurableMemory` persists `metadata.context` + writes edges in the same transaction |
| `packages/engram-js/src/services/clusterEngine.ts` | NEW — cluster discovery (BFS + similarity), bundle compose + validate (read-only, TTL cache) |
| `packages/engram-js/src/api/routes/memories/bundle/route.ts` | NEW — `POST /api/memories/bundle?topic=` |
| `packages/engram-js/src/api/routes/cognitive-context` | bundle block for detected project topics |
| `packages/engram-js/src/services/integrityEngine.ts` | check #9 `broken_links` (edges → superseded/deleted memories) |
| `apps/hermes-plugin` | pass topic when detectable; render bundle block |
| `apps/web` | Mindmap cluster rendering (P3); cluster membership hints |
| `readme.md` / `AGENTS.md` | rung 4 docs |

### Verification plan

1. P1: ingest a scripted "decision" conversation (component + file + error + fix) → the stored memory carries `metadata.context` + specifics; `extraction_fidelity` judge on the ingest trace; NO "Important decision: …" class regenerated (run the integrity sampler after — the class should be gone from new extractions).
2. P2: `POST /api/memories/bundle?topic=engram` → every `[src:N]` resolves to a live memory, validate passes, no cross-project content; bundle differs from flat top-5 (coherent ordering, anchored statements).
3. P3: create a broken edge deliberately → integrity check #9 flags it; Mindmap renders a real cluster.
4. No writes from bundles (audit_log unchanged by bundle calls); edges only from extraction/`enrichMemory` transactions; undo paths unaffected.

## Open decisions

- [DECIDE] Specifics-or-nothing: hard reject vs soft (context-anchor only) — **leaning: hard, with a fidelity metric; relax if `extraction_fidelity` drops**.
- [DECIDE] Write-time edge types restricted to `part_of` / `derives_from` / `related_to` — **leaning: yes**.
- [DECIDE] Bundle = LLM-composed (dense, ordered, anchored, validated) vs verbatim concatenation — **leaning: LLM-composed** (it's read-only context; validation covers the risk).
- [DECIDE] Bundle TTL ≤ 5 min cache by topic — **leaning: yes** (cost only; store always re-read).
- [DECIDE] Topic detection: plugin passes topic when it knows it; fallback = project anchor of the top recall hit — **leaning: yes** (no fragile classifier in v1).
- [DECIDE] Cluster anchor computed on the fly (degree + age), no persisted column — **leaning: yes** (no write-path maintenance).

---

## ✅ Implementation Summary

*(append here when implemented — files changed, plan↔reality deviations, verification performed)*
