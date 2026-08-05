# Engram System Bring-Up Procedure

## Prerequisites

- Docker + Docker Compose v2 (`docker compose`, not `docker-compose`)
- Node.js 20+ (only for local dev)
- A remote GPU box running **llama-swap** (OpenAI-compatible) — the live deployment uses `10.10.10.41:8080`
- Ports available: 5432 (Postgres), 6379 (Redis), 8098 (Engram API), 8099 (Web GUI), 8888 (SearXNG), 9555 (searxNcrawl)

> Langfuse / ClickHouse / MinIO were removed from the stack (Aug 2026). There is no port 3000 UI.

## 1. Environment Configuration

```bash
cp .env.example .env
```

`.env` holds ONLY the startup values that cannot be GUI-managed (see `docs/model-config-audit.md`):

```bash
# LLM box (compose + startup bootstrap)
EG_GENERATIVE_URL=http://<gpu-server-ip>:8080/v1
EG_UPSTREAM_LLM_URL=http://<gpu-server-ip>:8080/v1
EG_OPENAI_BASE_URL=http://<gpu-server-ip>:8080/v1
EG_OPENAI_API_KEY=<api-key-if-required>

# PostgreSQL
EG_PG_HOST=postgres        # compose network name (localhost for local dev)
EG_PG_PORT=5432
EG_PG_DB=engram
EG_PG_USER=postgres
EG_PG_PASSWORD=<change-from-default>
EG_PG_SCHEMA=
EG_PG_SSL=

# Redis
EG_REDIS_URL=redis://redis:6379

# Logging (logger reads these at static import)
EG_LOG_DIR=/home/ftr/Apps/Engram/logs   # compose bind mount: ./logs
EG_LOG_MAX_LINES=3000
LOG_LEVEL=info

# Internal / runtime
EG_INTERNAL_API_KEY=
NODE_ENV=
```

**No shell exports are needed** — a plain `docker compose up -d` works.

## 2. Docker Deployment

```bash
docker compose up -d --build
```

| Service | External Port | Depends On |
|---------|---------------|------------|
| postgres | 5432 | — |
| redis | 6379 | — |
| engram | 8098 | postgres (healthy), redis |
| web | 8099 | engram |
| searxng | 8888 | — |
| searxncrawl | 9555 | searxng |

First-boot order:
1. **postgres** runs `docker/postgres/init/01-create-databases.sql` (creates `engram` idempotently).
2. **engram** waits for postgres health, then boots: settings bootstrap → auto-migrations (idempotent `IF NOT EXISTS`, schema `4.1.0-settings`) → HTTP server → consolidation cron at ~2s.

### Post-boot configuration (web GUI :8099 → Settings tab)

Providers and models are configured here (single source of truth, persisted in `app_settings`):
1. **Provider Settings** — type *OpenAI Compatible*, host `10.10.10.41`, port `8080` (base URL auto-completes to `http://10.10.10.41:8080/v1`).
2. **Generative Models** — master model (e.g. `LFM2.5-1.2B-Instruct`), optional per-task overrides.
3. **Embedding Models** — master (e.g. `nomic-embed-text-v1.5`), optional per-facet overrides.
4. Use **Test & Save** on each section — it persists the settings AND live-validates them.

### Verify services

```bash
curl http://localhost:8098/health                    # {"status":"ok"} (or similar 200)
curl http://localhost:8099/                          # Web GUI
curl http://localhost:8098/api/settings              # current + resolved config
```

## 3. Local Development (Without Docker)

```bash
# 3.1 Postgres + Redis
docker run -d --name engram-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=engram -p 5432:5432 \
  pgvector/pgvector:0.8.2-pg16-trixie
docker run -d --name engram-redis -p 6379:6379 redis:7-alpine

# 3.2 Engram server (migrations run automatically at boot)
cd packages/engram-js
npm install
EG_PORT=8080 HOST=0.0.0.0 npx tsx src/server.ts
```

## 4. Client Configuration

Point your AI client (Cline, custom CLI, VS Code extension) at the OpenAI-compatible proxy:

```json
{
  "apiUrl": "http://localhost:8098/v1",
  "apiKey": "<EG_API_KEY if required>"
}
```

Engram intercepts the request, injects memory context, forwards to the upstream LLM (provider settings / `EG_UPSTREAM_LLM_URL`), and streams the response back. Memory extraction runs in the background after the response completes.

## 5. Post-Deployment Checks

1. **Health**: `curl http://localhost:8098/health`
2. **Settings**: `GET /api/settings` shows the resolved generative/embedding models + provider URL; use the GUI's Test & Save to validate each section live.
3. **Memory extraction**: after a few chat turns, check the **Server Logs** tab for `memoryLogger` entries (`Saved N new memories`).
4. **Consolidation**: `curl -X POST http://localhost:8098/api/dashboard/consolidate` then watch logs for chunked `Sending ≤150 related memories` + `returned actions`.
5. **Recall quality**: `bun run tsx scripts/recall-eval.ts` (baseline recall@1 ≈ 0.73).

## 6. Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Engram returns 502 on chat | Upstream LLM unreachable | Verify Provider settings (or `EG_GENERATIVE_URL`/`EG_UPSTREAM_LLM_URL` in `.env`); use Test & Save |
| No memory extraction | Extraction cooldown (30s default) | Wait 30s between turns; adjust in Settings → General |
| Embeddings fall back to synthetic | Embedding endpoint unreachable / model evicted | Verify `EG_OPENAI_BASE_URL`; keep Nomic loaded in llama-swap's `persistent` group |
| No logs in the GUI | `EG_LOG_DIR` wrong/unwritable | Ensure it matches the compose mount (`./logs:/home/ftr/Apps/Engram/logs`) |
| Recall flat (~0.34) | NULL embeddings (Nomic evicted) | Restart llama-swap with Nomic persistent; backfill with `scripts/backfill_embeddings.py` |
| Settings change "lost" | Used `docker compose restart` | Settings are in Postgres — they survive; `.env` changes need `docker compose up -d` |

## 7. Backup & Data

- **Postgres data**: `docker volume inspect engram_server_data` (also holds `app_settings`)
- **Engram logs**: `./logs/` directory (bind mount)
- **Redis data**: `docker volume inspect engram_redis_data`

```bash
docker exec engram-postgres-1 pg_dump -U postgres engram > engram-backup-$(date +%Y%m%d).sql
```
