# Engram (FTR10 Engram)

A cognitive memory proxy that gives AI models persistent, project-aware context across sessions. It intercepts LLM API calls, injects relevant memories from a local PostgreSQL vector store, and automatically extracts new facts from conversations for future recall.

## Architecture

```
[ User IDE / CLI ]                    [ Linux Server ]              [ MSI Raider (10.10.10.41) ]
─────────────────────    ────────────────────────    ───────────────────────────────────
                         ┌────────────────────────┐
                         │  Ollama (:11434)       │  ← qwen2.5:3b (extraction)
                         │  PostgreSQL (:5432)    │  ← pgvector memory store
                         │  Redis (:6379)         │  ← optional cache
                         └────────────────────────┘
                                 ▲ ▼
                         Engram Proxy (:8080)
                                 ▲ ▼
                         http://10.10.10.41:8080/v1
                                 ▼
                    llama-swap → Qwopus3.6 (RTX 4090 VRAM)
```

### How It Works

1. **Intercept** — User sends a prompt to `http://<server>:8098/v1/chat/completions`
2. **Embed & Recall** — Engram uses local Ollama (`bge-m3`) to embed the query, then searches PostgreSQL for relevant memories (Genome = immutable facts, Phenotype = decaying context)
3. **Weave Context** — Relevant memories are silently injected into the system prompt with instructions to use them naturally
4. **Forward** — The enriched request is forwarded to llama-swap on your GPU machine (`10.10.10.41:8080/v1`) for generation
5. **Stream** — Tokens stream back transparently to the client in real-time
6. **Extract** — After the response completes, a tiny local model (`qwen2.5:3b`) extracts new facts from the conversation and saves them to PostgreSQL
7. **Notify** — SSE status messages inform the user of injected memories and stored facts

## Quick Start (Docker)

```bash
# Pull models, build, and start everything
docker compose up --build -d

# Check status
docker compose ps

# View logs
docker compose logs -f engram
```

### Services

| Service | Port | Description |
|---------|------|-------------|
| **postgres** | 5432 | PostgreSQL with pgvector extension — memory storage |
| **redis** | 6379 | Redis — optional cache / valkey storage |
| **ollama** | 11434 | Ollama LLM server (qwen2.5:3b + bge-m3, auto-pinned) |
| **engram** | 8098 | Engram proxy — the main API endpoint |
| **ui** | 8099 | Web GUI (Vite preview) |

### Stop & Clean

```bash
# Stop all services
docker compose down

# Stop and remove all data volumes (fresh start)
docker compose down -v
```

## Client Configuration

Point your IDE / CLI to the Engram proxy:

```
http://<your-server-ip>:8098/v1
```

The proxy forwards requests to llama-swap at `http://10.10.10.41:8080/v1` for actual model generation.

## Configuration

Copy `.env.example` to `.env` and adjust as needed. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `EG_PORT` | `8080` | Server HTTP port (container) |
| `EG_STORAGE` | `postgres` | Storage backend (`postgres`, `memory`, `sqlite`) |
| `EG_EMBEDDINGS` | `ollama` | Embedding provider |
| `EG_OLLAMA_MODEL` | `bge-m3` | Ollama embedding model |
| `CONSOLIDATION_MODEL` | `qwen2.5:3b` | LLM for memory consolidation |
| `EXTRACTION_MODEL` | `qwen2.5:3b` | LLM for async fact extraction |
| `LLAMA_URL` | `http://10.10.10.41:8080/v1` | Upstream llama-swap endpoint |
| `EG_VECTOR_STORE` | `postgres` | Vector store backend |
| `EG_API_KEY` | _(empty)_ | API key for auth (leave empty to disable) |

## Local Development (No Docker)

```bash
# 1. Start PostgreSQL locally and create the database
sudo systemctl start postgresql
psql -U postgres -c "CREATE DATABASE engram;"

# 2. Install dependencies
npm install

# 3. Run migrations
npx tsx packages/engram-js/src/database/migrate.ts

# 4. Start Ollama locally and pull models
ollama serve &
ollama pull bge-m3
ollama pull qwen2.5:3b

# 5. Set environment variables (at minimum)
export OLLAMA_URL=http://localhost:11434
export LLAMA_URL=http://10.10.10.41:8080/v1
export EG_STORAGE=postgres
export EG_PG_HOST=localhost
export EG_PG_DB=engram

# 6. Start the server
cd packages/engram-js && EG_PORT=8080 npx nodemon src/server.ts
```

## Web GUI

The web interface is at `http://localhost:8099` (Docker) or `http://localhost:5173` (dev mode).

### Dev Mode

```bash
cd apps/web && npm run dev
```

### Production Build

```bash
cd apps/web && npm run build
```

## Project Structure

```
Engram/
├── packages/engram-js/   # Engram proxy server
│   ├── src/
│   │   ├── api/routes/       # HTTP routes (chat completions, health, etc.)
│   │   ├── configuration/    # Environment parsing & config loading
│   │   ├── durable/          # PostgreSQL memory repository
│   │   ├── embeddings/       # Embedding providers (Ollama, OpenAI, etc.)
│   │   └── services/         # Memory logger, consolidation engine
│   ├── Dockerfile
│   └── tsconfig.json
├── apps/web/                 # Web GUI (Vite + React)
│   ├── src/
│   └── Dockerfile
├── docker-compose.yml        # Full stack orchestration
├── preload-models.sh         # Model preloading script (auto-run on startup)
├── .env.example              # Environment variable reference
├── build.md                  # Detailed build & run guide
└── readme.md                 # This file
```

## Troubleshooting

- **Models not loading** — Check Ollama health: `curl http://localhost:11434`. Models are auto-pulled on startup via the server entrypoint.
- **Server won't start** — Verify PostgreSQL is running and port 8098 is free (`lsof -i :8098`).
- **Cannot reach llama-swap** — Confirm `LLAMA_URL` points to your GPU machine (default: `http://10.10.10.41:8080/v1`).
- **Migration fails** — Ensure PostgreSQL is running and the database exists before starting the server.

## Naming

The project was previously called "Engram" / "Engram". The official name is **FTR10 Engram**. The server binary/package is **Engram**, and the VS Code extension (when ready) will be **EngramVS**.
