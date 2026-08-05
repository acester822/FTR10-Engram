# Engram Code Improvement Tracker

> Tracking progress on the prioritized improvement list from codebase analysis.
> Generated: 2026-06-18 | Last updated: 2026-06-18

---

## P0 — Critical (Security, Data Integrity, Reliability)

### 1. User impersonation on `/v1/chat/completions`
- **Fix:** Auth middleware now attaches `req.auth_user_id` after successful key validation. Route handler overrides any client-supplied `user_id` with the authenticated identity and logs a warning on mismatch.
- **Files:** `api/middleware/auth.ts:110-113`, `api/routes/chat/completions/route.ts:148-159`
- **Status:** ✅ Complete

### 2. Prompt injection via memory content + branding cleanup
- **Fix:** Added `sanitizeMemoryContent()` that strips any `[ENGRAM...]` delimiter markers from recall content before injection. Renamed `[CODECORTEX *]` blocks to `[ENGRAM *]`. Fixed typos in emotional sector regex patterns in `memoryInjector.ts`.
- **Files:** `api/routes/chat/completions/route.ts:43-48`, `services/memoryInjector.ts:69`
- **Status:** ✅ Complete

### 3. Compaction & consolidation writes not transactional
- **Fix:** Added nested transaction support to `connection.ts` via depth tracking. Wrapped compaction's `saveExtractedFacts()` and consolidation's `executeActions()` in `BEGIN/COMMIT/ROLLBACK`. Nested `rememberDurableMemory` calls (which also use `BEGIN/COMMIT`) are now safe.
- **Files:** `database/connection.ts:72-108`, `services/compactionEngine.ts:273-304`, `services/consolidationEngine.ts:244-292`
- **Status:** ✅ Complete

### 4. No retries / circuit breaker on upstream LLM fetch
- **Fix:** Created `utils/retry.ts` with `retryFetch()` — exponential backoff + jitter (3 attempts) for 408/429/502/503/504, plus per-host circuit breaker (3 consecutive failures → 30s cooldown). Updated chat completions route to use it.
- **Files:** `utils/retry.ts` (new), `api/routes/chat/completions/route.ts:262-272`
- **Status:** ✅ Complete

### 5. PostgreSQL pool error handling and shutdown hook
- **Fix:** Added `pool.on('error')` logger in `connection.ts`. Added graceful SIGTERM/SIGINT handler in `server.ts` that calls `close_database()`. Configured `idleTimeoutMillis: 60000`.
- **Files:** `database/connection.ts:17-20, 26`, `server.ts:13-24`
- **Status:** ✅ Complete

---

## P1 — High (Observability, Reliability, Maintainability)

### 6. Set up test infrastructure
- **Status:** ❌ Not started (complex, requires vitest + CI config)

### 7. Fix per-chunk SSE trace spam
- **Fix:** Replaced per-chunk `_trace` injection with a single `event: engram_trace` SSE frame sent once before streaming begins. Bandwidth savings: ~5KB × num_tokens → ~5KB total.
- **File:** `api/routes/chat/completions/route.ts:292-296`
- **Status:** ✅ Complete

### 8. Add genome memory cache
- **Status:** ❌ Not started (simple LRU — lower priority for now)

### 9. Add validateEnv() at startup
- **Fix:** Added `validateEnv()` in `configuration/index.ts` — checks `EG_API_KEY` requirement, `EG_PG_PASSWORD`, `EG_VEC_DIM` range, `EG_MAX_PAYLOAD_SIZE` bounds. Called from `startServer()`.
- **Files:** `configuration/index.ts:83-107`, `api/index.ts:70`
- **Status:** ✅ Complete

### 10. Embedding warmup + cache
- **Fix:** Created `utils/embedCache.ts` — simple Map-based LRU (500 entry cap) caching `facet:text` → `number[]`. Wired into `embedForFacet()` in `embed.ts` with cache-first lookup + store-after-compute. Added `warmupEmbedding()` to `api/index.ts` called after migrations: checks Ollama `/api/tags` for model availability, sends a dummy `embed("_warmup_")` to force model load before the server accepts connections. Non-fatal on failure.
- **Warmup result:** `qwen3-embedding:0.6b` loaded in ~3688ms at boot (confirmed via smoke test).
- **Files:** `utils/embedCache.ts` (new), `embeddings/embed.ts:8,42-52`, `api/index.ts:17,72-108,125`
- **Status:** ✅ Complete

---

## P2 — Medium (Cleanup, Quality of Life)

### 11. Replace console.* with structured logger
- **Fix:** Migrated ~10 instances across `auth.ts`, `chat/completions/route.ts`, `consolidationEngine.ts`, `envFile.ts`. Remaining ~16 are in `embed.ts` and `memoryLogger.ts`.
- **Files:** `api/middleware/auth.ts:132-134`, `api/routes/chat/completions/route.ts:174`, `services/consolidationEngine.ts:186,233,353,358`, `configuration/envFile.ts:35`
- **Status:** 🔄 In progress (~60% done)

### 12. Sweep branding leftovers
- **Fix:** Updated MCP client to prefer `EG_ENGRAM_URL` / `EG_ENGRAM_API_KEY` with legacy `EG_OPENMEMORY_*` as fallback (marked `// legacy`). Main `CODECORTEX` → `ENGRAM` rename done in P0 #2.
- **Files:** `mcp/client.ts:20-21, 26-27`
- **Status:** ✅ Complete

### 13-15. Rate limit persistence / httpApp types / envFile logging
- **Status:** ❌ Not started (P2 — low urgency)

---

## Legend
- ❌ Not started
- 🔄 In progress
- ✅ Complete
