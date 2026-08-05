# Model Selection Guide (current)

> **Status:** this document reflects the CURRENT architecture (Aug 2026). For the complete
> variable/hardcoded-model audit and the Settings-tab design history, see
> [`model-config-audit.md`](./model-config-audit.md).

## How models are configured

All providers and models are set in the **web GUI Settings tab** (persisted in Postgres
`app_settings`, schema `4.1.0-settings`). Resolution happens in
`packages/engram-js/src/database/modelRegistry.ts` with a single chain:

1. **Settings** (GUI) — per-task / per-facet / master values
2. **Env override** (legacy, low priority): `EG_MODEL_GENERATIVE`, `EG_MODEL_EMBEDDING`,
   `EG_MODEL_EMBED_<FACET>`, `EG_CONSOLIDATION_MODEL`
3. **Fail** with a clear error — there are **no hardcoded model-name defaults** anywhere.

The provider URL (`http://host:port/v1`) is built from the Settings → Provider section
(type *OpenAI Compatible*, host IP, port); a per-section provider override is supported for
Generative vs Embedding. `EG_EMBEDDINGS` (embedding provider kind) is derived from the
provider type.

## Generative models (extraction / compaction / consolidation / auto-search)

| Task | Why it matters | Guidance |
|------|----------------|----------|
| **Extraction** (transcript → JSON facts) | Runs after every turn; must follow a strict JSON schema, assign sectors, and respect a long DO-NOT-EXTRACT list | A small instruct model with good JSON discipline is fine and fast; per-turn cost dominates |
| **Compaction** (long-context summarization) | Summarizes + extracts durable facts in one LLM call; prompt can be large | Needs enough context to read the conversation; same model family as extraction works |
| **Consolidation** (merge/promote/delete decisions) | Judgement-heavy: "do these two memories contradict, or are they different steps?"; output must be valid JSON actions | Benefits from the STRONGEST model you can afford — weak models produce prose instead of JSON or split merges instead of joining |

A master **Generative Model** is required (it populates all tasks unless a per-task override
is set). The live deployment uses `LFM2.5-1.2B-Instruct`. Consolidation requests are chunked
to ≤150 memories per call (`EG_CONSOLIDATION_BATCH_MEMORIES`) and use
`response_format: json_object` with tolerant parsing, so even a small model stays in JSON mode.

## Embedding models (per-facet)

A master **Embedding Model** is required; per-facet overrides let you route memory types to
different models. The dimension must match the `halfvec` column (`EG_VEC_DIM`, 768 in the
deployment) — a mismatch silently breaks recall ranking.

| Facet | Purpose | Guidance |
|-------|---------|----------|
| `semantic` | Facts & domain knowledge | General-purpose dense retriever |
| `procedural` | Code patterns, workflows | Code-aware models help (deployment: `CodeRankEmbed`) |
| `episodic` | Events & specific interactions | Long-context model if episodes are verbose |
| `emotional` | Preferences, tone | Lightweight model is adequate (short snippets) |
| `reflective` | Lessons learned, meta-cognition | Dense abstract relationships |

For 95% of use cases a single master embedding model is the resource-efficient choice —
per-facet routing is an optimization, not a requirement. The live deployment uses
`nomic-embed-text-v1.5` for everything except the procedural facet.

**Keep the embedding model resident** in llama-swap's `persistent` group. If it gets evicted,
writes fall back to synthetic hashing embeddings (`embedding_synthetic = true`) and recall
degrades to flat ~0.34 scores.

## Provider

One OpenAI-compatible endpoint serves all roles (the live deployment is a single llama-swap
box at `10.10.10.41:8080`). Supported embedding provider kinds: `openai`, `gemini`, `aws`,
`siray`, `local` (dormant cloud paths retain dynamic resolution but have no defaults).

## Removed legacy concepts

- Hardcoded defaults `qwen3.5:2b` / `qwen2.5:3b` / `qwen3-embedding:0.6b` / `bge-m3` — removed.
- `EG_EXTRACTION_MODEL` / `EG_OPENAI_MODEL` / `EG_GENERATIVE_MODEL` / `EG_EMBED_MODEL` /
  `EG_CHAT_MODEL` / `EG_LOCAL_MODEL_PATH` / fallback vars — removed; do not reintroduce them.
- "Docker auto-pull of models" — the compose stack never pulled models; they live on the LLM box.
