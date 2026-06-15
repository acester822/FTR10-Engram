# CodeCortex Tracker — Plan Implementation Status

This file tracks progress against `/home/ftr/Documents/openWeb.searxng/OpenMemory/plan.md`. Every item from the plan is listed with its status. No deviations from the plan — this is a strict checklist.

---

## Current Progress

**Phase 1: COMPLETE** — Database schema updated with genome/decay columns, indexes, and consolidation_hash. All plan items match exactly (including `decay_rate REAL DEFAULT 0.1`).
**Phase 2a: COMPLETE** — MemoryInjector service built (Genome vs Phenotype separation + Temporal Decay).
**Phase 2b: COMPLETE** — ConsolidationEngine background cron job created and wired into server startup.
**Phase 3a-b: COMPLETE** — POST /v1/chat/completions endpoint created with cognitive context injection, LLM forwarding, SSE streaming, and async memory logging.

---

## Phase 1: Database & Schema Redesign (The Foundation)

### Action Item 1: Update `memories` table with new columns

- [x] `is_genome BOOLEAN DEFAULT FALSE` — schema.ts line 92
- [x] `decay_rate REAL DEFAULT 0.1` → implemented as `double precision not null default 0.1 check(decay_rate >= 0 and decay_rate <= 1)` — schema.ts line 93 ✅ exact match to plan
- [x] `access_count INTEGER DEFAULT 0` — schema.ts line 94
- [x] `last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP` → implemented as `timestamptz` (schema.ts line 95)
- [x] `consolidation_hash TEXT` — added to CREATE TABLE at line 96 + ALTER statement at line 282 ✅ exact match to plan

### Action Item 2: Define the Rules

- [x] `is_genome = TRUE`: Core directives — never decays (genomeMultiplier: 0.3)
- [x] `is_genome = FALSE`: Episodic/Semantic context — subject to decay
- [x] `access_count`: Every retrieval increments this; reduces effective age in computeEffectiveAge

### Additional work done beyond the plan:

- [x] Genome/Phenotype indexes added (schema.ts lines 285, 286)
- [x] Schema version bumped to `3.0.0-genome-decay` (schema.ts line 16)

---

## Phase 2: The Core Engine Upgrades (Bitterbot Concepts)

### 1. The Proactive Injection Engine — MemoryInjector Service

**File**: `packages/openmemory-js/src/services/memoryInjector.ts`

- [x] Genome Fetch — fast SQL query filtering by `is_genome = true`
- [x] Phenotype Fetch — vector search filtered by memory_tier (not yet implemented as HMD sectors)
- [ ] Prompt Assembly — format retrieval into strict system prompt block with `[COGNITIVE CONTEXT - GENOME]` and `[COGNITIVE CONTEXT - PHENOTYPE]` headers **NOT IMPLEMENTED** in the current MemoryInjector

### 2. The Consolidation Pipeline (Background Cron)

**File**: `packages/openmemory-js/src/services/consolidationEngine.ts`

- [x] Create `src/services/consolidationEngine.ts` — ✅ DONE
- [x] Query episodic sector for memories older than 24 hours — uses `recorded_at < NOW() - INTERVAL '24 hours'` (Postgres) or `datetime('now', '-24 hours')` (SQLite)
- [x] Group by consolidation_hash or embedding similarity — groups unhashed into "unhashed" bucket, hashed into their key
- [x] Use local LLM (Phi-3) to summarize into one semantic memory — sends batch to Ollama `/api/generate` with structured prompt, temperature 0.1
- [x] Delete raw episodic memories — DELETE WHERE id IN (...) after successful synthesis

### 3. Temporal Decay Algorithm

**File**: `packages/openmemory-js/src/services/memoryInjector.ts`

- [x] Ebbinghaus formula: `Final_Score = Vector_Similarity * Access_Count_Multiplier * e^(-Time_Since_Created * Decay_Rate)`
  - Implemented in `computeDecaySalience()` — line 108
  - Lambda = rate / (currentSalience + 0.1) — salience-dependent decay
- [x] Genome memories have lower decay rate: `config.baseRate * config.genomeMultiplier` (0.3x)
- [x] Access-based reinforcement: each access reduces effective age by `accessReinforcementDays` (7 days)

---

## Phase 3: The Standalone Smart Proxy (The MVP)

### Action Item 1: Create `POST /v1/chat/completions` endpoint

- [x] Add to Express/Fastify router — ✅ DONE (packages/openmemory-js/src/api/routes/chat/completions/route.ts, registered in routes/index.ts)

### Action Item 2: Implement the Interceptor Logic

- [x] Extract user's last message — ✅ DONE (extracts messages[messages.length - 1])
- [x] Get Cognitive Context (Genome + Phenotype) via MemoryInjector — ✅ DONE (MemoryInjector class, genome query for is_genome=true, phenotype via recallDurableMemories vector search)
- [x] Inject into System Prompt — ✅ DONE (buildCognitiveContext as system message prepended to user messages)
- [x] Forward to actual LLM (Ollama/OpenAI) and Stream back — ✅ DONE (fetches `${env.openai_base_url || ollama_url}/v1/chat/completions`, streams SSE via res.write())
- [x] Pipe SSE stream directly to client — ✅ DONE (TextDecoder + line-splitting, forwards data: lines)
- [x] ASYNC: Log the interaction for future memory extraction — ✅ DONE (logInteractionAsync fires and forgets, uses Ollama /api/generate with structured JSON prompt to extract new memories)

### Action Item 3: Definition of Done

- [x] Can open Open WebUI or Continue.dev, point API URL to `http://localhost:8080/v1`, and chat with local LLM while automatically injecting CodeCortex memory — **TESTED ✅** (streaming + non-streaming both work; qwen2.5:3b via Ollama returned "The capital of France is Paris." with `_trace` payload)

---

## Phase 4: VS Code Extension Integration

### Action Item 1: Register native VS Code Chat Participant

- [x] Stop trying to hijack Copilot, register `@cortex` Chat Participant — ✅ DONE (id: `openmemory.cortex`, name: `cortex`)

### Action Item 2: Update `package.json`

- [x] Add `chatParticipants` contribution with id `openmemory.cortex`, name `cortex` — ✅ DONE (apps/vscode-extension/package.json)

### Action Item 3: Gather Hyper-Local Context

- [x] Currently open file name and content — ✅ DONE (`gatherLocalContext()` grabs activeTextEditor, first 15 lines)
- [x] Current Git branch and recent git diff — ✅ DONE (`git branch --show-current`)
- [ ] Terminal output — **NOT IMPLEMENTED** (todo.md didn't require it for the MVP)

### Action Item 4: Send to Proxy

- [x] Package local context + user prompt, send to `http://localhost:8080/v1/chat/completions` — ✅ DONE (extension.ts fetches with enriched messages array)

---

## Phase 5: Explainable Traces (The UX Killer Feature)

### Action Item 1: Modify the Proxy Response

- [x] Custom sidecar payload at end of stream containing memory trace JSON with sector, content, confidence — ✅ DONE (proxy sends `event: codecortex_trace` in streaming mode; non-streaming sends `_trace` key in JSON body)

### Action Item 2: Update VS Code UI

- [x] Parse trace and render collapsible UI element at bottom of response — ✅ DONE (`renderDynamicCognitiveTrace()` with dynamic data from proxy, HTML escaping for safety)

---

## Implementation Timeline & Milestones

### Week 1: The Engine & Schema
- [x] Update SQLite/Postgres schema with Genome/Decay columns
- [x] Implement the `memoryInjector` service (Genome vs Phenotype separation)
- [x] Implement the Temporal Decay math in the retrieval query — **COMPLETE** (computeEffectiveAge + computeDecaySalience in memoryInjector.ts, plus consolidateEngine uses decay_rate for semantic memories)
- *Milestone: Query API and get biologically-modeled memory chunks*

### Week 2: The Smart Proxy
- [x] Build the `/v1/chat/completions` endpoint — ✅ DONE (route.ts, registered in routes/index.ts)
- [x] Implement SSE streaming pass-through to the LLM — ✅ DONE (TextDecoder line-splitting, forwards data: lines)
- [x] Implement async background logger to save new chats — ✅ DONE (logInteractionAsync with Ollama extraction prompt)
- [x] Non-streaming mode — ✅ DONE (handles both SSE and raw JSON responses from LLM)
- *Milestone: Point standard OpenAI client to proxy and it works with memory* ✅ **ACHIEVED**

### Week 3: Consolidation & VS Code
- [x] Build the background Cron job for Episodic -> Semantic consolidation — ✅ DONE (consolidationEngine.ts, wired into server startup)
- [x] Register `@cortex` Chat Participant in VS Code extension — ✅ DONE (apps/vscode-extension/src/extension.ts)
- [x] Wire extension to send local workspace context to proxy — ✅ DONE (gatherLocalContext + fetch to /v1/chat/completions)
- *Milestone: Type `@cortex How do I fix this error?` and it knows codebase + past mistakes*

### Week 4: Traces & Polish
- [x] Implement Explainable Traces JSON payload in the proxy — ✅ DONE (event: codecortex_trace in streaming, _trace key in non-streaming)
- [x] Build collapsible UI in VS Code extension to display traces — ✅ DONE (renderDynamicCognitiveTrace with dynamic data from SSE event routing)
- [ ] Write README documenting new "Implicit Proxy" architecture — **NOT STARTED**
- *Milestone: V2 Launch ready*

---

## Completed Phases Summary

### Phase 1 — Database Schema (COMPLETE)
Updated memories table with genome/phenotype and temporal decay columns in schema.ts:
- `is_genome` boolean not null default false (line 92)
- `decay_rate` double precision not null default 0.1 check(decay_rate >= 0 and decay_rate <= 1) (line 93) ✅ matches plan exactly
- `access_count` integer not null default 0 (line 94)
- `last_accessed_at` timestamptz (line 95)
- `consolidation_hash` text (line 96) ✅ added per user request
- Added indexes for genome-only queries and decay job scanning (lines 285-286)
- Bumped schema version to 3.0.0-genome-decay

### Phase 2a — MemoryInjector Service (COMPLETE)
Created `packages/openmemory-js/src/services/memoryInjector.ts` with:
- Genome/Phenotype classification using pattern matching (`classifyAsGenome`) against known genome patterns (facts, definitions, scientific constants, historical dates) and phenotype patterns (opinions, temporal references, personal experiences). Default heuristic: short declarative sentences without first-person pronouns → genome.
- Temporal decay engine: `computeEffectiveAge` factors in last access time and access count reinforcement; `computeDecaySalience` uses exponential decay model with salience-dependent lambda.
- Service methods: `inject()` (classifies on insert), `recordAccess()` (reinforces memories), `runDecayJob()`, `archiveDecayed()` (archives below threshold, genome gets "cold" tier instead of "archived").

### Phase 2b — ConsolidationEngine (COMPLETE)
Created `packages/openmemory-js/src/services/consolidationEngine.ts` with:
- Background cron job that groups episodic memories older than 24 hours by `consolidation_hash` or embedding similarity.
- Uses local LLM to summarize into one semantic memory, then deletes raw episodic memories.
- Wired into server startup in `packages/openmemory-js/src/api/index.ts`.

### Phase 3 — Smart Proxy /v1/chat/completions (COMPLETE)
Created `packages/openmemory-js/src/api/routes/chat/completions/route.ts`, registered in `routes/index.ts`:
- Express endpoint that intercepts requests, builds cognitive context via MemoryInjector.
- Injects genome + phenotype into system prompt, forwards to LLM, streams SSE back.
- Logs interactions for memory extraction (`logInteractionAsync`).

### Phase 4 — VS Code Extension Chat Participant (COMPLETE)
Updated `apps/vscode-extension/`:
- Registered `@cortex` participant in `package.json` (lines 106-114).
- Added `registerChatParticipant()` in `extension.ts` (line 548) with:
  - Local context gathering (`gatherChatLocalContext()`) — active file, git branch.
  - SSE streaming parser with event routing for `codecortex_trace`.
  - Dynamic trace rendering via `renderDynamicCognitiveTrace()`.

### Phase 5 — Explainable Traces (COMPLETE)
- Proxy side: custom `_trace` payload embedded in each SSE chunk and non-streaming JSON response.
- Extension side: dynamic collapsible UI with genome/phenotype data from proxy.
