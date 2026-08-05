# Model Configuration Audit — 2026-08-05

Exhaustive sweep of every model reference in the FTR10-Engram codebase
(`packages/engram-js`, `apps/web`, `apps/vscode-extension`, `scripts/`, configs, docs).
Trigger: recurring consolidation failures caused by a model-config tangle
(consolidation ran on `LFM2.5-1.2B-Instruct` while `docker-compose.yml` set a dead
`EG_GENERATIVE_MODEL=Gemma-4-12B-no-thinking` that is read nowhere).

---

## Table 1 — ALL model-related configuration variables

| # | Variable | Default in code | Read at | Purpose | Deployed value |
|---|----------|-----------------|---------|---------|----------------|
| 1 | `EG_MODEL_GENERATIVE` | `qwen3.5:2b` | `configuration/index.ts:23` → `env.generative_model` | Generative LLM for **extraction, compaction, consolidation, autoSearch** | `LFM2.5-1.2B-Instruct` (.env) |
| 2 | `EG_MODEL_GENERATIVE_FALLBACK` | `qwen2.5:3b` | `index.ts:24` → `env.fallback_model` | **Dead** — only read by unused `SYNTHESIS_MODEL` const | `qwen2.5:3b` (.env) — **not served by llama-swap** |
| 3 | `EG_MODEL_EMBEDDING` | `qwen3-embedding:0.6b` | `index.ts:25` → `env.embed_model_primary` | Universal embedding default | `nomic-embed-text-v1.5` (.env) |
| 4 | `EG_MODEL_EMBEDDING_FALLBACK` | `bge-m3` | `index.ts:30,89` → `env.embedding_fallback` | Provider-chain fallback | unset → `bge-m3`, **filtered out of providerChain** (not in `knownProviders`) |
| 5 | `EG_MODEL_EMBED_{EPISODIC,SEMANTIC,PROCEDURAL,EMOTIONAL,REFLECTIVE}` | per-facet default = `EG_MODEL_EMBEDDING` | `index.ts:26-29` getters `embed_model_*` | Per-facet embedding override | all unset |
| 6 | `EG_OPENAI_MODEL` | — | `index.ts:95` → `env.openai_model`; **dual use**: `embed.ts:133` (embedding model) **and** `route.ts:376,391` (chat-proxy fallback) | Embedding model + chat fallback | `Nomic-Embed-Text-v1.5` (compose) |
| 7 | `EG_EMBED_MODEL` | — | `models.ts:82` direct `process.env` read | Global embedding override — **beats the whole cascade** | `nomic-embed-text-v1.5` (.env) — **undocumented** (not in .env.example) |
| 8 | `EG_<PROVIDER>_MODEL` (dynamic) | — | `models.ts:40-44` | Provider-wide embedding override | unset |
| 9 | `EG_<PROVIDER>_<FACET>_MODEL` (dynamic, 25 combos) | — | `models.ts:34-38` | Per-facet per-provider embedding override | unset |
| 10 | `EG_CHAT_MODEL` | — | `route.ts:376,391` direct `process.env` read | Chat-proxy model fallback | unset — **undocumented** |
| 11 | `EG_CONSOLIDATION_MODEL` | — | `consolidationEngine.ts:14` (added today) | Consolidation LLM override | unset → falls back to `env.generative_model` |
| 12 | `EG_CONSOLIDATION_BATCH_MEMORIES` | 150 | `consolidationEngine.ts:27` (added today) | Max memories per LLM call | unset → 150 |
| 13 | `EG_GENERATIVE_MODEL` | — | **read NOWHERE — dead var** | Was meant to steer generative tasks | `Gemma-4-12B-no-thinking` (compose) — **the trap that started this** |
| 14 | `EG_GENERATIVE_URL` | `""` | `index.ts:102` → `env.generative_url` | Generative base URL | `http://10.10.10.41:8080/v1` (compose) |
| 15 | `EG_UPSTREAM_LLM_URL` | `""` | `index.ts:122` → `env.llm_url` | Chat-proxy upstream | `http://10.10.10.41:8080/v1` (compose) |
| 16 | `EG_OPENAI_BASE_URL` | `https://api.openai.com/v1` | `index.ts:94` → `env.openai_base_url` | OpenAI-compat endpoint (embeddings + proxy) | `http://10.10.10.41:8080/v1` (compose) |
| 17 | `EG_EMBEDDINGS` | `openai` | `index.ts:88` → `env.emb_kind` | Embedding provider kind | `openai` (.env) |
| 18 | `EG_VEC_DIM` | **1536** | `index.ts:124` → `env.vec_dim` | Embedding dimensions sent to API | `768` (.env — matches `halfvec(768)`) |
| 19 | `EG_EMBED_TIMEOUT_MS` | — | `embed.ts:23` direct `process.env` read | Embedding timeout | `30000` (.env) — **undocumented** |
| 20 | `EG_LOCAL_MODEL_PATH` | `""` | `index.ts:123` → `env.local_model_path`; `embed.ts:291,491` | Local embedding path (dormant) | unset |
| 21 | `EG_OPENAI_API_KEY` / `EG_GEMINI_API_KEY` / `EG_AWS_*` / `EG_SIRAY_API_KEY` | — | `index.ts:93-100` | Provider auth | openai key set, others empty |
| 22 | `EG_CONSOLIDATION_RECENT_*` / `DEEP_*` (6 vars) | 4h·7d·2 / 24h·30d·3 | `consolidationEngine.ts:22-27` | Tier scheduling (intervals, windows, min-groups) | all unset |

**Also:** `EG_GENERATIVE_URL`/`EG_UPSTREAM_LLM_URL`/`EG_OPENAI_BASE_URL`/`EG_OPENAI_API_KEY` are
compose-substituted from `REMOTE_LLM_URL`/`REMOTE_LLM_API_KEY`, which live **only in the
creating shell** (not in `.env`) — a bare `docker compose up` silently renders them as `/v1` + empty key.

---

## Table 2 — ALL hardcoded model references in code/config

| # | Location | Hardcoded value | Impact |
|---|----------|-----------------|--------|
| 1 | `configuration/index.ts:23` | `"qwen3.5:2b"` | Generative default — **not served by llama-swap**; masks misconfiguration with silent wrong-model |
| 2 | `configuration/index.ts:24` | `"qwen2.5:3b"` | Fallback default — **not served by llama-swap** (404 if ever used) |
| 3 | `configuration/index.ts:25` | `"qwen3-embedding:0.6b"` | Embedding default — **not served by llama-swap** |
| 4 | `configuration/index.ts:30,89` | `"bge-m3"` | Embedding fallback — not served; also dropped from `providerChain()` |
| 5 | `database/models.ts:16-19` | `text-embedding-3-small`, `models/gemini-embedding-001`, `amazon.titan-embed-text-v2:0`, `text-embedding-3-small` | Cloud provider defaults (dormant here) — header comment claims "no hardcoded models" |
| 6 | `embeddings/facets.ts:15,28,41,54,68` | `"episodic-optimized"` … `"reflective-optimized"` | **Dead fields** — `facetConfigs[*].model` is never read |
| 7 | `api/routes/chat/completions/route.ts:113` | `'engram-proxy'` | SSE chunk `model` label default |
| 8 | `route.ts:376,391` | `body.model → EG_CHAT_MODEL → env.openai_model` | If a client omits `model`, **Nomic (an embedding model) is sent to chat completions** |
| 9 | `embeddings/embed.ts:190` | `get_model(s, "gemini")` | Per-facet Gemini models (dormant provider) |
| 10 | `apps/vscode-extension/src/extension.ts:675` | `'proxy'` | Chat model name the extension sends |
| 11 | `tests/sseValidation.test.ts:21,47` | `'qwen3.5:2b'` | Test fixture |
| 12 | `scripts/backfill_embeddings.py:41` | `EMBED_MODEL = "Nomic-Embed-Text-v1.5"` | Backfill script (matches deployment) |
| 13 | `docker-compose.yml:56` | `EG_GENERATIVE_MODEL: "Gemma-4-12B-no-thinking"` | **Dead var — read nowhere**; the exact trap behind today's failure |
| 14 | `docker-compose.yml:54` | `EG_OPENAI_MODEL: "Nomic-Embed-Text-v1.5"` | Embedding + chat fallback |
| 15 | `.env.example:41-48` | `LFM2.5-1.2B-Instruct`, `qwen2.5:3b`, `qwen3-embedding:0.6b`, `bge-m3` | Documents defaults that **disagree with code defaults** (`qwen3.5:2b`) |
| 16 | `docs/model-breakdowns.md` | `qwen3.5:2b`, `qwen2.5:3b`, `qwen2.5:14b`, `bge-m3`, `nomic-embed-text`, `all-MiniLM-L6-v2`; references **nonexistent** `EG_EXTRACTION_MODEL`, `get_defaults()`, docker auto-pull | Stale/aspirational, self-contradictory (even contains "todo - clean up") |
| 17 | `docs/architecture.excalidraw`, `docs/assets/architecture.svg` | `qwen3.5:2b · qwen3-embedding:0.6b` | Stale diagrams |
| 18 | `AGENTS.md` model table | `LFM2.5-1.2B-Instruct` default | Matches actual deployment; readme.md two-tier table now matches code |

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
