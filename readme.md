# Engram (FTR10 Engram)

A cognitive memory proxy that gives AI models persistent, project-aware context across sessions. It intercepts LLM API calls, injects relevant memories from a local PostgreSQL vector store, and automatically extracts new facts from conversations for future recall.

## Architecture

```
[ User IDE / CLI ]                    [ Linux Server ]              [ Upstream LLM (optional) ]
────────────────────    ────────────────────────    ───────────────────────────────────
                         ┌────────────────────────┐
                         │  Ollama (:11434)       │  ← qwen2.5:7b + :14b, bge-m3, nomic-embed-text, all-MiniLM-L6-v2
                         │  PostgreSQL (:5432)    │  ← pgvector memory store (Genome/Phenotype)
                         │  Redis (:6379)         │  ← optional cache
                         └────────────────────────┘
                                 ▲ ▼
                        Engram Proxy (:8080 / :8098)
                                 ▲ ▼
                    http://10.10.10.41:8080/v1 (llama-swap, optional)
                                 ▼
                    Qwopus3.6 / any OpenAI-compatible model
```

### How It Works

1. **Intercept** — User sends a prompt to `http://<server>:8098/v1/chat/completions`
2. **Embed & Recall** — Engram uses local Ollama to embed the query, then searches PostgreSQL for relevant memories (Genome = immutable facts, Phenotype = decaying context)
3. **Weave Context** — Relevant memories are silently injected into the system prompt with instructions to use them naturally
4. **Forward** — The enriched request is forwarded to llama-swap on your GPU machine (`10.10.10.41:8080/v1`) for generation (or local Ollama if no upstream)
5. **Stream** — Tokens stream back transparently to the client in real-time
6. **Extract** — After the response completes, a tiny local model (`qwen2.5:7b`) extracts new facts from the conversation and saves them to PostgreSQL
7. **Notify** — SSE status messages inform the user of injected memories and stored facts

### Memory Model (Genome / Phenotype)

Engram uses a biologically-inspired memory architecture:

- **Genome** — Immutable, foundational facts that never decay (e.g., "User prefers functional React components"). Always injected into every request.
- **Phenotype** — Decaying context retrieved via vector similarity search across 5 sectors:
  - `semantic` — Facts and domain knowledge (`bge-m3`)
  - `procedural` — Code patterns and workflows (`nomic-embed-text`)
  - `episodic` — Events and specific interactions (`bge-m3`)
  - `emotional` — User preferences, tone, sentiment (`all-MiniLM-L6-v2`)
  - `reflective` — Meta-cognition and lessons learned (`bge-m3`)

### Consolidation Engine (The Hippocampus)

A background cron job that runs every 30 minutes to maintain knowledge base health:

1. Groups memories older than 7 days by `consolidation_hash`
2. Only processes groups with ≥3 related memories
3. Sends each group to the LLM (`qwen2.5:14b`) which decides whether to **merge**, **update**, **promote** to genome, or **delete** memories
4. Executes actions individually against the DB with per-action logging
5. If the LLM forgets to provide `new_content` for merge/update, a synthesis fallback (`qwen2.5:7b`) generates it automatically

Manual trigger via UI dashboard or API: `POST /api/dashboard/consolidate`

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
| **ollama** | 11434 | Ollama LLM server (auto-pulls all required models on startup) |
| **engram** | 8098 | Engram proxy — the main API endpoint |
| **ui** | 8099 | Web GUI (Vite preview) |

### Auto-Pulled Models

On container start, Ollama automatically pulls:

| Model | Purpose |
|---|---|
| `qwen2.5:7b` | Extraction model — parsing transcripts into JSON memories |
| `qwen2.5:14b` | Consolidation model — higher-order reasoning for merge/update/promote/delete decisions |
| `bge-m3` | Primary embedding model (universal default) |
| `nomic-embed-text` | Procedural facet override (code-focused embeddings) |
| `all-MiniLM-L6-v2` | Emotional facet override (ultra-lightweight for short preference snippets) |

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

The proxy forwards requests to llama-swap at `http://10.10.10.41:8080/v1` for actual model generation (configurable via `EG_UPSTREAM_LLM_URL`).

## Configuration

Copy `.env.example` to `.env` and adjust as needed. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `EG_PORT` | `8080` | Server HTTP port (container) |
| `EG_STORAGE` | `postgres` | Storage backend (`postgres`, `sqlite`) |
| `EG_EMBEDDINGS` | `ollama` | Embedding provider |
| `EG_EMBED_MODEL` | `bge-m3` | Universal embedding model fallback |
| `EG_OLLAMA_EPISODIC_MODEL` | `bge-m3` | Episodic memories embedding model |
| `EG_OLLAMA_SEMANTIC_MODEL` | `bge-m3` | Semantic memories embedding model |
| `EG_OLLAMA_PROCEDURAL_MODEL` | `nomic-embed-text` | Procedural (code) embedding model |
| `EG_OLLAMA_EMOTIONAL_MODEL` | `all-MiniLM-L6-v2` | Emotional (preference) embedding model |
| `EG_OLLAMA_REFLECTIVE_MODEL` | `bge-m3` | Reflective memories embedding model |
| `EG_CONSOLIDATION_MODEL` | `qwen2.5:14b` | LLM for memory consolidation reasoning |
| `EG_EXTRACTION_MODEL` | `qwen2.5:7b` | LLM for async fact extraction from conversations |
| `EG_UPSTREAM_LLM_URL` | `http://10.10.10.41:8080/v1` | Upstream LLM forwarding endpoint (llama-swap) |
| `EG_VECTOR_STORE` | `postgres` | Vector store backend |
| `EG_API_KEY` | _(empty)_ | API key for auth (leave empty to disable) |

> **💡 Pro Tip:** For 95% of use cases, leaving `EG_EMBED_MODEL=bge-m3` as the universal default is the most robust and resource-efficient choice. Only set per-facet overrides if you need specialized embeddings for specific memory types.

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
ollama pull qwen2.5:7b
ollama pull qwen2.5:14b
ollama pull nomic-embed-text

# 5. Set environment variables (at minimum)
export OLLAMA_URL=http://localhost:11434
export EG_UPSTREAM_LLM_URL=http://10.10.10.41:8080/v1
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
│   │   ├── api/routes/       # HTTP routes (chat completions, health, dashboard)
│   │   ├── configuration/    # Environment parsing & config loading
│   │   ├── durable/          # PostgreSQL memory repository & schema migrations
│   │   ├── embeddings/       # Embedding providers (Ollama, OpenAI, Gemini, AWS, Siray)
│   │   └── services/         # Memory logger, consolidation engine, memory injector
│   ├── Dockerfile
│   └── tsconfig.json
├── apps/web/                 # Web GUI (Vite + React)
│   ├── src/
│   └── Dockerfile
├── docker-compose.yml        # Full stack orchestration
├── .env.example              # Environment variable reference
├── docs/model-breakdowns.md  # Model recommendations & wiring guide
└── readme.md                 # This file
```

## Troubleshooting

- **Models not loading** — Check Ollama health: `curl http://localhost:11434`. Models are auto-pulled on startup via the server entrypoint. Verify with `ollama list` inside the container.
- **Server won't start** — Verify PostgreSQL is running and port 8098 is free (`lsof -i :8098`). Check logs: `docker compose logs engram`.
- **Cannot reach upstream LLM** — Confirm `EG_UPSTREAM_LLM_URL` points to your GPU machine (default: `http://10.10.10.41:8080/v1`).
- **Consolidation not running** — The cron runs every 30 minutes. Trigger manually via `POST /api/dashboard/consolidate`. Memories must be older than 7 days and grouped by `consolidation_hash` (≥3 per group).
- **Migration fails** — Ensure PostgreSQL is running and the database exists before starting the server. Migrations run automatically on startup.

## Naming

The project was previously called "CodeCortex". The official name is **FTR10 Engram**. The server/package is **Engram**, and the VS Code extension (when ready) will be **EngramVS**.
