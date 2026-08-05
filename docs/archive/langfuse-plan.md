# Langfuse Integration Plan (Revised: Unified Architecture)

## Overview

Instead of running Langfuse as a separate submodule with independent containers, merge it into Engram's monorepo as an integrated system sharing infrastructure and UI. This eliminates the submodule complexity entirely.

Also: remove Ollama entirely. All generative tasks already run via `EG_GENERATIVE_URL` (remote GPU server). Embeddings move to the same remote server via the OpenAI-compatible `/v1/embeddings` endpoint. Ollama + model-loader containers disappear from the stack.

## Database Architecture

### Single PostgreSQL Instance, Separate Databases

Engram and Langfuse both use the `public` schema by default — they cannot share the same database. But they can share the same Postgres **instance** via separate databases:

| Database | Owner | Tables |
|---|---|---|
| `engram` | Engram | `memories`, `memory_versions`, `entities`, `edges`, `contradictions`, `provenance`, `inferences`, `working_memory`, `working_memory_events`, `extraction_candidates`, `consolidations`, `consolidation_results`, `audit_log` (14 tables) |
| `langfuse` | Langfuse | `users`, `projects`, `traces`, `observations`, `scores`, `prompts`, `models`, `datasets`, `evals`, `dashboards`, `comments`, etc. (~40 tables) |

Both databases coexist in the same Postgres container. Connection strings differ only by database name:
- Engram: `postgresql://postgres:postgres@postgres:5432/engram`
- Langfuse: `postgresql://postgres:postgres@postgres:5432/langfuse`

### Postgres Init Script for Dual Databases

```sql
-- docker/postgres/init/01-create-databases.sql
CREATE DATABASE engram;
CREATE DATABASE langfuse;

\c engram
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;

\c langfuse
-- Langfuse manages its own schema via Prisma migrations
```

Mount in docker-compose:
```yaml
postgres:
  volumes:
    - ./docker/postgres/init:/docker-entrypoint-initdb.d
    - postgres_data:/var/lib/postgresql/data
```

### ClickHouse (Mandatory for Langfuse)

**Cannot be avoided.** Langfuse has no feature flag to disable ClickHouse — `CLICKHOUSE_URL` is validated as required at startup. All trace/observation/score queries hit ClickHouse. This is non-negotiable.

However, ClickHouse is lightweight (single binary, ~200MB RAM idle) and shares the same docker network — negligible overhead.

Add a proper health check:
```yaml
clickhouse:
  healthcheck:
    test: ["CMD", "clickhouse-client", "--query", "SELECT 1"]
    interval: 10s
    timeout: 5s
    retries: 5
```

### Single Redis, Shared

Langfuse uses Redis for ~35+ BullMQ queues (ingestion, evals, exports, etc.). Engram barely touches Redis (only for legacy storage mode). They share the same Redis instance trivially — BullMQ queue keys use distinct prefixes.

### MinIO for Engram

Langfuse requires MinIO/S3 for ingestion event persistence (every ingested event batch is written to S3 before ClickHouse processing). Since it's already needed, convert Engram to optionally use MinIO for:

1. **Document ingestion** — store raw source files when users upload documents
2. **Media/attachments** — future-proofing for memory attachment support
3. **Backup/export** — export memory snapshots to MinIO

Not a prerequisite for the initial integration — Engram continues using Postgres-only storage while MinIO runs for Langfuse.

---

## Ollama Removal

### Current usage of Ollama

| Component | Current | Replacement |
|---|---|---|
| **Generative tasks** (extraction, compaction, consolidation, auto-search query gen) | `EG_GENERATIVE_URL` (already remote) | Already replaced — no change needed |
| **Embeddings** | `EG_EMBEDDINGS=ollama`, calls `POST /api/embeddings` | Switch to `EG_EMBEDDINGS=openai` pointing at the same remote GPU server |
| **Chat completions fallback** | `${EG_OLLAMA_URL}/v1` | Set `EG_UPSTREAM_LLM_URL` explicitly |
| **Dashboard Ollama stats** | `/api/performance/ollama` endpoint | Remove the endpoint |
| **Warmup** | Pre-loads embedding model into Ollama cache | Not needed for external API |
| **model-loader** | Pulls models into Ollama | Remove entirely |

### Embedding configuration after removal

The remote GPU server at `10.10.10.41:8080/v1` (llama-swap) supports OpenAI-compatible endpoints. If it serves `/v1/embeddings` with an embedding model loaded:

```env
EG_EMBEDDINGS=openai
EG_OPENAI_BASE_URL=http://10.10.10.41:8080/v1
EG_OPENAI_API_KEY=sk-whatever
EG_OPENAI_MODEL=qwen3-embedding:0.6b
```

### Containers removed

| Container | Reason |
|---|---|
| `ollama` | No longer needed — all LLM work goes to remote GPU server |
| `model-loader` | Only existed to pull models into Ollama |
| `scripts/load-models.sh` | Only existed for Ollama model management |

---

## Merging the Submodule

### Git Strategy: git subtree

Instead of a submodule, use `git subtree` to pull Langfuse into the repo:

```bash
# Initial add
git subtree add --prefix=apps/langfuse https://github.com/langfuse/langfuse.git v3.194.1 --squash

# Future updates
git subtree pull --prefix=apps/langfuse https://github.com/langfuse/langfuse.git v3.200.0 --squash
```

Engram-specific modifications to Langfuse (isolated paths — low conflict risk):
- `web/src/pages/project/[projectId]/engram/` — Engram management pages (new)
- `web/src/server/api/routers/engramRouter.ts` — Engram data tRPC routers (new)
- `web/src/components/layouts/routes.tsx` — Add Engram sidebar entries (modified)
- `web/src/env.mjs` — Add Engram-specific env vars (modified)
- `packages/shared/prisma/schema.prisma` — Unchanged
- `web/Dockerfile` / `worker/Dockerfile` — Unchanged

---

## Combined UI Architecture

### Strategy

Add Engram's management features as new pages **inside** Langfuse's existing Next.js app at `apps/langfuse/web`. Engram's custom React SPA (`apps/web`) is deprecated once this is complete.

### What Gets Ported

#### Pages (inside `apps/langfuse/web/src/pages/project/[projectId]/engram/`)

| Page | Route | Purpose | Data Source |
|---|---|---|---|
| **Memory Explorer** | `/project/[projectId]/engram/memories` | Search, filter, edit, delete memories | New tRPC router → Engram's Postgres |
| **Memory Dashboard** | `/project/[projectId]/engram` | Memory stats (total, genome, phenotype, by sector, by tier) | New tRPC router → Engram's Postgres |
| **Server Logs** | `/project/[projectId]/engram/logs` | Live pino log viewer | New tRPC router → reads Engram's log file |
| **System Performance** | `/project/[projectId]/engram/performance` | CPU, RAM, disk, GPU VRAM, Ollama models | New tRPC router → Engram's `/api/performance/*` endpoints |

#### Sidebar Navigation

Add a **"Engram"** section group to the sidebar:

```typescript
{
  title: "Engram",
  group: RouteGroup.Engram,
  section: RouteSection.Main,
  icon: Brain,
  items: [
    { title: "Dashboard",   pathname: `/project/[projectId]/engram`,  icon: LayoutDashboard },
    { title: "Memories",    pathname: `/project/[projectId]/engram/memories`, icon: Database },
    { title: "Server Logs", pathname: `/project/[projectId]/engram/logs`, icon: Terminal },
    { title: "Performance", pathname: `/project/[projectId]/engram/performance`, icon: Gauge },
  ],
}
```

#### tRPC Routers

New file: `apps/langfuse/web/src/server/api/routers/engramRouter.ts`

Uses raw `pg` Pool for Engram DB queries (read-only, no second Prisma needed):

```typescript
import { Pool } from "pg";

const engramPool = new Pool({ connectionString: process.env.ENGRAM_DATABASE_URL });

export const engramRouter = createTRPCRouter({
  getMemoryStats: authenticatedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async () => {
      const result = await engramPool.query(`
        SELECT COUNT(*) as total,
               COUNT(*) FILTER (WHERE is_genome = true) as genome_count,
               COUNT(*) FILTER (WHERE is_genome = false) as phenotype_count,
               sector, COUNT(*) as count
        FROM memories WHERE superseded_at IS NULL GROUP BY sector
      `);
      return result.rows;
    }),

  listMemories: authenticatedProcedure
    .input(z.object({ projectId: z.string(), search: z.string().optional(), sector: z.string().optional() }))
    .query(async ({ input }) => { ... }),

  updateMemory: authenticatedProcedure
    .input(z.object({ id: z.string(), content: z.string(), sector: z.string(), is_genome: z.boolean() }))
    .mutation(async ({ input }) => { ... }),

  deleteMemory: authenticatedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => { ... }),

  getLogs: authenticatedProcedure
    .input(z.object({ limit: z.number().default(100) }))
    .query(async () => { ... }),

  getPerformance: authenticatedProcedure
    .query(async () => {
      const res = await fetch("http://engram:8080/api/performance/system", {
        headers: { "x-api-key": process.env.EG_INTERNAL_API_KEY },
      });
      return res.json();
    }),
});
```

#### UI Components Available (from Langfuse's shadcn/ui set)

| Engram Need | Langfuse Component |
|---|---|
| Data tables with sorting/filtering | `<DataTable>`, `<DataTableToolbar>` |
| Badges for sector/tier labels | `<Badge>` with variants |
| Action buttons | `<Button>` (default, destructive, outline, ghost) |
| Search bars | `<Input>` + `<SearchBar>` |
| Edit dialogs | `<Dialog>`, `<Sheet>` |
| Confirmation dialogs | `<AlertDialog>` |
| Dropdown filters | `<Select>`, `<DropdownMenu>` |
| Tabs | `<Tabs>`, `<TabsContent>` |
| Layout containers | `<Page>`, `<Card>`, `<ScrollArea>` |
| Charts | Recharts (already in Langfuse's deps) |

---

## Docker Compose: Unified Infrastructure

```yaml
services:
  # ── Shared infrastructure ──
  postgres:
    image: pgvector/pgvector:0.8.2-pg16-trixie
    volumes:
      - ./docker/postgres/init:/docker-entrypoint-initdb.d
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s

  clickhouse:
    image: clickhouse/clickhouse-server:24.3
    volumes:
      - clickhouse_data:/var/lib/clickhouse
    healthcheck:
      test: ["CMD", "clickhouse-client", "--query", "SELECT 1"]
      interval: 10s
      timeout: 5s
      retries: 5

  minio:
    image: minio/minio
    volumes:
      - minio_data:/data
    command: server /data --console-address ":9090"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 10s
      timeout: 5s

  langfuse-init:
    image: postgres:16-alpine
    depends_on:
      postgres: { condition: service_healthy }
    environment:
      PGPASSWORD: postgres
    command: >
      sh -c "
        psql -h postgres -U postgres -c 'CREATE DATABASE langfuse;' 2>/dev/null || echo 'langfuse DB exists';
      "
    restart: "no"

  # ── Engram core ──
  engram:
    build: ./packages/engram-js
    ports:
      - "8098:8080"
    environment:
      EG_PG_HOST: postgres
      EG_PG_DB: engram
      EG_PG_USER: postgres
      EG_PG_PASSWORD: postgres
      EG_REDIS_URL: redis://redis:6379
      EG_INTERNAL_API_KEY: "${EG_INTERNAL_API_KEY}"
      EG_EMBEDDINGS: "openai"
      EG_OPENAI_BASE_URL: "${REMOTE_LLM_URL}/v1"
      EG_OPENAI_API_KEY: "${REMOTE_LLM_API_KEY}"
      EG_OPENAI_MODEL: "qwen3-embedding:0.6b"
      EG_GENERATIVE_URL: "${REMOTE_LLM_URL}/v1"
      EG_GENERATIVE_MODEL: "${REMOTE_LLM_MODEL}"
      EG_UPSTREAM_LLM_URL: "${REMOTE_LLM_URL}/v1"
      EG_LANGFUSE_HOST: http://langfuse-web:3000
      EG_LANGFUSE_SECRET_KEY: "${LANGFUSE_SECRET_KEY}"
      EG_LANGFUSE_PUBLIC_KEY: "${LANGFUSE_PUBLIC_KEY}"
      EG_LANGFUSE_ENABLED: "true"
    depends_on:
      postgres: { condition: service_healthy }

  # ── Auto-search (searxNcrawl) ──
  searxncrawl:
    build:
      context: ./apps/searxNcrawl
      dockerfile: Dockerfile
    ports:
      - "9555:9555"
    environment:
      SEARXNG_URL: http://searxng:8080
      MCP_PORT: 9555
    command:
      - python
      - -m
      - crawler.mcp_server
      - --transport
      - http
      - --host
      - 0.0.0.0
      - --port
      - "9555"

  searxng:
    image: searxng/searxng:latest
    cap_drop: [ALL]
    cap_add: [CHOWN, SETGID, SETUID]
    volumes:
      - ./apps/searxNcrawl/searxng:/etc/searxng:ro
    ports:
      - "8888:8080"

  # ── Langfuse ──
  langfuse-web:
    build:
      context: ./apps/langfuse
      dockerfile: web/Dockerfile
    image: engram-langfuse-web:${LANGFUSE_VERSION:-3.194.1}
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/langfuse
      ENGRAM_DATABASE_URL: postgresql://postgres:postgres@postgres:5432/engram
      CLICKHOUSE_URL: http://clickhouse:8123
      REDIS_CONNECTION_STRING: redis://redis:6379
      S3_ENDPOINT: http://minio:9000
      S3_ACCESS_KEY_ID: minioadmin
      S3_SECRET_ACCESS_KEY: minioadmin
      LANGFUSE_S3_EVENT_UPLOAD_BUCKET: langfuse-events
      LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY: minioadmin
      LANGFUSE_S3_EVENT_UPLOAD_SECRET_KEY: minioadmin
      NEXTAUTH_SECRET: "${NEXTAUTH_SECRET}"
      SALT: "${SALT}"
      NEXTAUTH_URL: "http://localhost:3000"
      LANGFUSE_INIT_USER_EMAIL: "admin@engram.local"
      LANGFUSE_INIT_USER_PASSWORD: "${ADMIN_PASSWORD}"
      LANGFUSE_INIT_PROJECT_ID: "engram-default"
      LANGFUSE_INIT_PROJECT_NAME: "Engram"
      EG_INTERNAL_API_KEY: "${EG_INTERNAL_API_KEY}"
      LANGFUSE_ENABLE_EXPERIMENTAL_FEATURES: "true"
    depends_on:
      postgres: { condition: service_healthy }
      clickhouse: { condition: service_healthy }
      redis: { condition: service_healthy }
      langfuse-init: { condition: service_completed_successfully }

  langfuse-worker:
    build:
      context: ./apps/langfuse
      dockerfile: worker/Dockerfile
    image: engram-langfuse-worker:${LANGFUSE_VERSION:-3.194.1}
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/langfuse
      CLICKHOUSE_URL: http://clickhouse:8123
      REDIS_CONNECTION_STRING: redis://redis:6379
      S3_ENDPOINT: http://minio:9000
      S3_ACCESS_KEY_ID: minioadmin
      S3_SECRET_ACCESS_KEY: minioadmin
      LANGFUSE_S3_EVENT_UPLOAD_BUCKET: langfuse-events
      LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY: minioadmin
      LANGFUSE_S3_EVENT_UPLOAD_SECRET_KEY: minioadmin
    depends_on:
      langfuse-web: { condition: service_started }

volumes:
  postgres_data:
  clickhouse_data:
  minio_data:
  redis_data:
```

**Container count: 9 persistent** (postgres, redis, clickhouse, minio, engram, searxNcrawl, searxng, langfuse-web, langfuse-worker) + 1 one-shot (langfuse-init).

**Net change vs current (8 persistent):** +2 — clickhouse + minio added; ollama + model-loader + ui removed; searxNcrawl + searxng stay.

---

## Tracing: Langfuse SDK in Engram

### SDK setup

```bash
cd packages/engram-js
npm install langfuse
```

Create `services/langfuseClient.ts`:

```typescript
import { Langfuse } from "langfuse";
import { env } from "../configuration";

let client: Langfuse | null = null;

export function getLangfuse(): Langfuse | null {
  if (!env.langfuse_secret_key || !env.langfuse_host) return null;
  if (!client) {
    client = new Langfuse({
      secretKey: env.langfuse_secret_key,
      publicKey: env.langfuse_public_key,
      baseUrl: env.langfuse_host,
    });
  }
  return client;
}
```

### Instrument `route.ts`

Create a trace at the start of each chat completion, with named spans:
- `memory-recall` — genome + phenotype fetching
- `auto-search` — searxNcrawl search + crawl
- `compaction` — message compaction (if triggered)
- `llm-call` — upstream LLM generation
- `memory-extraction` — async extraction

### Wrap Ollama/remote calls with `langfuse.generation()`

Every LLM call gets wrapped as a Langfuse generation span for per-call token counts and latency:

```typescript
const generation = lf?.generation({
  name: "compaction-summarize",
  model: env.generative_model,
  modelParameters: { temperature: 0.1 },
  input: extractionPrompt,
  metadata: { module: "compactionEngine" },
});

const response = await fetch(`${env.generative_url}/chat/completions`, { ... });
const data = await response.json();

generation?.end({
  output: data.choices?.[0]?.message?.content,
  usage: {
    promptTokens: data.usage?.prompt_tokens,
    completionTokens: data.usage?.completion_tokens,
  },
});
```

Locations to instrument:

| File | Call Type | Span Name |
|---|---|---|
| `route.ts` | Upstream LLM `/chat/completions` | `llm-call` |
| `memoryLogger.ts` | Extraction LLM | `memory-extraction` |
| `compactionEngine.ts` | Summarization LLM | `compaction-summarize` |
| `consolidationEngine.ts` | Consolidation LLM | `consolidation-decide` |
| `autoSearch.ts` | Query generation LLM | `auto-search-query-gen` |

### Config vars

```typescript
langfuse_enabled: bool(process.env.EG_LANGFUSE_ENABLED),
langfuse_host: str(process.env.EG_LANGFUSE_HOST, "http://langfuse-web:3000"),
langfuse_secret_key: str(process.env.EG_LANGFUSE_SECRET_KEY),
langfuse_public_key: str(process.env.EG_LANGFUSE_PUBLIC_KEY),
```

---

## Auth Architecture

| Context | Mechanism | Details |
|---|---|---|
| **User → Langfuse UI** | NextAuth session (JWT) | User logs in via credentials, auto-seeded via `LANGFUSE_INIT_USER_*` |
| **Langfuse Web → Engram DB** | Direct pg Pool | Queries Engram's Postgres directly — no HTTP |
| **Langfuse Web → Engram HTTP** | `x-api-key` header | Performance + log endpoints use `EG_INTERNAL_API_KEY` |
| **Engram → Langfuse (tracing)** | Langfuse SDK secret key | `EG_LANGFUSE_SECRET_KEY` authenticates trace writes |
| **Auto Search** | Docker network | `searxncrawl:9555` — internal network, no auth |
| **Remote LLM** | API key | `REMOTE_LLM_API_KEY` authenticates to remote GPU server |

---

## Implementation Order

### Sprint 1: Infrastructure
1. Create `docker/postgres/init/01-create-databases.sql`
2. Add ClickHouse + MinIO + langfuse-init to `docker-compose.yml`
3. Add all required Langfuse env vars
4. Add `EG_INTERNAL_API_KEY` to Engram's env
5. Switch embeddings to `openai` provider (remove `EG_OLLAMA_URL`)
6. Remove `ollama` and `model-loader` from docker-compose
7. Set up `.env` with all vars
8. Launch full stack, verify Engram + Langfuse + auto-search work independently

### Sprint 2: Remove Submodule, Add via Subtree
1. `git submodule deinit -f apps/langfuse && git rm -f apps/langfuse`
2. `git subtree add --prefix=apps/langfuse https://github.com/langfuse/langfuse.git v3.194.1 --squash`
3. Delete `.gitmodules`
4. Update `docs/submodules.md` → rename to `docs/architecture.md`

### Sprint 3: Tracing (Engram instrumentation)
1. Install `langfuse` npm package
2. Create `services/langfuseClient.ts`
3. Add config vars to `configuration/index.ts`
4. Instrument `route.ts` with full trace
5. Wrap all LLM calls in memoryLogger, compactionEngine, consolidationEngine
6. Send test request, verify traces appear in Langfuse UI

### Sprint 4: Engram Pages in Langfuse UI
1. Create `engramRouter.ts` tRPC router
2. Create 4 pages: Memory Explorer, Dashboard, Server Logs, Performance
3. Register router in `root.ts`, add sidebar entries to `routes.tsx`

### Sprint 5: Cleanup
1. Remove `apps/web` service from docker-compose
2. Archive `apps/web` directory
3. Update `docs/architecture.md`

---

## Risk Analysis

| Risk | Impact | Mitigation |
|---|---|---|
| **ClickHouse is extra infrastructure** | +1 container, ~200MB RAM | Docker network-local, negligible overhead |
| **Langfuse upstream updates conflict** | Merge pain on `git subtree pull` | Additive changes in isolated paths; `--squash` minimizes conflicts |
| **Embeddings provider unavailable** | Memory recall fails gracefully | Engram has `synthetic` fallback that generates deterministic hash embeddings |
| **Langfuse auth required** | Must create user to access UI | `LANGFUSE_INIT_USER_*` env vars auto-seed admin user |
| **Langfuse version upgrades break** | Pages or tracing may regress | Pin version via `LANGFUSE_VERSION`, upgrade deliberately |
| **Two Postgres databases** | Schema management overhead | Same instance, separate databases — simple connection string diff |
| **Langfuse requires S3** | +1 container (MinIO) | ~50MB, negligible; Engram can optionally use it later |
| **Remote LLM unavailable** | No generative features | `EG_GENERATIVE_URL` can point to any OpenAI-compatible fallback |

---

## Quick Reference: Final Stack

| Service | Purpose | Contributed By |
|---|---|---|
| `postgres` | Dual: Engram DB + Langfuse DB | Shared |
| `redis` | BullMQ queues (Langfuse) + optional cache (Engram) | Shared |
| `clickhouse` | Trace/score analytics (Langfuse) | Langfuse |
| `minio` | Ingestion event persistence (Langfuse) | Langfuse |
| `engram` | Memory proxy server | Engram |
| `searxncrawl` | Auto-search (web search + crawl) | Engram |
| `searxng` | Meta-search engine for auto-search | Engram |
| `langfuse-web` | Combined UI (observability + Engram management) | Langfuse (forked) |
| `langfuse-worker` | Background job processing | Langfuse |
| `langfuse-init` | One-shot DB creation (exits after run) | Engram (init helper) |

**Removed from current stack:** `ollama`, `model-loader`, `ui` (replaced by `langfuse-web`).

**Net change vs current (8 containers):** +1 persistent (clickhouse — but minio was required by Langfuse anyway, and langfuse-web+worker replace `ui`). The stack is leaner: remote GPU server handles all LLM work, no local inference containers.
