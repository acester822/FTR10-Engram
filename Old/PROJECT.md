# Engram / Engram — Project Tracker

> Vision and implementation roadmap derived from the Vision.md conversation.
> Tracks the product-level plan (smart proxy, standalone app, consolidation, traces).

---

## Vision Summary

**Engram** is a cognitive memory engine for LLMs and agents:
- Real long-term memory (not just embeddings in a table)
- Self-hosted, local-first (SQLite / Postgres)
- Python + Node SDKs
- Integrations: LangChain, CrewAI, AutoGen, Streamlit, MCP, VS Code
- Standalone app that sits between user tools and LLM
- Sources: GitHub, Notion, Google Drive, OneDrive, Web Crawler
- Explainable traces (see why something was recalled)

### The Core Problem
MCP-based memory is unreliable — LLMs forget to call the tool, call it with wrong parameters, or hallucinate the output. The solution is to remove the burden of memory management from the LLM entirely.

### The Solution: Implicit Memory
Instead of asking the LLM to *remember* to fetch memory, inject it **implicitly** before the LLM ever sees the prompt.

---

## Architecture

```
[User]
  ↓ (Types prompt in their tool)
[Standalone App] (The Layer)
  ↓ (Sends POST to http://localhost:8080/v1/chat/completions)
[CODECORTEX SMART PROXY] (The Brain)
  ├─ 1. INTERCEPT: Grabs user prompt & active workspace context.
  ├─ 2. RETRIEVE:
  │     ├─ Fetches "Genome" (Immutable facts, zero latency).
  │     └─ Queries "Phenotype" (Vector search across 5 HMD sectors).
  ├─ 3. INJECT: Rewrites the System Prompt with cognitive context.
  ├─ 4. FORWARD: Streams request to actual LLM (Ollama/OpenAI).
  ├─ 5. STREAM: Passes SSE tokens back to user's tool instantly.
  └─ 6. LOG (Async): Fires background job to store the new interaction.
```

### Memory Model: Genome vs. Phenotype
- **Genome** — Immutable facts (e.g., "User prefers Python", "Project uses React"). Never decays. Always injected.
- **Phenotype** — Contextual memories subject to temporal decay and vector search.
  - Episodic, Semantic, Procedural, Emotional, Reflective sectors
  - Ebbinghaus forgetting curve for decay
  - Access count boosts resistance to decay

### Memory Model: Bitterbot-Inspired Concepts
- **Consolidation Pipeline** — Background worker merges episodic memories into semantic summaries
- **Pre-Action Interceptors** — Deterministic code fires before the LLM processes a prompt
- **Genome vs. Phenotype** — Immutable vs. evolving memory (already in ATODO.md)

---

## Phases

### Phase 1 — Engine & Schema Foundation
Detailed tasks: [TODOP1.md](TODOP1.md)
- Database schema changes (Genome/Decay columns, indexes)
- `memoryInjector.ts` service (genome fetch, phenotype fetch, temporal decay)
- Tests and documentation

### Phase 2 — Standalone Smart Proxy (MVP)
Detailed tasks: [TODOP2.md](TODOP2.md)
- `POST /v1/chat/completions` endpoint
- Cognitive context injection
- SSE streaming passthrough
- Async memory logging

### Phase 3 — Consolidation & Standalone App
Detailed tasks: [TODOP3.md](TODOP3.md)
- Consolidation pipeline (episodic → semantic)
- Standalone app architecture and request interception
- Workspace context collection
- App UI for monitoring memory and context

### Phase 4 — Traces & Polish
Detailed tasks: [TODOP4.md](TODOP4.md)
- Explainable traces (trace payload, storage, API)
- Trace visualization in standalone app
- Performance optimization
- Security hardening
- Documentation

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Memory trigger | **Implicit** (proxy intercepts) | Not explicit (LLM calls tool) |
| Primary use case | Standalone app for developer workflows | Not autonomous agents |
| Memory model | 5-sector HMD + Genome/Phenotype | More structured than flat vector DB |
| Integration approach | Standalone app (proxy layer) | Sits between user tool and LLM; transparent to both |
| Comparison | "Letta asks the LLM to manage its memory. Engram manages the memory *for* the LLM." | Key differentiator |

## Open Questions

1. **Which local LLM for consolidation?**
   - Cannot run 14 different models on local servers
   - Multiple agents will run in parallel
   - Need lighter models or free online models for certain tasks to conserve memory/CPU
   - Requires deeper research and focused evaluation

## Related Documents

- [Vision.md](Vision.md) — Full conversation transcript
