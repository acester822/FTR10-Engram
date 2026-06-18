# Engram (FTR10 Engram)

A cognitive memory proxy that gives AI models persistent, project-aware context across sessions. It intercepts LLM API calls, embeds the query, recalls relevant memories from a local PostgreSQL vector store, silently injects them into the system prompt, and automatically extracts new facts from the conversation for future recall.

## Architecture

```
[ User IDE / CLI ]                    [ Linux Server ]              [ Upstream LLM (optional) ]
────────────────────    ────────────────────────    ───────────────────────────────────
                          ┌────────────────────────┐
                          │  Ollama (:11434)       │  ← qwen3.5:2b, qwen2.5:3b, qwen3-embedding:0.6b, bge-m3
                          │  PostgreSQL (:5432)    │  ← pgvector memory store (Genome/Phenotype)
                          │  Redis (:6379)         │  ← optional cache
                          └────────────────────────┘
                                  ▲ ▼
                         Engram Proxy (:8080 / :8098)
                                  ▲ ▼
                     http://100.108.182.121:8080/v1 (llama-swap, optional)
                                  ▼
                     Any OpenAI-compatible model
```

### How It Works

1. **Intercept** — User sends a prompt to `http://<server>:8098/v1/chat/completions`
2. **Embed & Recall** — Engram uses local Ollama to embed the query, then searches PostgreSQL for relevant memories (Genome = immutable facts, Phenotype = decaying context)
3. **Weave Context** — Relevant memories are silently injected into the system prompt with instructions to use them naturally
4. **Forward** — The enriched request is forwarded to an upstream LLM (llama-swap, OpenAI, etc.) for generation
5. **Stream** — Tokens stream back transparently to the client in real-time
6. **Extract** — After the response completes, the local generative model (`qwen3.5:2b`) extracts new facts from the conversation and saves them to PostgreSQL
7. **Compact** — When a conversation exceeds `EG_COMPACT_TRIGGER` messages, old history is summarized and thinned so the context window never grows unbounded
8. **Notify** — SSE status messages inform the user of injected memories and stored facts

### Memory Model (Genome / Phenotype)

Engram uses a biologically-inspired memory architecture:

- **Genome** — Immutable, foundational facts that never decay (e.g., "User prefers functional React components"). Always injected into every request.
- **Phenotype** — Decaying context retrieved via vector similarity search across 5 sectors:
  - `semantic` — Facts and domain knowledge
  - `procedural` — Code patterns and workflows
  - `episodic` — Events and specific interactions
  - `emotional` — User preferences, tone, sentiment
  - `reflective` — Meta-cognition and lessons learned

### Compaction Engine

When a conversation exceeds `EG_COMPACT_TRIGGER` messages (default: 50), the compaction engine runs in the background:

1. **Isolate** — Split into old history + a recent raw tail (`EG_MAX_RAW_TURNS`, default: 6)
2. **Thin** — Truncate oversized tool outputs, assistant responses, and user messages; remove consecutive duplicate tool calls
3. **Summarize & Extract** — One LLM call (`qwen3.5:2b`) produces a dense summary and durable facts
4. **Save Facts** — Extracted facts are saved to the Phenotype DB with `source: "compaction_engine"`
5. **Reconstruct** — The old history is replaced with `[COMPACTED SESSION SUMMARY]` plus the raw tail, so context never grows

If compaction fails, a hard-truncation fallback drops old history and inserts an error note.

### Consolidation Engine (The Hippocampus)

A background cron job that runs every 30 minutes to maintain knowledge base health:

1. Groups memories older than 7 days with `access_count >= 1` by `consolidation_hash`
2. Only processes groups with ≥3 related memories
3. Sends each group to the LLM (`qwen3.5:2b`) which decides whether to **merge**, **update**, **promote** to genome, or **delete** memories
4. Executes actions individually against the DB with per-action logging
5. If the LLM forgets to provide `new_content` for merge/update, a synthesis fallback (`qwen2.5:3b`) generates it automatically

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
| **ollama** | 11434 | Ollama LLM server (auto-pulls required models on startup) |
| **engram** | 8098 | Engram proxy — the main API endpoint |
| **ui** | 8099 | Web GUI (Vite + React) |

### Auto-Pulled Models

On container start, Ollama automatically pulls:

| Model | Purpose |
|---|---|
| `qwen3.5:2b` | Primary generative model — extraction, compaction, consolidation |
| `qwen2.5:3b` | Generative fallback model |
| `qwen3-embedding:0.6b` | Primary embedding model (all facets) |
| `bge-m3` | Embedding fallback model |

> **Note:** `qwen3.5:2b` should be running whenever Engram is running. Fallback models (`qwen2.5:3b`, `bge-m3`) should be downloaded but normally stay offline.

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

The proxy forwards requests to the upstream LLM configured via `EG_UPSTREAM_LLM_URL` (default: `http://100.108.182.121:8080/v1`).

## Configuration

Copy `.env.example` to `.env` and adjust as needed. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `EG_PORT` | `8080` | Server HTTP port (container) |
| `EG_STORAGE` | `postgres` | Storage backend (`postgres`, `sqlite`) |
| `EG_OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint for embeddings and generative tasks |
| `EG_UPSTREAM_LLM_URL` | `http://100.108.182.121:8080/v1` | Upstream LLM forwarding endpoint |
| `EG_MODEL_GENERATIVE` | `qwen3.5:2b` | Primary model for extraction, compaction, and consolidation |
| `EG_MODEL_GENERATIVE_FALLBACK` | `qwen2.5:3b` | Fallback generative model |
| `EG_MODEL_EMBEDDING` | `qwen3-embedding:0.6b` | Primary embedding model (all facets) |
| `EG_MODEL_EMBEDDING_FALLBACK` | `bge-m3` | Fallback embedding model |
| `EG_COMPACT_TRIGGER` | `50` | Message count that triggers compaction |
| `EG_MAX_RAW_TURNS` | `6` | Number of recent raw turns kept after compaction |
| `EG_API_KEY` | _(empty)_ | API key for auth (leave empty to disable) |
| `EG_REQUIRE_API_KEY` | `false` | Require API key for all requests |

For a full list, see `.env.example`.

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
ollama pull qwen3.5:2b
ollama pull qwen2.5:3b
ollama pull qwen3-embedding:0.6b
ollama pull bge-m3

# 5. Set environment variables (at minimum)
export EG_OLLAMA_URL=http://localhost:11434
export EG_UPSTREAM_LLM_URL=http://100.108.182.121:8080/v1
export EG_STORAGE=postgres
export EG_PG_HOST=localhost
export EG_PG_DB=engram

# 6. Start the server
cd packages/engram-js && EG_PORT=8080 npx nodemon src/server.ts
```

## Web GUI

The web interface is at `http://localhost:8099` (Docker) or `http://localhost:5173` (dev mode).

It provides:
- **Dashboard** — memory counts, genome/phenotype breakdown, sector/tier stats
- **Memory Explorer** — search, edit, and delete stored memories
- **Server Logs** — live, auto-refreshing Pino logs with module and model annotations
- **Performance** — CPU, memory, disk, Ollama cache, and GPU metrics

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
│   │   └── services/         # Memory logger, compaction engine, consolidation engine, memory injector
│   ├── Dockerfile
│   └── tsconfig.json
├── apps/web/                 # Web GUI (Vite + React)
│   ├── src/
│   └── Dockerfile
├── apps/vscode-extension/    # VS Code extension (EngramVS)
│   └── src/
├── docker-compose.yml        # Full stack orchestration
├── .env.example              # Environment variable reference
├── docs/model-breakdowns.md  # Model selection & wiring guide
├── docs/compaction.engine.md # Compaction engine design document
└── readme.md                 # This file
```

## API Overview

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | OpenAI-compatible chat endpoint with memory injection |
| `GET /health` | Health check |
| `GET /api/dashboard/stats` | Dashboard stats |
| `GET /api/dashboard/memories` | List memories |
| `GET /api/dashboard/log` | Server log lines |
| `POST /api/dashboard/log/clear` | Clear server log file |
| `POST /api/dashboard/consolidate` | Trigger consolidation manually |
| `GET /api/dashboard/perf` | Server + Ollama performance metrics |

## Troubleshooting

- **Models not loading** — Check Ollama health: `curl http://localhost:11434`. Verify `qwen3.5:2b` and `qwen3-embedding:0.6b` are available with `ollama list` inside the container.
- **Server won't start** — Verify PostgreSQL is running and port 8098 is free (`lsof -i :8098`). Check logs: `docker compose logs engram`.
- **Cannot reach upstream LLM** — Confirm `EG_UPSTREAM_LLM_URL` points to your GPU machine or provider endpoint.
- **Consolidation not running** — The cron runs every 30 minutes. Trigger manually via `POST /api/dashboard/consolidate`. Memories must be older than 7 days, have `access_count >= 1`, and share a `consolidation_hash` (≥3 per group).
- **Compaction not triggering** — Compaction runs when a conversation exceeds `EG_COMPACT_TRIGGER` (default: 50). Check server logs for the `compactionEngine` module.
- **Migration fails** — Ensure PostgreSQL is running and the database exists before starting the server. Migrations run automatically on startup.

## Naming

The project was previously called **OpenMemory** and **CodeCortex**. The official name is **FTR10 Engram**. The server/package is **Engram**, the web interface is the **Engram Web GUI**, and the VS Code extension is **EngramVS**.
