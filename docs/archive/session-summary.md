# Session Summary: Engram fix.md Implementation & System Bring-Up

**Date:** June 17-22, 2026  
**Sessions:** `ses_10f6fe83cffe2avC9UiZxr3yIQ` (Engram fix.md implementation), `ses_10ee3c8f0ffel4I7Ms4OmBScAz` (Locating Engram fix.md session)

---

## 1. Fix.md Implementation (9 Fixes Applied)

### Fix 1 — CRITICAL: Tenant Isolation in engramRouter
- **File:** `apps/langfuse/web/src/features/engram/server/engramRouter.ts`
- Added `AND project_id = $N` to all 5 queries (`getMemoryStats`, `listMemories`, `updateMemory`, `deleteMemory`, `getLogs`)
- Added `projectId` input to `updateMemory` and `deleteMemory` which were missing it

### Fix 2 — CRITICAL: Parameterize Hardcoded Credentials
- **File:** `docker-compose.yml`
- Replaced hardcoded `postgres:postgres` → `${EG_PG_PASSWORD:-postgres}`
- Replaced hardcoded `minioadmin` → `${MINIO_ACCESS_KEY:-minioadmin}` / `${MINIO_SECRET_KEY:-minioadmin}`
- Applied to both `langfuse-web` and `langfuse-worker` services

### Fix 3 — WARNING: Close Langfuse Generation Spans on All Exit Paths
- **Files:** `memoryLogger.ts`, `consolidationEngine.ts`
- All 3 LLM call sites now use a `generationEnded` guard flag + `finally` block to ensure `generation?.end()` is called on every exit path (success, fetch failure, network error)

### Fix 4 — WARNING: One-Time Langfuse Degradation Warning
- **File:** `route.ts`
- Added one-time `logger.warn` on first `getLangfuse()` failure via `_langfuseWarned` module flag

### Fix 5 — WARNING: Simplify Dead Conditional Branch
- **File:** `route.ts`
- Simplified dead branch: `env.llm_url || (env.openai_key ? env.openai_base_url : "")` → `env.llm_url || env.openai_base_url || ""`

### Fix 6 — SUGGESTION: Remove Redundant langfuse-init Service
- **File:** `docker-compose.yml`
- Removed redundant `langfuse-init` service (init script already creates the DB)
- Removed its `depends_on` reference from `langfuse-web`

### Fix 7 — SUGGESTION: Idempotent CREATE DATABASE
- **File:** `docker/postgres/init/01-create-databases.sql`
- Replaced bare `CREATE DATABASE` with idempotent pattern using `WHERE NOT EXISTS`

### Fix 8 — SUGGESTION: Recreate Langfuse Client on Env Changes
- **File:** `langfuseClient.ts`
- Added env-tracking (secret key, public key, host, enabled) and recreates the client when env values change
- Added `resetLangfuse()` export

### Fix 9 — SUGGESTION: Add Missing Env Vars to .env.example
- **File:** `.env.example`
- Added Langfuse/Docker section with `NEXTAUTH_SECRET`, `SALT`, `ADMIN_PASSWORD`, `REMOTE_LLM_URL`, `REMOTE_LLM_API_KEY`, `REMOTE_LLM_MODEL`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `EG_INTERNAL_API_KEY`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`

---

## 2. Code Review Findings (Post-Implementation)

### Finding A: Dedup Query Without Covering Index
- **File:** `packages/engram-js/src/services/memoryLogger.ts:208`
- **Problem:** The dedup check (`select 1 from memories where content = $1 and superseded_at is null limit 1`) runs inside a loop for every extracted fact. The `content` column has no index — only `project_id`, `user_id`, `recorded_at`, `is_genome`, and `embedding` are indexed. On a table with thousands of rows, each dedup check performs a full sequential scan, repeated for up to 8 facts per extraction.
- **Suggestion:** Add partial index: `create index memories_content_dedup_idx on memories(content) where superseded_at is null`. Or batch all fact contents into a single query with `content = ANY($1)` to reduce N queries to 1.

### Finding B: Duplicated Langfuse Generation-End Guard Pattern
- **Files:** `memoryLogger.ts:100`, `consolidationEngine.ts:127,233`
- **Problem:** The `generationEnded` flag + try-fetch-finally guard pattern is replicated across 3 call sites in 2 files. If the Langfuse API contract changes or a developer modifies one copy's error handling without updating the others, they will silently drift.
- **Suggestion:** Extract a shared helper function: `async function withLangfuseGeneration<T>(config, fn: (gen) => Promise<T>): Promise<T>` that handles creation, the guard flag, and finally cleanup in one place.

---

## 3. System Bring-Up & Docker Deployment

### Prerequisites
- Docker + Docker Compose v2
- `docker buildx` plugin installed
- Linux Arch server environment

### .env Configuration (Mandatory)
| Variable | Purpose |
|----------|---------|
| `EG_PG_PASSWORD` | PostgreSQL password |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | MinIO S3 credentials |
| `REMOTE_LLM_URL` | llama-swap endpoint (`http://searxNcrawl:8080/v1`) |
| `REMOTE_LLM_API_KEY` | llama-swap API key |
| `REMOTE_LLM_MODEL` | Model name (must match llama-swap exactly) |
| `EG_OPENAI_MODEL` / `EG_EMBEDDING_MODEL` | Embedding model names |
| `LANGFUSE_SECRET_KEY` / `LANGFUSE_PUBLIC_KEY` | Langfuse API keys (generated post-deploy) |

### .env Configuration (Optional / Post-Deploy)
| Variable | Purpose |
|----------|---------|
| `NEXTAUTH_SECRET` | NextAuth secret for Langfuse |
| `SALT` | Password salt |
| `ADMIN_PASSWORD` | Admin password for Langfuse UI |
| `EG_INTERNAL_API_KEY` | Internal API key |

### Service Table (Docker Compose)
| Service | Port | Status | Notes |
|---------|------|--------|-------|
| Engram | 8098 | healthy | Health check passes |
| Langfuse Web | 3000 | up | Login: `admin@engram.local` / `admin123` |
| Langfuse Worker | — | up | Background processing |
| Postgres | 5432 | healthy | Internal only |
| ClickHouse | 8123 | healthy | Trace storage |
| Redis | 6379 | healthy | Cache / queue |
| MinIO | 9000 | healthy | S3-compatible blob store |
| SearXNG | 8888 | up | Search engine |
| searxNcrawl | 9555 | up | Crawler service |

### Deployment Command
```bash
cd /home/ftr/Apps/Engram && docker compose up --build -d
```

---

## 4. Troubleshooting Issues Encountered & Resolved

### Issue 1: buildx Plugin Required for Langfuse Build
- **Problem:** Langfuse Dockerfile requires `docker/buildx` plugin
- **Fix:** Installed via `sudo pacman -S docker-buildx` (Arch Linux)

### Issue 2: ClickHouse Migration URL Format
- **Problem:** `CLICKHOUSE_MIGRATION_URL` was set to `http://` format, but Langfuse's native protocol driver requires `clickhouse://`
- **Fix:** Changed all ClickHouse URLs from `http://` → `clickhouse://`

### Issue 3: ClickHouse Password Mismatch
- **Problem:** `CLICKHOUSE_PASSWORD` not set on the ClickHouse container itself, causing auth failure when Langfuse services tried to connect
- **Fix:** Added `CLICKHOUSE_PASSWORD` env var to both the ClickHouse service and all Langfuse services

### Issue 4: ClickHouse Cluster Mode (ReplicatedMergeTree)
- **Problem:** ClickHouse migrations used `ReplicatedMergeTree` which requires ZooKeeper — not available in single-node setup
- **Fix:** Added `CLICKHOUSE_CLUSTER_ENABLED=false` to both `langfuse-web` and `langfuse-worker` services so migrations use single-node `MergeTree`

### Issue 5: Sign-In Failure (Missing LANGFUSE_INIT_ORG_ID)
- **Problem:** Langfuse init variables required `LANGFUSE_INIT_ORG_ID` to be set for the admin user to be created
- **Fix:** Added `LANGFUSE_INIT_ORG_ID` env var to docker-compose.yml

### Issue 6: Model Name Case Sensitivity (llama-swap)
- **Problem:** Model names were case-inconsistent between `.env`, `docker-compose.yml`, and llama-swap's internal registry. llama-swap is case-sensitive for model name matching.
- **Fix:** Normalized all references to exact llama-swap names:
  - `LFM2.5-1.2B-Instruct` (generative)
  - `Nomic-Embed-Text-v1.5` (embedding)
  - `CodeRankEmbed` (code embedding)

### Issue 7: Traces Not Persisting (S3 Region & Credentials)
- **Problem:** Langfuse created traces via Engram's client but couldn't persist them to MinIO S3 due to missing region and credential env vars (`LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID`, `LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY`)
- **Fix:** Added correct S3 event upload env vars with endpoint, region, and path-style settings; created `langfuse-events` MinIO bucket

### Issue 8: ClickHouse Database Not Created
- **Problem:** The `langfuse` database didn't exist in ClickHouse for the Langfuse event/migration tables
- **Fix:** Manually created the database via ClickHouse admin CLI

---

## 5. Current System Status (Post-Fix)

### Working Components
- ✅ Engram health check: `http://localhost:8098/health` → HTTP 200
- ✅ Engram chat proxy: sends requests to llama-swap, streams responses back
- ✅ Memory extraction runs after each chat turn
- ✅ Langfuse web UI at `http://localhost:3000` — login with `admin@engram.local` / `admin123`
- ✅ Traces flowing from Engram → Langfuse (ClickHouse)
- ✅ 7+ memories stored in Engram's PostgreSQL DB

### Known Remaining Issues (User Action Required)
1. **Langfuse API Keys** — Must be manually generated via UI: Project Settings → API Keys → Create new key. Set `LANGFUSE_SECRET_KEY` and `LANGFUSE_PUBLIC_KEY` in `.env`, then restart Engram.
2. **LLM Connections tab blank** — This is Langfuse's model catalog, not Engram. Models can be configured under Project Settings → Model Based Evals if needed (not required for core functionality).
3. **Performance tab shows raw JSON** — The `getPerformance` endpoint returns system metrics correctly (`cpu_percent`, `memory_total_mb`, etc.), but the Langfuse UI renders the response as-is without charts. Requires UI update in `apps/langfuse/web/src/pages/project/[projectId]/engram/performance/index.tsx`.
4. **Engram tabs (Dashboard, Memories, Logs) empty** — The engram tRPC router needs proper configuration with `ENGRAM_DATABASE_URL` pointing to the PostgreSQL connection string.
5. **Sessions tab not working** — Related to session ID generation; requires investigation of the sessions endpoint.

### Model Names (Must Match llama-swap Exactly)
| Purpose | Model Name |
|---------|------------|
| Generative (primary) | `LFM2.5-1.2B-Instruct` |
| Embedding | `Nomic-Embed-Text-v1.5` |
| Code embedding | `CodeRankEmbed` |

---

## 6. Post-Deployment Checklist

- [ ] Generate Langfuse API keys in UI → set in `.env` → restart Engram
- [ ] Send substantive chat message to generate memories (one-word queries produce no facts)
- [ ] Verify traces appear in Langfuse Traces tab
- [ ] Verify memories appear in Langfuse Engram tab
- [ ] Fix engram tRPC router `ENGRAM_DATABASE_URL` for Dashboard/Memories/Logs tabs
- [ ] Add charts to Performance page (`apps/langfuse/web/src/pages/project/[projectId]/engram/performance/index.tsx`)
- [ ] Investigate Sessions tab (session ID generation)
- [ ] Consider implementing custom LLM endpoint support in Langfuse LLM Connections

---

## 7. Backup Commands

```bash
# PostgreSQL backup
docker exec langfuse-postgres pg_dump -U postgres langfuse > /tmp/langfuse-db.sql

# Engram PostgreSQL backup (if separate database)
docker exec engram-postgres pg_dump -U postgres engram > /tmp/engram-db.sql

# MinIO data
docker run --rm -v minio_data:/data -v /tmp:/backup alpine tar czf /backup/minio-backup.tar.gz -C /data .
```

---

*Document auto-generated from session transcripts `ses_10f6fe83cffe2avC9UiZxr3yIQ` and `ses_10ee3c8f0ffel4I7Ms4OmBScAz`.*
