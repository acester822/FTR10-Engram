# Phase 1: Engine & Schema Foundation

> Goal: Upgrade the backend memory engine with biological memory concepts (Genome/Phenotype, temporal decay).
> Prerequisite: Postgres + pgvector running and stable.

---

## 1. Database Schema Changes

### 1.1 Genome/Decay columns on memories table
- [ ] Add `is_genome BOOLEAN DEFAULT FALSE` to memories table
- [ ] Add `decay_rate REAL DEFAULT 0.1` (Ebbinghaus curve parameter)
- [ ] Add `access_count INTEGER DEFAULT 0` (boosts resistance to decay)
- [ ] Add `last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
- [ ] Add `consolidation_hash TEXT` (for merging similar memories)

**Acceptance criteria:**
- Schema migration runs idempotently (safe to run twice)
- Migration tested against real Postgres
- Existing rows get sensible defaults (is_genome=false, decay_rate=0.1, etc.)

**Notes:**
- `is_genome` is the key differentiator: genome memories never decay, phenotype memories do
- `consolidation_hash` will be populated during consolidation to link merged memories

### 1.2 Indexes for performance
- [ ] Index on `memories(is_genome)` for fast genome queries
- [ ] Index on `memories(last_accessed)` for decay calculations
- [ ] Index on `memories(access_count)` for ranking
- [ ] Index on `memories(consolidation_hash)` for consolidation lookups

**Acceptance criteria:**
- Query plans for genome fetch and decay ranking show index usage
- No sequential scans on large tables (>100k rows)

---

## 2. `memoryInjector.ts` Service

### 2.1 Type definitions
- [ ] Define `MemorySector` enum (EPISODIC, SEMANTIC, PROCEDURAL, EMOTIONAL, REFLECTIVE)
- [ ] Define `Memory` interface with all fields including new genome/decay fields
- [ ] Define `CognitiveContext` type for the formatted output
- [ ] Define `DecayScore` intermediate type

**Notes:**
- Keep types in a shared module so proxy and consolidation can import them

### 2.2 Genome fetcher
- [ ] Implement `fetchGenome(): Promise<Memory[]>`
  - Fast SQL query: `SELECT * FROM memories WHERE is_genome = TRUE ORDER BY created_at DESC LIMIT 10`
  - No vector search, no embedding
  - Returns top 10 genome memories (configurable)
- [ ] Handle empty result gracefully (return empty array, not error)
- [ ] Add logging: `[CodeCortex] Fetched N genome memories`

**Acceptance criteria:**
- Query completes in <5ms on tables with 100k+ rows
- Returns correct results when no genome memories exist

### 2.3 Phenotype fetcher
- [ ] Implement `fetchPhenotype(userPrompt: string): Promise<Memory[]>`
  1. Embed the user prompt using existing `embedText()` function
  2. Query top 20 candidates via pgvector similarity search
  3. Apply Ebbinghaus temporal decay scoring
  4. Sort by final score, return top 5

**Temporal decay formula:**
```
Final_Score = Vector_Similarity * Recency_Multiplier * Access_Multiplier

Recency_Multiplier = e^(-decay_rate * time_diff_days)
Access_Multiplier = 1 + ln(1 + access_count)
```

**Acceptance criteria:**
- Vector search returns results in <100ms for typical workloads
- Decay scoring correctly demotes old, infrequently accessed memories
- Access count boost prevents frequently-used memories from decaying

### 2.4 Access count updater
- [ ] Implement `updateAccessCounts(memories: Memory[]): Promise<void>`
  - Fire-and-forget async update
  - SQL: `UPDATE memories SET access_count = access_count + 1, last_accessed = NOW() WHERE id IN (...)`
  - Wrap in try/catch, log errors but don't fail the request

**Notes:**
- This is async and non-blocking — if it fails, the memory still works, it just doesn't get the access boost

### 2.5 Prompt formatter
- [ ] Implement `formatPromptInjection(genome: Memory[], phenotype: Memory[]): string`
  - Output format:
    ```
    [CODECORTEX COGNITIVE CONTEXT]
    --- CORE DIRECTIVES (GENOME) ---
    - User prefers functional React.
    - Project uses PostgreSQL.

    --- RECALLED CONTEXT (PHENOTYPE) ---
    [EPISODIC]
    - Yesterday, user struggled with JWT refresh tokens.
    [PROCEDURAL]
    - Always run `npm run lint` before committing.

    [END CODECORTEX CONTEXT]
    Use the above context silently to inform your response. Do not explicitly mention "CodeCortex" or the context blocks unless directly asked about your memory.
    ```
  - Group phenotype memories by sector for better LLM comprehension
  - Keep output token-efficient (no redundant info)

**Acceptance criteria:**
- Output is valid text that an LLM can parse
- Genome section always appears first (higher priority)
- Empty sections are omitted (don't output empty headers)

### 2.6 Main entry point
- [ ] Implement `buildCognitiveContext(userPrompt: string): Promise<string>`
  - Orchestrates genome fetch, phenotype fetch, access count update, and formatting
  - Returns the final context string

**Acceptance criteria:**
- Full pipeline completes in <200ms end-to-end
- Returns non-empty string when relevant memories exist
- Returns minimal string when no memories match

---

## 3. Tests

### 3.1 Unit tests for memoryInjector
- [ ] Test `fetchGenome()` returns correct rows
- [ ] Test `fetchGenome()` handles empty result
- [ ] Test `fetchPhenotype()` applies decay correctly
- [ ] Test `fetchPhenotype()` boosts high-access memories
- [ ] Test `formatPromptInjection()` with genome only
- [ ] Test `formatPromptInjection()` with phenotype only
- [ ] Test `formatPromptInjection()` with both
- [ ] Test `formatPromptInjection()` with empty inputs
- [ ] Test `updateAccessCounts()` fires and forgets

### 3.2 Integration tests
- [ ] Test full pipeline against real Postgres
- [ ] Test genome fetch with 100k+ rows
- [ ] Test phenotype fetch with pgvector
- [ ] Test decay scoring with various time deltas

---

## 4. Documentation

- [ ] Document the Genome/Phenotype model in a new doc
- [ ] Document the temporal decay formula and parameters
- [ ] Document the `memoryInjector.ts` API surface
- [ ] Add inline JSDoc comments on public methods

---

## 5. Definition of Done

- [ ] Schema migration runs cleanly on fresh Postgres
- [ ] `memoryInjector.ts` is implemented and tested
- [ ] Genome fetch returns immutable facts in <5ms
- [ ] Phenotype fetch applies decay and returns top 5
- [ ] Prompt injection is formatted and token-efficient
- [ ] All tests pass (unit + integration)
- [ ] You can query the API and get biologically-modeled memory chunks
