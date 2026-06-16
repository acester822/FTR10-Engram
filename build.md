# Build & Run Guide — CodeCortex (FTR10 OpenMemory)

## Prerequisites

- **Node.js 20+** (`node --version`)
- **npm 9+** (`npm --version`)
- **Docker + Docker Compose** (for containerized deployment with Ollama)
- **PostgreSQL 15+** (only for local dev — Docker handles it automatically)

---

## Quick Start (All-in-One — Docker)

```bash
# Build and start everything. Models are auto-pulled on first run.
docker compose up --build -d

# Check health of all services
docker compose ps

# Follow server logs
docker compose logs -f openmemory
```

Services will be available at:

| Service | Port (host) | Description |
|---------|-------------|-------------|
| postgres | 5432 | PostgreSQL with pgvector — memory storage |
| redis | 6379 | Redis — optional cache / valkey storage |
| ollama | 11434 | Ollama LLM server (qwen2.5:3b + bge-m3, auto-pinned) |
| openmemory | 8098 | CodeCortex Node.js proxy |
| ui | 8099 | Web GUI (Vite preview) |

### Stop Everything

```bash
docker compose down
```

### Clean Data Volumes

```bash
docker compose down -v   # removes postgres_data, redis_data, server_data, ollama_data volumes
```

### Rebuild when changes to source are made:
```bash
cd /home/ftr/Documents/openWeb.searxng/OpenMemory && docker compose up -d --build openmemory 2>&1
```

---

## Quick Start (Local Dev — No Docker)

```bash
# 1. Install dependencies
npm install

# 2. Run database migrations
npx tsx packages/openmemory-js/src/database/migrate.ts

# 3. Set environment variables
export OLLAMA_URL=http://localhost:11434
export LLAMA_URL=http://10.10.10.41:8080/v1
export OM_STORAGE=postgres
export OM_PG_HOST=localhost
export OM_PG_DB=openmemory

# 4. Start the server in dev mode
OM_PORT=8080 npx nodemon packages/openmemory-js/src/server.ts
```

Server will be available at `http://localhost:8080`.

---

## Server (`packages/openmemory-js`)

### Dev Mode (hot-reload)

```bash
cd packages/openmemory-js
OM_PORT=8080 npx nodemon src/server.ts
```

Or from the workspace root:

```bash
npm run dev
```

### Production Build & Start

```bash
# Build
npm run build

# Run built server
npm run start
```

Or from the workspace root:

```bash
npm run build && npm run start
```

Server listens on port `8080` (controlled by `OM_PORT`). Health check at `http://localhost:8080/health`.

### Stop the Server

Press `Ctrl+C` in the terminal running the server. Or kill by PID/port:

```bash
lsof -ti :8080 | xargs kill -9
```

---

## Web GUI (`apps/web`)

### Dev Mode (Vite HSR)

```bash
cd apps/web
npm run dev
```

Runs at `http://localhost:5173` by default. Connects to the server via `VITE_OM_API_URL`.

### Production Build

```bash
cd apps/web
npm run build
```

Output goes to `apps/web/dist/`. Preview locally with:

```bash
npm run preview
```

---

## Database (PostgreSQL)

The project uses PostgreSQL as its primary storage backend. Default credentials from `.env.example`:

| Setting | Default |
|---------|---------|
| Host | `localhost` |
| Port | `5432` |
| DB | `openmemory` |
| User | `postgres` |
| Password | `postgres` |

### Start PostgreSQL (Linux)

```bash
sudo systemctl start postgresql
# or
pg_ctlcluster 16 main start   # Debian/Ubuntu with pgdg
```

### Create the Database

```sql
CREATE DATABASE openmemory;
GRANT ALL PRIVILEGES ON DATABASE openmemory TO postgres;
```

### Run Migrations

```bash
cd packages/openmemory-js
npx tsx src/database/migrate.ts
```

---

## Ollama (Local LLM — qwen2.5:3b + bge-m3)

CodeCortex uses two Ollama models: **qwen2.5:3b** (fact extraction / consolidation) and **bge-m3** (embeddings).

### Docker Mode (auto-pulled & pinned)

Both models are automatically pulled from the server entrypoint on startup, then pinned indefinitely via `OLLAMA_KEEP_ALIVE=-1` so they never unload from RAM/VRAM. No manual intervention needed.

### Local Mode

```bash
# Start Ollama
ollama serve &

# Pull required models
ollama pull bge-m3          # embeddings
ollama pull qwen2.5:3b      # fact extraction (tiny model)

# Stop Ollama
pkill -f ollama
```

---

## Configuration

Copy `.env.example` to `.env` and adjust as needed:

```bash
cp .env.example .env
```

Key environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `OM_PORT` | `8080` | Server HTTP port (container) |
| `OM_STORAGE` | `postgres` | Storage backend (`postgres`, `memory`, `sqlite`) |
| `OM_EMBEDDINGS` | `ollama` | Embedding provider |
| `OM_OLLAMA_MODEL` | `bge-m3` | Ollama embedding model |
| `CONSOLIDATION_MODEL` | `qwen2.5:3b` | LLM for memory consolidation |
| `EXTRACTION_MODEL` | `qwen2.5:3b` | LLM for async fact extraction |
| `LLAMA_URL` | `http://10.10.10.41:8080/v1` | Upstream llama-swap endpoint (main models) |
| `OM_VECTOR_STORE` | `postgres` | Vector store backend |
| `OM_API_KEY` | _(empty)_ | API key for auth (leave empty to disable) |

---

## Makefile Commands

```bash
make help    # List available commands
make install # npm install workspace dependencies
make dev     # Start JS server in development mode
make build   # Build JS package
make start   # Start built JS server
make clean   # Remove JS build output (dist/)
```

---

## Troubleshooting

- **Migration fails** — Ensure PostgreSQL is running and the `openmemory` database exists.
- **Server won't start on port 8098** — Check with `lsof -i :8098` for conflicts.
- **Models not loading** — Verify Ollama health: `curl http://localhost:11434`. Models are auto-pulled and pinned via the server entrypoint (`OLLAMA_KEEP_ALIVE=-1`).
- **Cannot reach llama-swap** — Confirm `LLAMA_URL` points to your GPU machine (default: `http://10.10.10.41:8080/v1`).
- **Web GUI can't reach server** — Confirm the server is running and CORS headers are set (default allows `*`).
