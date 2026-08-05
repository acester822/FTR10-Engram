# Build & Run Guide — Engram (FTR10 Engram)

## Prerequisites

- **Node.js 20+** (`node --version`)
- **npm 9+** (`npm --version`)
- **Docker + Docker Compose** (for the containerized deployment)
- **PostgreSQL 15+** (only for local dev — Docker handles it automatically)

---

## Quick Start (All-in-One — Docker)

```bash
# Build and start everything (models are NOT auto-pulled — they live on the LLM box)
docker compose up -d --build

# Check health of all services
docker compose ps

# Follow server logs
docker compose logs -f engram
```

Services will be available at:

| Service | Port (host) | Description |
|---------|-------------|-------------|
| postgres | 5432 | PostgreSQL with pgvector — memory + settings storage |
| redis | 6379 | Redis — optional cache / valkey storage |
| engram | 8098 | Engram API + OpenAI-compatible proxy |
| web | 8099 | Web GUI (Settings tab = configuration source of truth) |

**No shell exports needed** — the LLM-box URLs come straight from `.env` (see Configuration).

### Stop Everything

```bash
docker compose down
```

### Clean Data Volumes

```bash
docker compose down -v   # removes server_data volume etc.
```

### Rebuild when source changes

```bash
docker compose build engram web && docker compose up -d engram web
```

---

## Quick Start (Local Dev — No Docker)

```bash
# 1. Install dependencies (workspace root)
npm install

# 2. Set the required env vars (the must-have set from .env / .env.example):
#    LLM box URLs, EG_PG_*, EG_REDIS_URL, EG_LOG_DIR, EG_INTERNAL_API_KEY…
#    Models/providers are then configured in the GUI Settings tab.

# 3. Start the server in dev mode
cd packages/engram-js && EG_PORT=8080 HOST=0.0.0.0 npx tsx src/server.ts
```

Server will be available at `http://localhost:8080` (health check: `/health`).

---

## Server (`packages/engram-js`)

### Dev Mode

```bash
cd packages/engram-js
EG_PORT=8080 HOST=0.0.0.0 npx tsx src/server.ts
```

### Production Build & Start

```bash
cd packages/engram-js
npm run build   # tsc -> dist/
npm run start   # node dist/server.js
```

Server listens on `EG_PORT` (default `8080`). Health check at `http://localhost:8080/health`.

### Stop the Server

Press `Ctrl+C` in the terminal running the server. Or kill by PID/port:

```bash
lsof -ti :8080 | xargs kill -9
```

---

## Web GUI (`apps/web`)

### Dev Mode (Vite)

```bash
cd apps/web
npm run dev
```

Runs at `http://localhost:5173` by default; its `vite.config.ts` proxies `/api` → `http://localhost:8080`.

### Production Build

```bash
cd apps/web
npm run build    # tsc -b && vite build -> dist/
```

---

## Database (PostgreSQL)

Primary storage backend; the app also keeps user configuration in the `app_settings` table. Credentials come from `.env` (`EG_PG_*`; compose sets `EG_PG_HOST=postgres` on the Docker network).

### Run Migrations (idempotent; also runs automatically at boot)

```bash
cd packages/engram-js
npx tsx src/database/migrate.ts
```

---

## LLM Box (llama-swap)

Generative + embedding models run on a separate GPU box via **llama-swap** at
`http://10.10.10.41:8080/v1` (configured in the GUI Settings tab → Provider, or via
`EG_GENERATIVE_URL` / `EG_UPSTREAM_LLM_URL` / `EG_OPENAI_BASE_URL` in `.env`).

Deployed models: `LFM2.5-1.2B-Instruct` (generative), `nomic-embed-text-v1.5`
(embedding, 768-dim; procedural facet: `CodeRankEmbed`). The Nomic embed model must stay
loaded (llama-swap `persistent` group) or recall degrades to ~0.34 flat scoring.

---

## Configuration

**The web GUI Settings tab is the single source of truth** for providers, models,
general tuning (rate limits, compaction, auto-search, consolidation tiers), and shows
read-only advanced values. It is persisted in Postgres (`app_settings`) and applied at boot.

`.env` holds ONLY the values that cannot be GUI-edited (read at startup before the
settings store is available, or consumed by compose):

| Variable | Purpose |
|----------|---------|
| `EG_GENERATIVE_URL` / `EG_UPSTREAM_LLM_URL` / `EG_OPENAI_BASE_URL` | LLM-box base URLs (`http://10.10.10.41:8080/v1`) |
| `EG_OPENAI_API_KEY` | Provider auth key |
| `EG_PG_HOST` / `EG_PG_PORT` / `EG_PG_DB` / `EG_PG_USER` / `EG_PG_PASSWORD` / `EG_PG_SCHEMA` / `EG_PG_SSL` | Postgres connection (startup) |
| `EG_REDIS_URL` | Redis connection (startup) |
| `EG_LOG_DIR` / `EG_LOG_MAX_LINES` / `LOG_LEVEL` | Logging (logger reads at static import) |
| `EG_INTERNAL_API_KEY` / `NODE_ENV` | Internal auth / runtime mode |

Do NOT add model/tuning variables to `.env` — they belong in the Settings tab.

---

## Troubleshooting

- **Migration fails** — Ensure PostgreSQL is running and the `engram` database exists.
- **Server won't start on port 8098** — Check with `lsof -i :8098` for conflicts.
- **Cannot reach llama-swap** — Confirm the Provider settings (or `EG_GENERATIVE_URL`) point at your GPU machine (`http://10.10.10.41:8080/v1`); use the Settings tab's **Test & Save** button to verify a section live.
- **Recall scores flat (~0.34)** — The Nomic embed model was evicted from llama-swap; keep it in the `persistent` group and restart llama-swap.
- **Consolidation failing** — Check the server log for "Consolidation LLM failed"; the engine chunks at ≤150 memories/call and requires a valid generative model in Settings.
- **No logs in the GUI** — Confirm `EG_LOG_DIR` in `.env` points at a writable/mounted dir (default compose mount: `./logs:/home/ftr/Apps/Engram/logs`).
- **Web GUI can't reach server** — Confirm the server is running and CORS headers allow it (dev default allows `*`).
