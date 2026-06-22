# Langfuse Integration Review Findings

## Summary
Comprehensive Langfuse integration across all 5 sprints: replaces the submodule with git subtree, adds ClickHouse/MinIO/Langfuse containers to the stack, removes Ollama entirely, instruments Engram's LLM calls with Langfuse tracing, and creates Engram management pages inside Langfuse's Next.js UI. The TypeScript compiles cleanly. Several security and reliability issues need attention before production deployment.

## Issues Found

| Severity | File:Line | Issue | Status |
|----------|-----------|-------|--------|
| CRITICAL | `engramRouter.ts:6,10,24` | Direct raw pg Pool to engram DB bypasses all auth; projectId never used in queries | ✅ Fixed |
| CRITICAL | `docker-compose.yml:185,190,223` | Hardcoded postgres + minio credentials in compose file | ✅ Fixed |
| WARNING | `memoryLogger.ts:99`, `consolidationEngine.ts:128` | Langfuse generation spans never closed on fetch failure paths | ✅ Fixed |
| WARNING | `route.ts:176` | Silent tracing degradation when Langfuse is down — no warning log | ✅ Fixed |
| WARNING | `route.ts:317` | Dead conditional branch in URL resolution after Ollama removal | ✅ Fixed |
| WARNING | `docker-compose.yml:94` | Hardcoded remote GPU server IP (100.108.182.121) | ✅ Fixed |
| SUGGESTION | `.env.example` | Missing Langfuse/Docker-only env vars | ✅ Fixed |
| SUGGESTION | `docker-compose.yml:66` | Redundant langfuse-init service duplicates init script | ✅ Fixed |
| SUGGESTION | `docker/postgres/init/01-create-databases.sql:1-2` | Missing IF NOT EXISTS on CREATE DATABASE | ✅ Fixed |
| SUGGESTION | `langfuseClient.ts:4` | Singleton client never reloads stale env on config changes | ✅ Fixed |
| SUGGESTION | `memoryLogger.ts:208` | Dedup query scans `content` column without index — slow on large tables | ✅ Noted |
| SUGGESTION | `memoryLogger.ts:100`, `consolidationEngine.ts:127,233` | Langfuse generation-end guard pattern duplicated across 3 call sites — drift risk | ✅ Noted |

## Detailed Findings

### ✅ CRITICAL: Direct pg Pool bypasses engram API with no tenant isolation
**File:** `apps/langfuse/web/src/features/engram/server/engramRouter.ts:6,10,24`

Maintains a raw `new Pool({ connectionString: ENGRAM_DATABASE_URL })` directly to the engram production DB, bypassing all application-layer auth. Every procedure accepts `projectId` as validated input but **never uses it** in any SQL query — `getMemoryStats`, `listMemories`, `deleteMemory`, `updateMemory` all operate on the unscoped `memories` table. Any authenticated user in any Langfuse project can read/update/delete memories from any other project.

**Fix:** Either route all engram data through the engram API (`http://engram:8080`) via `EG_INTERNAL_API_KEY`, or add `AND project_id = $N` to every query using the validated `projectId` (requires `project_id` column in memories table).

---

### ✅ CRITICAL: Hardcoded credentials in docker-compose

### ✅ WARNING: Unclosed Langfuse generation spans on fetch failures

### ✅ WARNING: Silent tracing degradation when Langfuse is down

### ✅ WARNING: Dead conditional branch in URL resolution

### ✅ WARNING: Hardcoded remote GPU server IP

### ✅ SUGGESTION: Missing env vars in .env.example

### ✅ SUGGESTION: Redundant langfuse-init service

### ✅ SUGGESTION: Missing IF NOT EXISTS on CREATE DATABASE

### ✅ SUGGESTION: Singleton client never reloads stale env
**File:** `packages/engram-js/src/services/langfuseClient.ts:4`

Singleton `client` initialized once at module load and never re-reads env vars. Hot-reload or config changes at runtime are silently ignored — the stale client persists until process restart.

**Fix:** Recreate the client on each `getLangfuse()` call when env values change, or add a `reset()` method.

---

### SUGGESTION: Dedup query on `content` column has no covering index
**File:** `packages/engram-js/src/services/memoryLogger.ts:208`

The dedup check `select 1 from memories where content = $1 and superseded_at is null limit 1` runs inside a loop for each extracted fact (up to 8 per turn). The `content` column has no index — only `project_id`, `user_id`, `recorded_at`, and `embedding` are indexed. On large tables each dedup triggers a sequential scan.

**Fix:** Add a partial index: `create index memories_content_dedup_idx on memories(content) where superseded_at is null`. For long contents, index `sha256(content)` instead. Alternatively batch dedup into a single `content = ANY($1)` query.

---

### SUGGESTION: Langfuse generation-end guard pattern duplicated across 3 call sites
**File:** `packages/engram-js/src/services/memoryLogger.ts:100`, `packages/engram-js/src/services/consolidationEngine.ts:127,233`

The `generationEnded` flag + try-fetch-finally guard pattern is replicated across 3 call sites in 2 files. If the Langfuse API changes or one copy's error handling is updated without the others, they silently drift. The pattern is fragile — early returns before setting `generationEnded = true` cause missed or double `end()` calls.

**Fix:** Extract a shared helper: `async function withLangfuseGeneration<T>(config, fn: (gen) => Promise<T>): Promise<T>` that handles creation, guard flag, and finally cleanup in one place.