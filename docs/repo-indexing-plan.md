# Implementation Plan: Repo Baseline Indexing (structural knowledge ingestion)

> **Status:** PLANNED — not yet implemented. Design for review before any code.
>
> **Problem this solves (user-observed):** Engram's memory store improves in real time while working in a repo, but it **lacks the baseline knowledge of the repo itself**. On large projects, much of what the agent reads (file structure, exports, signatures, configs, README docs) never enters the store — the plugin only sees conversation turns (`/ingest/conversation`), **not the tool calls where the agent reads files**. Result: the store is forgetful about the very codebase the user works in, and recall for repo questions stays low (coverage 0 class). The user wants: enter a **repo URL** (e.g. `https://github.com/acester822/indexer_for_testing.git`) or a **local path** (e.g. `/home/ftr/Apps/indexer_for_testing`) in the web GUI → Engram initiates a **structural mapping of the repo into the store automatically**. Plus a small, non-intrusive **chat message** suggesting this operation when the user is continuously working in a location that has not been indexed (it is not automatic).
>
> **Model:** reuse the proven zero-LLM structural-indexing idea — the reference tool `engramx` (NickCirv/engram, Apache-2.0; AST mining via tree-sitter → local SQLite knowledge graph → query/token-reduction for AI coding agents) — but **native to Engram**: baseline code knowledge lands in the *same* Postgres/pgvector store, tagged by repo identity, audited, undoable, re-indexable, and composed into recall like any other memory. The reference tool is exactly what the user's suspicion said: **an indexer for code repositories for faster/better retrieval**. We are not adopting its binary; we are adopting its *idea* (deterministic structural extraction, zero LLM for structure) with Engram's discipline (audit, undo, dedupe, flag-first where LLM is involved).

## Guardrails (non-negotiable — same discipline as the other rungs)

1. **Repo identity is sacred — the user's #1 fear, made structural.** Every indexed memory carries `metadata.repo = <canonical identity>` (`owner/repo` for URLs, absolute path for local) and `metadata.repo_index = true`. Memories from different repos **never mingle**: no shared edges, no cross-repo bundle composition, and the grounding rule treats any other repo as foreign — *a repo named "engram" by a different owner is a different project, period* (same rule as the enrichment owner-guard, applied at ingestion). **The reference repo itself (`NickCirv/engram`, aka `indexer_for_testing`) is a test case for this rule, never an ingestion target.**
2. **Deterministic first, LLM only where it adds value.** Structure (files, entities, signatures, imports, configs) is extracted **without the generative model** — zero-LLM, like the reference tool. LLM summaries are used only for prose-heavy docs (READMEs, design docs), gated and flagged like every LLM path.
3. **Bounded and idempotent.** Caps on files/memories per run (defaults below); skip `.git`, `node_modules`, `dist`, `build`, binaries, vendored dirs; **re-index supersedes** the prior version of each file's memory (audit row with before/after, undoable) — never duplicates. Deleted files → their memories are superseded/removed.
4. **Store stays the single authority.** All writes go through the shared mutation + audit primitives. Run-locked (one index run at a time per repo), transactional — a failed run leaves no partial state.
5. **Redaction everywhere.** Repo content can contain `.env.example`, test tokens, internal IPs — the existing credential-redaction regex runs over all file content before embedding/storage (same rule as trace capture).
6. **The suggestion is a suggestion.** One per repo per session, honest wording ("isn't indexed — add baseline knowledge"), dismissible via a setting; never automatic indexing without the user's action.

## Design

### P1 — Index engine (`services/repoIndexer.ts` + `services/repoStore.ts`)

**Sources:**
- `{ type: "url", url }` — shallow clone (`--depth 1`) into the repos root (`EG_REPOS_ROOT`, default `./repos` inside the API container, volume-mounted).
- `{ type: "path", root }` — index a local directory in place (read-only scan; requires the path to be visible to the API container — see [DECIDE-2] for the Docker volume question).

**Walker:** recursive scan, skip rules above, caps `EG_REPO_MAX_FILES` (default 2000/run) and `EG_REPO_MAX_FILE_BYTES` (default 1 MB — a file bigger than this is skipped with a note, not truncated).

**Miner tier [DECIDE-1]:** deterministic structural extraction per supported language:
- *T1 (line-based heuristic)* — functions/classes/imports/export signatures via per-language patterns; zero deps, fast, ~80% of the value (README-grade baseline).
- *T2 (tree-sitter web-wasm)* — exact AST extraction (what the reference tool uses); adds a vendored dependency.
- *T3 (external `engramx` adapter)* — shell out to `npx engramx init` and read its `graph.db` via sql.js; battle-tested, zero-LLM, but an external runtime + WASM dependency.
- **Lean:** T1 for the first build (honest baseline), T2 as a follow-up if entity fidelity proves insufficient. [DECIDE]

**Per-repo output (one memory per file, plus doc memories):**
- **Code files** → one memory per file: `{ path, summary, entities[], imports[], exports[] }` — sector `semantic`, `metadata: { repo, file, kind: "repo_index" }`.
- **README / *.md / docs** → doc memories, LLM-summarized (gated, flagged) into project facts.
- **Config files** (`package.json`, `tsconfig*`, `docker-compose*`, `.env.example`…) → verbatim-ish fact memories (secrets redacted; `.env.example` keys are structure, not secrets, but values still go through redaction).
- **Edges:** `file → repo` (`part_of`), import graph (`related_to` between file memories). The `edges` table + cluster engine pick these up for free — repo clusters compose into bundles.

**Re-index:** per-file supersede (old memory → `superseded_at`, audit row `update / repo_index`, full before/after incl. embedding) then insert; run-locked; progress callback (files done / total) for the GUI.

### P2 — API + GUI ("Repos" tab)

- **Schema:** `DURABLE_SCHEMA_VERSION` bump; new `repos` table (`id, name, source_type, source, root, status, last_indexed_at, file_count, memory_count, error`).
- **Routes:**
  - `POST /api/repos/index {source}` → starts the run (async, returns job id)
  - `GET /api/repos` → list with stats
  - `GET /api/repos/:id/progress` → live progress (files done, current file, phase)
  - `POST /api/repos/:id/reindex` → re-run (supersede + fresh)
  - `DELETE /api/repos/:id` → **supersede all its indexed memories** (audited, undoable) + drop the row
  - `GET /api/repos/:id/recall-test?query=` → demo: run the query against the repo's memories so the user can see the baseline working
- **GUI:** new **Repos** tab — Add form (URL **or** local path), table (name, source, files, memories, last indexed, status), progress bar, Reindex / Delete / recall-test box. Settings → new **Repo Index** group (`EG_REPOS_ROOT`, caps, tip toggle).

### P3 — Working-location suggestion (chat message)

**Where it lives [DECIDE-3]:** server-side in the cognitive-context route (no plugin change) vs plugin-side in `apps/hermes-plugin/__init__.py`.

- *Server-side (lean):* Redis session counter keyed by project anchor (the bundle composer already detects the project topic). After **≥3 injections** in a session where that project has no `repos` row → append one tip line to the injected context block: *"ℹ️ This repo isn't indexed — add baseline knowledge (Web GUI → Repos)."* Once per repo per session, suppressed by `EG_REPO_TIP_ENABLED` (default true).
- *Plugin-side:* the plugin sees cwd + repeated work directly; but it needs a new API call to check index state and a plugin deploy. Server-side wins on zero-touch. [DECIDE]

## [DECIDE] items (with leanings)

1. **Miner tier** — T1 line-based heuristic first (zero deps, honest baseline); T2 tree-sitter as follow-up. *Not* T3 (external runtime dependency).
  - Implement T1 and T2
2. **Local-path access from Docker** — the API runs in a container; local paths need a volume. Lean: mount a **dedicated writable repos dir** (`./repos` on the host, e.g. `/home/ftr/engram-repos`) and a **read-only mount of `/home/ftr/Apps`** so the user can point at any of his existing projects without copying. Both configurable via compose env.
  - This is perfect, approved!
3. **Tip injection point** — server-side cognitive-context (no plugin deploy, no new API surface for the plugin).
4. **Doc-memory LLM use** — gated + flagged like every LLM path; if the repo has no README/docs, zero LLM calls happen at all.
  - Approved

## Files-changed table

| File | Change |
|---|---|
| `packages/engram-js/src/durable/schema.ts` | + `repos` table; version → `4.7.0-repo-index` |
| `packages/engram-js/src/services/repoIndexer.ts` | **NEW** — walker + miner + ingest (supersede, redaction, run-lock, progress) |
| `packages/engram-js/src/services/repoStore.ts` | **NEW** — `repos` table CRUD |
| `packages/engram-js/src/api/routes/repos/route.ts` | **NEW** — index / list / progress / reindex / delete / recall-test |
| `packages/engram-js/src/api/routes/index.ts` | register repos routes |
| `packages/engram-js/src/api/routes/cognitive-context/route.ts` | P3 tip injection (if server-side) |
| `apps/web/src/App.tsx` | Repos tab + Settings → Repo Index group |
| `docker-compose.yml` | repos volumes (writable repos dir + read-only Apps mount) |
| `apps/hermes-plugin/__init__.py` | only if [DECIDE-3] lands plugin-side |
| `readme.md`, `AGENTS.md` | docs at implementation end (after verification, per house rule) |

## Verification (same discipline as every rung — real execution, honest numbers)

1. **Index a fixture repo** (small throwaway project in `/tmp`, then a real one the user names) — confirm: file memories + edges + audit rows exist; `metadata.repo` correct on every row.
2. **Recall test** — a structural question (*"where is X defined?"*) against the repo's memories returns the baseline facts (coverage 0 → 1 class for that repo).
3. **Idempotency** — re-index twice: zero duplicates, supersede chains correct, audit rows present.
4. **Cross-repo isolation (the user's fear, made a test)** — index two repos with the *same name* (e.g. a fixture `engram` clone vs `FTR10-Engram`): no shared edges, no cross-repo bundle, grounding rejects the foreign repo.
5. **Redaction** — a fixture `.env.example` with a fake token → stored without the token.
6. **Delete** — `DELETE /api/repos/:id` supersedes all its memories; audit + undo restores.
7. **Tip** — N turns in an unindexed project → one suggestion; indexed project → none; toggle off → none.

## Implementation summary

*(appended when implemented, per house style)*
