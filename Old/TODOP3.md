# Phase 3: Consolidation & Standalone App

> Goal: Background consolidation worker and standalone app that sits between user tool and LLM.
> Prerequisite: Phase 2 complete (proxy working).

---

## 1. Consolidation Pipeline

### 1.1 Consolidation worker design
- [ ] Design the consolidation worker contract
  - Input: episodic memories older than 24 hours
  - Output: consolidated semantic memories
  - Trigger: cron job every 30 minutes (or explicit admin trigger)
- [ ] Define consolidation states: `pending`, `running`, `completed`, `failed`, `canceled`
- [ ] Define consolidation result records and links to source memories

### 1.2 Episodic memory grouping
- [ ] Query episodic sector for memories older than 24 hours
- [ ] Group memories by topic using:
  - Option A: `consolidation_hash` (deterministic, requires hashing logic)
  - Option B: Embedding similarity (requires embedding each memory)
  - Option C: Keyword/topic extraction (lighter weight)
- [ ] Group by `user_id` and `project_id` for isolation

**Acceptance criteria:**
- Grouping correctly identifies related memories
- Grouping handles edge cases (single memories, no related memories)

### 1.3 Semantic summarization
- [ ] For each group of 3+ episodic memories:
  1. Use a tiny local LLM (or free online model) to summarize
  2. Extract the key fact/insight from the group
  3. Create a new semantic memory with the summary
  4. Link the new semantic memory to the source episodic memories
- [ ] Handle the case where a group has fewer than 3 memories (skip or merge differently)

**Notes on LLM choice for consolidation:**
- Cannot run 14 different models on local servers
- Multiple agents will run in parallel
- Options to evaluate:
  - Tiny local models: Phi-3-mini (3.8B), Gemma-2-2B, Qwen2.5-1.5B
  - Free online models: OpenRouter free tier, Together.ai free tier
  - Rule-based summarization: extract key entities and relationships without LLM
- Recommendation: Start with rule-based summarization, evaluate LLM quality later

### 1.4 Source memory cleanup
- [ ] After successful consolidation:
  - Mark source episodic memories as `consolidated`
  - Optionally delete them (or keep for audit trail)
  - Update the semantic memory with references to source memories
- [ ] Handle consolidation failures gracefully
  - Don't delete source memories if consolidation fails
  - Log the failure and retry later

### 1.5 Consolidation API
- [ ] `POST /consolidations` — trigger consolidation
  - Accepts optional `sector` filter (default: episodic)
  - Returns consolidation job ID
- [ ] `GET /consolidations/:id` — check consolidation status
  - Returns job status, result count, errors
- [ ] `GET /consolidations` — list recent consolidations
  - Paginated, filterable by status

**Acceptance criteria:**
- Consolidation runs every 30 minutes via cron
- Consolidation can be triggered manually via API
- Consolidation results are queryable
- Failed consolidations don't corrupt source data

---

## 2. Standalone App

### 2.1 App architecture
- [ ] Design the standalone app architecture
  - The app sits between the user's tool (IDE, terminal, etc.) and the LLM
  - It intercepts all requests and injects memory transparently
  - It provides a UI for monitoring memory and context
- [ ] Choose the app framework:
  - Option A: Electron app (desktop, native integration)
  - Option B: Web app (browser-based, cross-platform)
  - Option C: CLI tool (terminal-based, lightweight)
  - Option D: Hybrid (Electron + webview)
- [ ] Design the app's communication with the proxy

### 2.2 Request interception
- [ ] Implement the request interceptor in the app
  - Intercepts requests from the user's tool
  - Forwards to the proxy (`http://localhost:8080/v1/chat/completions`)
  - Receives the response and passes it back to the user's tool
- [ ] Handle the case where the proxy is not running
  - Fall back to direct LLM access
  - Show a warning to the user

### 2.3 Workspace context collection
- [ ] Collect active workspace context to send to the proxy:
  - Currently open file name and content
  - Current Git branch
  - Recent `git diff`
  - Terminal output (optional)
- [ ] Package the context into the request to the proxy
- [ ] Send context on each request (not cached, always fresh)

**Acceptance criteria:**
- App correctly intercepts and forwards requests
- Workspace context is collected and sent
- Fallback to direct LLM works when proxy is down

### 2.4 App UI
- [ ] Design the app UI for monitoring memory and context
  - Memory overview (total memories, recent activity)
  - Context injection visualization (what was injected for each request)
  - Memory search and management
  - Settings (proxy URL, LLM settings, etc.)
- [ ] Implement the UI (framework TBD)
- [ ] Wire the UI to the proxy API

**Acceptance criteria:**
- UI shows current memory state
- UI shows what was injected for recent requests
- UI allows searching and managing memories
- UI allows configuring proxy and LLM settings

---

## 3. Tests

### 3.1 Consolidation tests
- [ ] Test episodic memory grouping
- [ ] Test semantic summarization
- [ ] Test source memory cleanup
- [ ] Test consolidation failure handling
- [ ] Test cron trigger
- [ ] Test manual trigger via API

### 3.2 Standalone app tests
- [ ] Test request interception
- [ ] Test workspace context collection
- [ ] Test fallback to direct LLM
- [ ] Test UI rendering
- [ ] Test UI interactions

### 3.3 Integration tests
- [ ] Test full flow: user tool → app → proxy → LLM → response
- [ ] Test memory injection in the full flow
- [ ] Test consolidation runs and improves recall

---

## 4. Documentation

- [ ] Document the consolidation pipeline
- [ ] Document the standalone app architecture
- [ ] Document how to set up the standalone app
- [ ] Document the app's communication with the proxy

---

## 5. Definition of Done

- [ ] Consolidation worker runs every 30 minutes
- [ ] Consolidation merges episodic memories into semantic summaries
- [ ] Standalone app intercepts requests and injects memory
- [ ] Workspace context is collected and sent
- [ ] App UI shows memory state and context injection
- [ ] All tests pass (unit + integration)
- [ ] User's tool talks to the standalone app, which transparently injects memory before hitting the LLM
