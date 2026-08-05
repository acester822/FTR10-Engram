# Model Configuration Audit — 2026-08-05

Exhaustive sweep of every model reference in the FTR10-Engram codebase
(`packages/engram-js`, `apps/web`, `apps/vscode-extension`, `scripts/`, configs, docs).
Trigger: recurring consolidation failures caused by a model-config tangle
(consolidation ran on `LFM2.5-1.2B-Instruct` while `docker-compose.yml` set a dead
`EG_GENERATIVE_MODEL=Gemma-4-12B-no-thinking` that is read nowhere).

---

## Table 1 — ALL model-related configuration variables

| #   | Variable                                                                    | Default in code                          | Read at                                                                                                                             | Purpose                                                                  | Deployed value                                                                | Action Requested  |
| --- | --------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ----------------- |
| 1   | `EG_MODEL_GENERATIVE`                                                       | `qwen3.5:2b`                             | `configuration/index.ts:23` → `env.generative_model`                                                                                | Generative LLM for **extraction, compaction, consolidation, autoSearch** | `LFM2.5-1.2B-Instruct` (.env)                                                 | Remove Default    |
| 2   | `EG_MODEL_GENERATIVE_FALLBACK`                                              | `qwen2.5:3b`                             | `index.ts:24` → `env.fallback_model`                                                                                                | **Dead** — only read by unused `SYNTHESIS_MODEL` const                   | `qwen2.5:3b` (.env) — **not served by llama-swap**                            | Remove Completely |
| 3   | `EG_MODEL_EMBEDDING`                                                        | `qwen3-embedding:0.6b`                   | `index.ts:25` → `env.embed_model_primary`                                                                                           | Universal embedding default                                              | `nomic-embed-text-v1.5` (.env)                                                | Remove Default    |
| 4   | `EG_MODEL_EMBEDDING_FALLBACK`                                               | `bge-m3`                                 | `index.ts:30,89` → `env.embedding_fallback`                                                                                         | Provider-chain fallback                                                  | unset → `bge-m3`, **filtered out of providerChain** (not in `knownProviders`) | Remove Completely |
| 5   | `EG_MODEL_EMBED_{EPISODIC,SEMANTIC,PROCEDURAL,EMOTIONAL,REFLECTIVE}`        | per-facet default = `EG_MODEL_EMBEDDING` | `index.ts:26-29` getters `embed_model_*`                                                                                            | Per-facet embedding override                                             | all unset                                                                     | Leave As Is       |
| 6   | `EG_OPENAI_MODEL`                                                           | —                                        | `index.ts:95` → `env.openai_model`; **dual use**: `embed.ts:133` (embedding model) **and** `route.ts:376,391` (chat-proxy fallback) | Embedding model + chat fallback                                          | `Nomic-Embed-Text-v1.5` (compose)                                             | Remove Completely |
| 7   | `EG_EMBED_MODEL`                                                            | —                                        | `models.ts:82` direct `process.env` read                                                                                            | Global embedding override — **beats the whole cascade**                  | `nomic-embed-text-v1.5` (.env) — **undocumented** (not in .env.example)       | Remove Completely |
| 8   | `EG_<PROVIDER>_MODEL` (dynamic)                                             | —                                        | `models.ts:40-44`                                                                                                                   | Provider-wide embedding override                                         | unset                                                                         |                   |
| 9   | `EG_<PROVIDER>_<FACET>_MODEL` (dynamic, 25 combos)                          | —                                        | `models.ts:34-38`                                                                                                                   | Per-facet per-provider embedding override                                | unset                                                                         |                   |
| 10  | `EG_CHAT_MODEL`                                                             | —                                        | `route.ts:376,391` direct `process.env` read                                                                                        | Chat-proxy model fallback                                                | unset — **undocumented**                                                      | Remove Completely |
| 11  | `EG_CONSOLIDATION_MODEL`                                                    | —                                        | `consolidationEngine.ts:14` (added today)                                                                                           | Consolidation LLM override                                               | unset → falls back to `env.generative_model`                                  | Leave As Is       |
| 12  | `EG_CONSOLIDATION_BATCH_MEMORIES`                                           | 150                                      | `consolidationEngine.ts:27` (added today)                                                                                           | Max memories per LLM call                                                | unset → 150                                                                   | na                |
| 13  | `EG_GENERATIVE_MODEL`                                                       | —                                        | **read NOWHERE — dead var**                                                                                                         | Was meant to steer generative tasks                                      | `Gemma-4-12B-no-thinking` (compose) — **the trap that started this**          | Remove Compl      |
| 14  | `EG_GENERATIVE_URL`                                                         | `""`                                     | `index.ts:102` → `env.generative_url`                                                                                               | Generative base URL                                                      | `http://10.10.10.41:8080/v1` (compose)                                        |                   |
| 15  | `EG_UPSTREAM_LLM_URL`                                                       | `""`                                     | `index.ts:122` → `env.llm_url`                                                                                                      | Chat-proxy upstream                                                      | `http://10.10.10.41:8080/v1` (compose)                                        |                   |
| 16  | `EG_OPENAI_BASE_URL`                                                        | `https://api.openai.com/v1`              | `index.ts:94` → `env.openai_base_url`                                                                                               | OpenAI-compat endpoint (embeddings + proxy)                              | `http://10.10.10.41:8080/v1` (compose)                                        |                   |
| 17  | `EG_EMBEDDINGS`                                                             | `openai`                                 | `index.ts:88` → `env.emb_kind`                                                                                                      | Embedding provider kind                                                  | `openai` (.env)                                                               |                   |
| 18  | `EG_VEC_DIM`                                                                | **1536**                                 | `index.ts:124` → `env.vec_dim`                                                                                                      | Embedding dimensions sent to API                                         | `768` (.env — matches `halfvec(768)`)                                         |                   |
| 19  | `EG_EMBED_TIMEOUT_MS`                                                       | —                                        | `embed.ts:23` direct `process.env` read                                                                                             | Embedding timeout                                                        | `30000` (.env) — **undocumented**                                             |                   |
| 20  | `EG_LOCAL_MODEL_PATH`                                                       | `""`                                     | `index.ts:123` → `env.local_model_path`; `embed.ts:291,491`                                                                         | Local embedding path (dormant)                                           | unset                                                                         | Remove Compl      |
| 21  | `EG_OPENAI_API_KEY` / `EG_GEMINI_API_KEY` / `EG_AWS_*` / `EG_SIRAY_API_KEY` | —                                        | `index.ts:93-100`                                                                                                                   | Provider auth                                                            | openai key set, others empty                                                  |                   |
| 22  | `EG_CONSOLIDATION_RECENT_*` / `DEEP_*` (6 vars)                             | 4h·7d·2 / 24h·30d·3                      | `consolidationEngine.ts:22-27`                                                                                                      | Tier scheduling (intervals, windows, min-groups)                         | all unset                                                                     |                   |

**Also:** `EG_GENERATIVE_URL`/`EG_UPSTREAM_LLM_URL`/`EG_OPENAI_BASE_URL`/`EG_OPENAI_API_KEY` are
compose-substituted from `REMOTE_LLM_URL`/`REMOTE_LLM_API_KEY`, which live **only in the
creating shell** (not in `.env`) — a bare `docker compose up` silently renders them as `/v1` + empty key.

---

## Table 2 — ALL hardcoded model references in code/config

| #   | Location                                                       | Hardcoded value                                                                                                                                                                   | Impact                                                                                            | Action Requested |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------- |
| 1   | `configuration/index.ts:23`                                    | `"qwen3.5:2b"`                                                                                                                                                                    | Generative default — **not served by llama-swap**; masks misconfiguration with silent wrong-model | Remove           |
| 2   | `configuration/index.ts:24`                                    | `"qwen2.5:3b"`                                                                                                                                                                    | Fallback default — **not served by llama-swap** (404 if ever used)                                | Remove           |
| 3   | `configuration/index.ts:25`                                    | `"qwen3-embedding:0.6b"`                                                                                                                                                          | Embedding default — **not served by llama-swap**                                                  | Remove           |
| 4   | `configuration/index.ts:30,89`                                 | `"bge-m3"`                                                                                                                                                                        | Embedding fallback — not served; also dropped from `providerChain()`                              | Remove           |
| 5   | `database/models.ts:16-19`                                     | `text-embedding-3-small`, `models/gemini-embedding-001`, `amazon.titan-embed-text-v2:0`, `text-embedding-3-small`                                                                 | Cloud provider defaults (dormant here) — header comment claims "no hardcoded models"              | Remove           |
| 6   | `embeddings/facets.ts:15,28,41,54,68`                          | `"episodic-optimized"` … `"reflective-optimized"`                                                                                                                                 | **Dead fields** — `facetConfigs[*].model` is never read                                           | Remove           |
| 7   | `api/routes/chat/completions/route.ts:113`                     | `'engram-proxy'`                                                                                                                                                                  | SSE chunk `model` label default                                                                   |                  |
| 8   | `route.ts:376,391`                                             | `body.model → EG_CHAT_MODEL → env.openai_model`                                                                                                                                   | If a client omits `model`, **Nomic (an embedding model) is sent to chat completions**             | Remove           |
| 9   | `embeddings/embed.ts:190`                                      | `get_model(s, "gemini")`                                                                                                                                                          | Per-facet Gemini models (dormant provider)                                                        | Remove           |
| 10  | `apps/vscode-extension/src/extension.ts:675`                   | `'proxy'`                                                                                                                                                                         | Chat model name the extension sends                                                               |                  |
| 11  | `tests/sseValidation.test.ts:21,47`                            | `'qwen3.5:2b'`                                                                                                                                                                    | Test fixture                                                                                      | Remove           |
| 12  | `scripts/backfill_embeddings.py:41`                            | `EMBED_MODEL = "Nomic-Embed-Text-v1.5"`                                                                                                                                           | Backfill script (matches deployment)                                                              | Remove           |
| 13  | `docker-compose.yml:56`                                        | `EG_GENERATIVE_MODEL: "Gemma-4-12B-no-thinking"`                                                                                                                                  | **Dead var — read nowhere**; the exact trap behind today's failure                                | Remove           |
| 14  | `docker-compose.yml:54`                                        | `EG_OPENAI_MODEL: "Nomic-Embed-Text-v1.5"`                                                                                                                                        | Embedding + chat fallback                                                                         | Remove           |
| 15  | `.env.example:41-48`                                           | `LFM2.5-1.2B-Instruct`, `qwen2.5:3b`, `qwen3-embedding:0.6b`, `bge-m3`                                                                                                            | Documents defaults that **disagree with code defaults** (`qwen3.5:2b`)                            | Remove           |
| 16  | `docs/model-breakdowns.md`                                     | `qwen3.5:2b`, `qwen2.5:3b`, `qwen2.5:14b`, `bge-m3`, `nomic-embed-text`, `all-MiniLM-L6-v2`; references **nonexistent** `EG_EXTRACTION_MODEL`, `get_defaults()`, docker auto-pull | Stale/aspirational, self-contradictory (even contains "todo - clean up")                          |                  |
| 17  | `docs/architecture.excalidraw`, `docs/assets/architecture.svg` | `qwen3.5:2b · qwen3-embedding:0.6b`                                                                                                                                               | Stale diagrams                                                                                    |                  |
| 18  | `AGENTS.md` model table                                        | `LFM2.5-1.2B-Instruct` default                                                                                                                                                    | Matches actual deployment; readme.md two-tier table now matches code                              |                  |

---

## Key findings

1. **Two generative vars, one dead.** `EG_GENERATIVE_MODEL` (compose, Gemma) is read nowhere;
   `EG_MODEL_GENERATIVE` (LFM2.5) drives everything. The intended "Gemma is the generative model"
   was never wired. **This is the root of the recurring model confusion.**
2. **Three overlapping embedding vars.** `EG_EMBED_MODEL` (wins all), `EG_MODEL_EMBEDDING`
   (config default), `EG_OPENAI_MODEL` (used first in `emb_openai` + doubles as chat fallback).
   The elaborate `models.ts` cascade is effectively bypassed on the openai path.
3. **Hardcoded defaults that don't exist on llama-swap**: `qwen3.5:2b`, `qwen2.5:3b`,
   `qwen3-embedding:0.6b`, `bge-m3` — silent traps whenever an env var is missing.
4. **Direct `process.env` reads bypassing the config map**: `EG_CHAT_MODEL`, `EG_EMBED_MODEL`,
   `EG_EMBED_TIMEOUT_MS` (all undocumented in `.env.example`).
5. **Dead code**: `facets.ts` model fields, `fallback_model`/`SYNTHESIS_MODEL`, `EG_LOCAL_MODEL_PATH`
   (unused path), `providerChain()`'s bge-m3 entry (filtered by `knownProviders`).
6. **`consolidation_hash` is never written** anywhere (schema-only) → grouping is vestigial; the
   whole store is one "unhashed" group (now handled by chunking).
7. **Deep tier `minAccess` is hardcoded (1)** in `runTier` calls — the old never-accessed pile is
   intentionally out of consolidation scope (decays instead); not env-overridable.

## Suggested consolidation (next step, not yet implemented)

- One canonical registry: `EG_EXTRACTION_MODEL`, `EG_COMPACTION_MODEL`, `EG_CONSOLIDATION_MODEL`,
  `EG_EMBEDDING_MODEL` — each resolved through a single function, **no hardcoded names as
  defaults** (fail fast if unset; this deployment sets everything explicitly anyway).
- Delete the dead `EG_GENERATIVE_MODEL`; move direct reads (`EG_CHAT_MODEL`, `EG_EMBED_MODEL`,
  `EG_EMBED_TIMEOUT_MS`) into the config map; align `.env.example` + docs with code.
- Immediate model fix available: set `EG_CONSOLIDATION_MODEL: "Gemma-4-12B-no-thinking"` in the
  compose environment block (the code support landed today).

# My Response: I think we are vibing the same fixes for the most part. But yes, this is what I want:
## One canonical registry - Yes!! Wire this into a new settings tab in the web gui.
### UI Layout:
1. Provider Settings:
- The user enters the Provider Type, URL, and Port
   - Provider type is a dropdown with wired up options (should just be OpenAI Compatible right now) 
   - URL is a field that is formatted to only accept an IP address, aka 10.10.10.41, code the rest (user enters 10.10.10.41, code completes this as http://10.10.10.41:8080/v1).

1. Generative Models:
- Variables:
  - Generative Model: If this is set it visually populates the individual function variables (Extraction, Compaction, and Consolidation)
  - Individual Function Models:
    - Extraction Model
    - Compaction Model
    - Consolidation Model

2. Embedding Models:
- Variables:
  - Embedding Model: If this is set it visually populates the individual per facet modeling (EPISODIC,SEMANTIC,PROCEDURAL,EMOTIONAL,REFLECTIVE.)
  - Individual Embedding Models:
    - Episodic Model
    - Semantic Model
    - Procedural Model
    - Emotional Model
    - Reflective Model    

### IMPORTANT!!! 
- I want there to be a test button for each models section!! This test button does two things, it saves all settings, and tests that they are valid (should send a small request and get a valid response back). If this fails, it needs to be indicated to the user. 
- This UI should be the ONLY place providers and models are set. No defaults anywhere else, no fallbacks, nothing hard coded.

### Additional Consideration
- Come up with a good way to also have a per model section provider override, ie a user wants to use a different provider for Generative models and Embedding models. 
- Bonus points for wiring in the rest of the settings that are user editable, when we are done, there will not be a .env or variables that need set in the .env or via docker


---

# Implementation Summary — directive #1 (canonical registry + Settings tab) — 2026-08-05

## What shipped
- **Postgres-backed settings store** — `app_settings` table (schema bumped `4.1.0-settings`),
  `src/services/settingsService.ts`. Loaded at boot after migrations; seeded ONCE from current
  env values (bootstrap); mutated via the API. Postgres chosen over files because the container
  cannot write to disk (EACCES on /app).
- **Canonical model registry** — `src/database/modelRegistry.ts`:
  `resolveGenerativeModel(task)` / `resolveEmbeddingModel(facet)` / `resolveProviderUrl(section)`.
  Resolution chain everywhere: **Settings (GUI) → env override → FAIL with a clear message.**
  Zero hardcoded model names remain.
- **Settings API** — `src/api/routes/settings/route.ts`:
  - `GET /api/settings` → current settings + resolved (effective) config
  - `PUT /api/settings` → save (validated: host format, port range)
  - `POST /api/settings/test` → **saves all settings, then live-tests a section**
    (generative = chat-completion ping; embedding = embed ping; returns ok/latency/dims/error)
- **GUI Settings tab** (`apps/web/src/App.tsx`, new "Settings" nav item):
  Provider Settings (type dropdown "OpenAI Compatible", IP/host field, port, live base-URL
  preview), Generative Models (master + extraction/compaction/consolidation + per-section
  provider override), Embedding Models (master + 5 facets + override), **Test & Save** button
  per section with pass/fail badges.
- **Consumers rewired to the registry at call time** (GUI changes apply WITHOUT restart):
  memoryLogger (extraction), compactionEngine, consolidationEngine (+ synthesis), autoSearch,
  embeddings/embed.ts, chat-proxy fallback.
- **Removal pass per the Action matrix**: hardcoded defaults (qwen3.5:2b, qwen2.5:3b,
  qwen3-embedding:0.6b, bge-m3), `PROVIDER_DEFAULTS`, `facets.ts` dead model fields,
  `EG_OPENAI_MODEL`, `EG_CHAT_MODEL`, `EG_EMBED_MODEL`, `EG_LOCAL_MODEL_PATH`,
  `EG_GENERATIVE_MODEL`, `EG_MODEL_GENERATIVE_FALLBACK`, `EG_MODEL_EMBEDDING_FALLBACK` —
  removed from code, docker-compose.yml, and .env.example. Tests + backfill script de-defaulted.

## Deviations (plan → reality)
1. Settings persist in **Postgres**, not files (container cannot write — only viable option).
2. `EG_MODEL_GENERATIVE` / `EG_MODEL_EMBEDDING` / `EG_MODEL_EMBED_*` kept as **low-priority env
   overrides** (per "Remove Default", not "Remove Completely"); the "no .env at all" end-state is
   the bonus milestone.
3. `scripts/backfill_embeddings.py` reads `EG_MODEL_EMBEDDING` with its previous value as a script
   fallback (a bare script needs a default to run).
4. Chat-proxy fallback model = generative master (was `EG_CHAT_MODEL` → `EG_OPENAI_MODEL`).
5. Deep-tier `minAccess=1` still hardcoded (outside this directive).
6. Dormant provider paths (gemini/aws/siray/local) keep dynamic resolution but lost their
   hardcoded defaults.

## Verification (live, deployed)
- `tsc --noEmit` clean; `apps/web` vite build clean.
- Boot: `app_settings` table created (schema 4.1.0-settings), seeded once from env
  (provider 10.10.10.41:8080, generative LFM2.5-1.2B-Instruct, embedding
  nomic-embed-text-v1.5 + per-facet `EG_MODEL_EMBED_PROCEDURAL=CodeRankEmbed` preserved).
- `GET /api/settings` → settings + resolved; master model correctly populates
  extraction/compaction/consolidation when per-task values are empty.
- `POST /api/settings/test`:
  - generative → `{ok:true, model:"LFM2.5-1.2B-Instruct", providerUrl:"http://10.10.10.41:8080/v1", latencyMs:208}`
  - embedding → `{ok:true, model:"nomic-embed-text-v1.5", latencyMs:15, dims:768}` (matches halfvec(768))
- Consolidation via registry: chunks 150/150/150/126, all `Consolidation LLM returned actions`, 0 failures.
- Web GUI :8099 serves the new Settings tab (bundle grep confirms).


---

# Implementation Summary — bonus milestone (general settings in GUI) + IDE-save noise fix — 2026-08-05

## General settings (".env dies" milestone, part 1)
- `settingsService` gains `GENERAL_SETTINGS` (26 keys → legacy env vars: server port, vec dim,
  payload size, API key, embed timeout/kind, rate limits, compaction, auto-search, consolidation
  tiers) with `applySettingsToEnv()` (mirror into process.env; settings win over .env) and
  `generalSettingsView()`.
- **Boot ordering fix (critical):** `server.ts` now runs `runSettingsBootstrap()` in `main()`
  BEFORE the dynamic `import("./api/index")`, so settings land in process.env before the config
  module bakes `env.*` and before module-load constants (e.g. consolidation tier intervals) are
  read. `saveSettings` also mirrors to process.env live — runtime-read values change immediately.
- Settings API: `GET/PUT /api/settings` accept a `general` section with per-type validation
  (number/bool/string). GUI: new "General Settings" card (6 groups, 26 fields, Save button).
- Verified live: PUT 3600000 → GET shows it immediately; `docker compose restart` → scheduler log
  shows `recentIntervalMs: 3600000` (settings win at boot); cleared → engine default restored.

## IDE-save diff noise (user-reported: "they look blank and not good for anything")
- **Root cause:** `/api/ide/events` stored every VSCode save event DIRECTLY as a memory via
  `rememberDurableMemory` — bypassing `isWorthRemembering` (whose `[ide save:` / `diff for`
  rejections only guard the extraction path). The extension sends diff SNIPPETS, so each save
  produced a truncated 1-2 line fragment: 223 such rows, polluting the shared store.
- **Fix:** the route now acknowledges save events but does NOT store them (`skipped: "save events
  not stored as memories"`); the audit trail lives in the editor's file history / VCS. Existing
  223 rows hard-deleted (2,093 active remain). Verified: POST fake save → skipped, memory count
  unchanged.
- If real diff capture is wanted later, it should be a proper summary feature (extension-side),
  not raw save dumps as memories.

## Verification (live)
- `tsc --noEmit` clean; web build clean; both containers healthy.
- Settings: live mirror ✓, boot-apply-before-config ✓ (scheduler const 3600000 after restart),
  persistence ✓, per-type validation ✓.
- IDE events: skipped ✓, store unchanged ✓, purge 223 → 0 ✓.


---

# Implementation Summary — advanced settings table + port/kind de-dup — 2026-08-05

## Advanced Settings table (GUI)
- 36 remaining env vars added as an **Advanced Settings** table at the bottom of the
  General Settings card, grouped (Database / Provider Keys / Vector Store / Misc), with a
  warning banner: *"Advanced settings — do not edit unless necessary. Values persist and
  apply at next restart. Database/Redis connection values are read at startup before the
  settings store is available — change those in docker-compose/.env and recreate the
  container."* (The DB pool is built at module load, before settings can be read — genuine
  chicken-and-egg, so PG/Redis rows are informational in the GUI.)
- `ADVANCED_SETTINGS` in settingsService mirrors them into process.env at boot; type
  validation (number/bool/string) on PUT.

## Duplicate-setting audit (user-reported)
- **Server Port** (`general.port` → `EG_PORT`): verified WIRED — it is the server's own
  *listen* port (`app.listen(env.port)`), which in the Docker deployment is fixed by the
  compose port mapping (`8098:8080`). It is NOT the same as `provider.port` (the LLM port
  in Provider Settings). Since it is effectively compose wiring, it was **removed from the
  GUI** (no reroute target exists; documented).
- **Provider Kind** (`general.embeddings` → `EG_EMBEDDINGS`): verified WIRED — selects the
  embedding backend implementation (`env.emb_kind` → emb_openai/gemini/aws/siray/local).
  This IS the same axis as Provider Type, so it was **rerouted**: `applyProviderDerived()`
  maps `provider.type` → `EG_EMBEDDINGS` (`openai-compatible` → `openai`) at boot and on
  save, and the duplicate GUI field was removed.
- Verified live: general section no longer contains port/embeddings; advanced has 36 keys;
  PUT persists; embedding test still passes (768 dims); stale rows absent.

## Verification
- tsc clean, web build clean, both containers healthy, GUI bundle contains the note.
