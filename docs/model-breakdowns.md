# Corrected LLM Modeling:
| Category | Task | Primary Model | Fallback Model |
| :--- | :--- | :--- | :--- |
| **Generative** | Extraction | `qwen3.5:2b` | `qwen2.5:3b` |
| **Generative** | Compaction | `qwen3.5:2b` | `qwen2.5:3b` |
| **Generative** | Consolidation | `qwen3.5:2b` | `qwen2.5:3b` |
| **Embedding** | Episodic | `qwen3-embedding:0.6b` | `bge-m3` |
| **Embedding** | Semantic | `qwen3-embedding:0.6b` | `bge-m3` |
| **Embedding** | Procedural | `qwen3-embedding:0.6b` | `bge-m3` |
| **Embedding** | Emotional | `qwen3-embedding:0.6b` | `bge-m3` |
| **Embedding** | Reflective | `qwen3-embedding:0.6b` | `bge-m3` |

### Key Takeaways:
- **Generative tasks** (Extraction, Compaction, Consolidation) use qwen3.5:2b
  - You MUST DISABLE THINKING!!!!
    ```json
    const response = await fetch(`${env.ollama_url}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: COMPACTION_MODEL,
          prompt: `${prompt}\n\n/no_think`, // Append the marker here
          stream: false,
          think: false, // Native API parameter to disable thinking
          format: "json", // Force valid JSON output
          options: {
            temperature: 0.1,
            num_predict: 800,
          },
        }),
      });
    ```
- **Embedding tasks** (all 5 memory facets) uniformly use `qwen3-embedding:0.6b` with `bge-m3` as a universal fallback.
- `qwen3.5:2b` MUST be running when Engram is running! It should NEVER go offline!
- the backup models, `qwen2.5:3b` and `bge-m3` should be downloaded, but should NEVER be running normally


# todo - clean up from here below

| Memory Facet | Recommended Model (Ollama) | Why? |
| :--- | :--- | :--- |
| **Semantic** (Facts, concepts, domain knowledge) | `bge-m3` | The gold standard for open-source embeddings. Handles up to 8192 tokens, excels at dense factual retrieval, and supports multi-lingual/multi-granularity search. |
| **Procedural** (Code patterns, workflows, rules) | `nomic-embed-text` | Trained heavily on code and technical documentation. Excellent at matching "how-to" queries with procedural steps. |
| **Episodic** (Events, specific interactions, timeline) | `bge-m3` | Episodic memories can be long and narrative. `bge-m3`'s large context window prevents truncation of detailed event descriptions. |
| **Emotional** (User preferences, tone, sentiment) | `all-MiniLM-L6-v2` | Ultra-lightweight (80MB). Emotional snippets are usually very short. This model is blazing fast on CPU and perfectly adequate for short preference matching. |
| **Reflective** (Meta-cognition, lessons learned) | `bge-m3` | Reflective memories are dense and abstract. `bge-m3` captures high-level semantic relationships better than smaller models. |

### 1. Generative LLMs (Consolidation & Extraction)
* **Purpose:** Reasoning, summarization, and JSON fact extraction.
* **Endpoints:** Ollama's `/api/generate` or `/v1/chat/completions`.
* **Configuration:** Standalone environment variables (`EG_CONSOLIDATION_MODEL`, `EG_EXTRACTION_MODEL`) with hardcoded fallbacks (`qwen2.5:14b` for consolidation, `qwen2.5:3b` for extraction).
* **Why it's correct:** These tasks require generative capabilities, not vector embeddings. Keeping them separate from the embedding config prevents accidental misrouting (e.g., trying to send a consolidation prompt to an embedding-only endpoint).

### 2. Embedding Models (Per-Facet Vectorization)
* **Purpose:** Converting text into dense vectors for similarity search in PostgreSQL/pgvector.
* **Endpoints:** Ollama's `/api/embeddings` or provider-specific embedding APIs.
* **Configuration:** Wired into the `models.ts` resolution chain with per-facet, per-provider overrides and hardcoded defaults as fallbacks.
* **Resolution Order (in `resolveEmbeddingModel()`):**
  1. `EG_<PROVIDER>_<FACET>_MODEL` (e.g., `EG_OLLAMA_EPISODIC_MODEL`) — per-facet override
  2. `EG_<PROVIDER>_MODEL` (e.g., `EG_OLLAMA_MODEL`) — provider-wide override
  3. `EG_EMBED_MODEL` — global fallback across all providers
  4. Hardcoded defaults in `get_defaults()` — per-provider, per-facet
  5. Universal final fallback: `bge-m3`
* **Supported Providers:** ollama, openai, gemini, aws, siray, local
* **Why it's correct:** This cascading fallback is a best-practice design pattern. It gives you granular control (e.g., using `nomic-embed-text` for procedural/code facets) while gracefully falling back to `bge-m3` if no override is set.

### Summary
The generative tasks (extraction/consolidation) are correctly isolated with their own env vars and fallbacks, while the embedding tasks correctly utilize the hierarchical, per-facet resolution chain in `models.ts`.

---

### 1. Embedding Models (Vectorization)
*Goal: Convert text into dense vectors for similarity search. Different models excel at different types of text.*

| Memory Facet | Recommended Model (Ollama) | Why? |
| :--- | :--- | :--- |
| **Semantic** (Facts, concepts, domain knowledge) | `bge-m3` | The gold standard for open-source embeddings. Handles up to 8192 tokens, excels at dense factual retrieval, and supports multi-lingual/multi-granularity search. |
| **Procedural** (Code patterns, workflows, rules) | `nomic-embed-text` | Trained heavily on code and technical documentation. Excellent at matching "how-to" queries with procedural steps. |
| **Episodic** (Events, specific interactions, timeline) | `bge-m3` | Episodic memories can be long and narrative. `bge-m3`'s large context window prevents truncation of detailed event descriptions. |
| **Emotional** (User preferences, tone, sentiment) | `all-MiniLM-L6-v2` | Ultra-lightweight (80MB). Emotional snippets are usually very short. This model is blazing fast on CPU and perfectly adequate for short preference matching. |
| **Reflective** (Meta-cognition, lessons learned) | `bge-m3` | Reflective memories are dense and abstract. `bge-m3` captures high-level semantic relationships better than smaller models. |

> **💡 Pro Tip:** While you *can* route per-facet, running multiple embedding models simultaneously consumes extra RAM. For 95% of use cases, setting **`bge-m3` as the universal default** for all facets is the most robust and resource-efficient choice. Use `nomic-embed-text` only if your workspace is heavily code-focused.

> **💡 Note:** All providers (openai, gemini, aws, siray) have their own cloud-native model defaults in `get_defaults()`. The per-facet overrides above apply specifically to the Ollama provider. For local/offline fallbacks across all facets, `bge-m3` is used.

---

### 2. Extraction & Consolidation Models (Generation)
*Goal: Read the conversation transcript, decide what is worth saving, format it as strict JSON, and periodically merge/decay old memories.*

| Task | Recommended Model | Why? |
| :--- | :--- | :--- |
| **Extraction** (Parsing transcripts into JSON) | `qwen2.5:3b` | The absolute sweet spot for CPU extraction. It has phenomenal instruction-following capabilities, reliably outputs strict JSON, and runs in 1–3 seconds on a 28-core Xeon. |
| **Consolidation** (Merging duplicates, resolving conflicts, decaying) | `qwen2.5:14b` | Consolidation requires higher-order reasoning (e.g., *"Do these two procedural memories contradict each other, or are they just different steps of the same process?"*). The 14B model has the reasoning depth to make these judgments safely. Supports structured JSON output for merge/update/promote/delete actions via Ollama's `format` parameter. |

---
### 3. Implementation Note for `models.ts`

The `resolveEmbeddingModel(facet, provider)` function in `models.ts` implements the full cascading resolution chain:

```typescript
function resolveEmbeddingModel(facet: string, provider: string): string {
  // 1. Per-facet, per-provider override (e.g., EG_OLLAMA_EPISODIC_MODEL)
  const facetOverride = process.env[`EG_${provider.toUpperCase()}_${facet.toUpperCase()}_MODEL`];
  if (facetOverride) return facetOverride;

  // 2. Provider-wide override (e.g., EG_OLLAMA_MODEL)
  const providerOverride = process.env[`EG_${provider.toUpperCase()}_MODEL`];
  if (providerOverride) return providerOverride;

  // 3. Global fallback across all providers
  if (process.env.EG_EMBED_MODEL) return process.env.EG_EMBED_MODEL;

  // 4. Hardcoded defaults from get_defaults() — per-facet, per-provider
  const cfg = load_models();
  return cfg[facet]?.[provider] || cfg.semantic?.[provider] || "bge-m3";
}
```

**Hardcoded defaults in `get_defaults()` (Ollama provider):**

| Facet | Ollama Default | Cloud Provider Defaults |
|---|---|---|
| episodic | `bge-m3` | openai: `text-embedding-3-small`, gemini: `models/gemini-embedding-001`, aws: `amazon.titan-embed-text-v2:0` |
| semantic | `bge-m3` | same as above |
| procedural | `nomic-embed-text` | same as above |
| emotional | `all-MiniLM-L6-v2` | same as above |
| reflective | `bge-m3` | same as above |

**All providers' local fallback:** `bge-m3` (universal, across all facets).

---

### 5. Docker Auto-Pull Models

The following models are automatically pulled when the Engram container starts (in `docker-compose.yml` entrypoint):

| Model | Purpose |
|---|---|
| `qwen2.5:3b` | Extraction model |
| `qwen2.5:14b` | Consolidation model |
| `bge-m3` | Primary embedding model (universal default) |
| `nomic-embed-text` | Procedural facet override |
| `all-MiniLM-L6-v2` | Emotional facet override |
