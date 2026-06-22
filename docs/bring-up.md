# Engram System Bring-Up Procedure

## Prerequisites

- Docker + Docker Compose v2
- Node.js 20+ with pnpm
- A remote GPU server running llama-swap (or an OpenAI-compatible endpoint)
- Ports available: 3000 (Langfuse), 5432 (Postgres), 6379 (Redis), 8098 (Engram), 8123 (ClickHouse), 8888 (SearXNG), 9000 (MinIO), 9555 (searxNcrawl)

## 1. Environment Configuration

Copy the example env and fill in required values:

```bash
cp .env.example .env
```

### Mandatory fields in `.env`:

```bash
# Generate with: openssl rand -base64 32
NEXTAUTH_SECRET=<random-base64-32>
SALT=<random-base64-32>

# Langfuse admin credentials (used on first boot)
ADMIN_PASSWORD=<choose-a-password>

# Remote GPU server running llama-swap / Ollama
REMOTE_LLM_URL=http://<gpu-server-ip>:8080
REMOTE_LLM_API_KEY=<api-key-if-required>
REMOTE_LLM_MODEL=qwen3.5:2b       # Primary chat model
```

### Optional overrides:

```bash
# PostgreSQL
EG_PG_PASSWORD=<change-from-default>   # default: postgres

# MinIO S3 (used inside Docker for Langfuse event storage)
MINIO_ACCESS_KEY=<change-from-default> # default: minioadmin
MINIO_SECRET_KEY=<change-from-default> # default: minioadmin

# Auto-search via SearXNG (set to false to disable)
EG_AUTO_SEARCH_ENABLED=true
```

## 2. Docker Deployment (Full Stack)

```bash
docker-compose up --build
```

This starts all services:

| Service | Internal Port | External Port | Depends On |
|---------|--------------|---------------|------------|
| postgres | 5432 | 5432 | — |
| redis | 6379 | 6379 | — |
| clickhouse | 8123 | — | — |
| minio | 9000 | — | — |
| engram | 8080 | 8098 | postgres, redis |
| searxng | 8080 | 8888 | — |
| searxncrawl | 9555 | 9555 | searxng |
| langfuse-web | 3000 | 3000 | postgres, clickhouse, redis |
| langfuse-worker | — | — | langfuse-web |

### Service order on first boot:

1. **postgres** starts and runs `docker/postgres/init/01-create-databases.sql` — creates `engram` and `langfuse` databases idempotently.
2. **engram** starts after postgres is healthy — runs auto-migrations (creates `memories`, `edges`, `contradictions`, etc. tables).
3. **langfuse-web** starts after postgres, clickhouse, and redis are healthy — runs Prisma migrations automatically.
4. **langfuse-worker** starts after langfuse-web is ready — processes async queue jobs.

### Verify services:

```bash
# Engram health
curl http://localhost:8098/health

# Langfuse UI
open http://localhost:3000
# Login: admin@engram.local / <ADMIN_PASSWORD from .env>

# SearXNG
open http://localhost:8888
```

## 3. Local Development (Without Docker)

### 3.1 Start Postgres & Redis

```bash
docker run -d --name engram-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=engram \
  -p 5432:5432 \
  pgvector/pgvector:0.8.2-pg16-trixie

docker run -d --name engram-redis \
  -p 6379:6379 \
  redis:7-alpine
```

### 3.2 Start Engram Server

```bash
cd packages/engram-js
npm install
npx nodemon src/server.ts
```

The server listens on `http://localhost:8080`.

### 3.3 Start Langfuse (Optional — for tracing UI)

```bash
cd apps/langfuse

# Start dependencies
docker run -d --name engram-ch \
  -p 8123:8123 \
  clickhouse/clickhouse-server:24.3

docker run -d --name engram-minio \
  -p 9000:9000 \
  -p 9090:9090 \
  minio/minio server /data --console-address ":9090"

# Start Langfuse
pnpm install
pnpm run dev:web
pnpm run dev:worker
```

## 4. Client Configuration

Configure your AI client (Kilo, Cline, etc.) to use the Engram proxy:

```json
{
  "apiUrl": "http://localhost:8098/v1",
  "apiKey": "<EG_API_KEY if required>",
  "model": "qwen3.5:2b"
}
```

Engram acts as a transparent proxy: it intercepts the request, injects memory context, forwards to the upstream LLM (defined by `REMOTE_LLM_URL`), and streams the response back. Memory extraction runs in the background after the response completes.

## 5. Post-Deployment Checks

### Langfuse Setup (first boot only):
1. Visit `http://localhost:3000`
2. Log in with `admin@engram.local` / `<ADMIN_PASSWORD>`
3. Navigate to **Project Settings → API Keys**
4. Copy the Secret Key and Public Key
5. Set them in `.env` as `LANGFUSE_SECRET_KEY` and `LANGFUSE_PUBLIC_KEY`
6. Restart: `docker-compose up -d`

### Verify tracing:
After a chat completion, check Langfuse:
1. Open `http://localhost:3000`
2. Navigate to **Traces**
3. You should see `chat-completion` traces with child spans: `memory-recall`, `auto-search`, `compaction`, `llm-call`

### Verify memory extraction:
After a few chat turns, check the Langfuse traces for `memory-extraction` generation events under the `memoryLogger` module.

## 6. Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Engram returns 502 on chat | Remote GPU server unreachable | Verify `REMOTE_LLM_URL` in `.env` and check the remote host is running llama-swap |
| Langfuse returns 500 on login | `NEXTAUTH_SECRET` or `SALT` unset | Generate with `openssl rand -base64 32` and restart |
| No memory extraction | Extraction cooldown active (30s default) | Wait 30s between turns, or set `EG_EXTRACTION_COOLDOWN_MS=0` |
| No traces in Langfuse | Langfuse keys not configured | Check `.env` has `LANGFUSE_SECRET_KEY` and `LANGFUSE_PUBLIC_KEY` set |
| Embeddings fall back to synthetic | Remote embedding endpoint unreachable | Verify `EG_OPENAI_BASE_URL` in `.env` and remote host running embedding model |
| Docker build fails | Architecture mismatch in Dockerfile | Run `docker-compose build --no-cache` or check platform flags in Dockerfile |

## 7. Backup & Data

- **Postgres data**: `docker volume inspect engram_postgres_data`
- **Engram logs**: `./logs/` directory
- **MinIO data**: `docker volume inspect engram_minio_data`
- **Redis data**: `docker volume inspect engram_redis_data`

To backup the Engram memory database:

```bash
docker exec engram-postgres-1 pg_dump -U postgres engram > engram-backup-$(date +%Y%m%d).sql
```
