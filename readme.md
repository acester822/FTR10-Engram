# Engram — Persistent Memory for AI Agents

A cognitive memory proxy that gives LLMs **persistent, project-aware context** across sessions. Intercept API calls, embed queries locally, recall relevant memories from a PostgreSQL vector store, silently inject them into the system prompt, and automatically extract new facts from conversations for future recall.

> 🧠 *Your AI assistant remembers everything — without bloating context windows.*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)]()
[![Node.js](https://img.shields.io/badge/Node.js-20+-43853D?logo=node.js&logoColor=white)]()
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Ollama](https://img.shields.io/badge/Ollama-Latest-4C5A6B?logo=data:image/svg+xml;base64,PHN2ZyB0bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXBjg9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjwYXRoIGQ9Ik04IDJ2MmgtNFYyaDR6bTEyIDB2NGgydi0yaC0yeiIvPjwvc3ZnPg==)](https://ollama.com/)
[![Docker](https://img.shields.io/badge/Docker-Compose-blue?logo=docker&logoColor=white)]()

---

## Table of Contents

- [Architecture](#architecture)
- [How It Works](#how-it-works)
- [Memory Model](#memory-model-genome--phenotype)
- [Compaction Engine](#compaction-engine)
- [Consolidation Engine (The Hippocampus)](#consolidation-engine-the-hippocampus)
- [Memory Decay Engine](#memory-decay-engine)
- [Durable Memory System](#durable-memory-system)
- [Quick Start (Docker)](#quick-start-docker)
- [Client Configuration](#client-configuration)
- [Configuration](#configuration)
- [Local Development (No Docker)](#local-development-no-docker)
- [Web GUI](#web-gui)
- [API Overview](#api-overview)
- [Troubleshooting](#troubleshooting)

---

## Architecture

<p align="center">
  <img src="docs/assets/architecture.svg" alt="Engram architecture diagram" width="820">
</p>

> 📐 **Editable source:** [`docs/assets/architecture.excalidraw`](docs/assets/architecture.excalidraw) — drag it onto [excalidraw.com](https://excalidraw.com) (or open with the Excalidraw VS Code extension) to edit. Hand-authored Excalidraw diagram; the original Mermaid source is kept below for reference.

<details>
<summary>Mermaid source</summary>

```mermaid
flowchart TD
    subgraph Client["👤 User Workspace (IDE / CLI)"]
        IDE[VS Code · Cursor · Cline · Terminal]
    end

    subgraph Engram["🖥️ Engram Proxy (:8098) — The Brain"]
        S1[Intercept Request] --> S2[Embed via Ollama/OpenAI]
        S2 --> S3[Query PostgreSQL]
        S3 --> S4[Weave Context]
        S4 --> S5[SSE: Injected X memories]
        S4 --> S6[Forward to Upstream LLM]
    end

    subgraph Upstream["🚀 Upstream LLM (llama-swap / OpenAI) — The Muscle"]
        U1[Generate Response] --> U2[Stream Tokens]
    end

    subgraph LocalServices["🔧 Local Services (:11434 · :5432 · :6379)]
        Ollama[Ollama\nqwen3.5:2b · qwen3-embedding:0.6b]
        Postgres[PostgreSQL + pgvector\nGenome / Phenotype DB]
        Redis[Redis Cache]
    end

    subgraph Background["⚙️ Background Engines"]
        C1[Compaction Engine] --> C2[Consolidation Cron]
    end

    IDE -->|"POST /v1/chat/completions"| S1
    S2 -.-> Ollama
    S3 -.-> Postgres
    S6 --> U1
    U2 -->|Stream tokens back| S4
    S5 -.->|SSE update| IDE
    U2 -->|Accumulate transcript| B1[Extract Facts\nconfig-driven model]
    B1 -->|Save new memories| Postgres
    B1 -->|SSE status| IDE

    C1 -.->|"Triggered at EG_COMPACT_TRIGGER"| Postgres
    C2 -.->|"Every 30 min"| Postgres
```

</details>

---

## How It Works

1. **Intercept** — User sends a prompt to `http://<server>:8098/v1/chat/completions` (OpenAI-compatible endpoint)
2. **Embed & Recall** — Engram uses the configured embedding model (e.g. `nomic-embed-text-v1.5` via `EG_EMBED_MODEL`) or OpenAI provider to embed the query, then searches PostgreSQL for relevant memories across 5 sectors
3. **Weave Context** — Relevant memories are silently injected into the system prompt with instructions to use them naturally in responses
4. **Forward** — The enriched request is forwarded to an upstream LLM (llama-swap, OpenAI, Gemini, Siray) for generation
5. **Stream** — Tokens stream back transparently to the client in real-time via SSE
6. **Extract** — After the response completes, the generative model extracts new facts from the conversation and saves them to PostgreSQL
7. **Compact** — When a conversation exceeds `EG_COMPACT_TRIGGER` messages (code default: 25), old history is summarized and thinned so context windows never grow unbounded
8. **Notify** — SSE status messages inform the user of injected memories and stored facts

> **Two ways to run Engram**
>
> - **Standalone proxy (above)** — A client (IDE, CLI, VS Code) points at `:8098/v1/chat/completions`; Engram embeds/recalls/weaves, forwards to the upstream LLM, streams, compacts, and emits SSE. This is the flow documented above.
> - **Hermes sidecar (Option B)** — When Engram is wired into [Hermes Agent](https://github.com/NousResearch/Hermes) as a native memory-provider plugin, Engram is **not** the chat proxy. Hermes talks directly to its own LLM (OpenRouter); Engram is a sidecar *memory + cognition engine* reached only via HTTP:
>   - **Before each turn** → `prefetch()` injects cached genome directives + phenotype recall (`POST /recall`) into the user message as a `<memory-context>` block.
>   - **After each turn** → `sync_turn()` hands the **full turn** (user msg + assistant reply + tool I/O) to `POST /ingest/conversation` so Engram's own extraction LLM decides what to store (genome vs phenotype, sector, decay). Hermes never pre-filters.
>   - Engram's chat proxy, compaction engine, and auto-search are **not** used in this mode (Hermes already does orchestration + compression + web search). Consolidation / decay / contradiction are exposed as `engram_consolidate` / `engram_decay` / `engram_contradiction` tools and run on session end.
>   - The plugin lives at `~/.hermes/plugins/engram/` (`plugin.yaml` + `__init__.py`); activate with `hermes config set memory.provider engram`. No MCP server — stdlib `urllib` only.
>
> In sidecar mode, observability is the built-in **Web GUI** (`apps/web`, port 8099) — its Activity tab shows live `recall` (reads) and `ingest`/`memories` (writes) traffic, which is the concrete way to confirm the integration is live.

## Memory Model: Genome & Phenotype

Engram uses a biologically-inspired memory architecture with two distinct layers:

| Layer | Behavior | Description |
|-------|----------|-------------|
| 🧬 **Genome** | Immutable, never decays | Foundational facts that are always injected (e.g., *"User prefers functional React components"*) |
| 🔬 **Phenotype** | Decaying context via vector search | Context retrieved by similarity across 5 sectors: |

### Phenotype Sectors

| Sector | Type | Example |
|--------|------|---------|
| 📖 `semantic` | Facts & domain knowledge | *"PostgreSQL uses pgvector for embeddings"* |
| ⚙️ `procedural` | Code patterns & workflows | *"Auth middleware validates JWT tokens before route handlers"* |
| 🎬 `episodic` | Events & specific interactions | *"User debugged the Docker compose setup on March 15"* |
| 💭 `emotional` | Preferences, tone, sentiment | *"User prefers concise, no-nonsense explanations"* |
| 🔍 `reflective` | Meta-cognition & lessons learned | *"When debugging Docker networking, always check subnet conflicts first"* |

---

## Compaction Engine

When a conversation exceeds the message threshold (`EG_COMPACT_TRIGGER`, code default: **50**, `.env.example` overrides to **100**), the compaction engine runs in the background to keep context windows bounded:

1. **Isolate** — Split into old history + a recent raw tail (`EG_MAX_RAW_TURNS`, default: 6, `.env.example` = 4)
2. **Thin** — Truncate oversized tool outputs (>800 chars), assistant responses (>1200 chars), and user messages (>1000 chars); remove consecutive duplicate tool calls
3. **Summarize & Extract** — One LLM call (model: `env.generative_model` from config) produces a dense summary AND durable facts in JSON format
4. **Save Facts** — Extracted facts are tagged with `source: "compaction_engine"` and saved to the Phenotype DB via the recursive learning loop
5. **Reconstruct** — The old history is replaced with `[COMPACTED SESSION SUMMARY]` plus the raw tail, so context never grows

> If compaction fails for any reason, it drops old history silently and keeps only the raw tail to preserve conversation continuity.

---

## Consolidation Engine (The Hippocampus)

A background cron job that runs every **30 minutes** to maintain knowledge base health — merging related memories, promoting important ones, and pruning obsolete facts:

1. **Fetch Groups** — Queries memories older than 7 days with `access_count >= 1`, grouped by `consolidation_hash` (minimum 3 members per group)
2. **Generate Actions** — Sends each group to the generative model which decides whether to **merge**, **update**, **promote to genome**, or **delete** memories
3. **Execute Actions** — Applies each action individually against the DB with per-action logging and transaction rollback on failure
4. **Synthesis Fallback** — If the LLM omits `new_content` during merge/update, a synthesis model (`env.fallback_model`) generates it automatically

Manual trigger via API: `POST /api/dashboard/consolidate`

---

## Memory Decay Engine

Engram implements temporal salience computation with access-based reinforcement and exponential decay:

- **Base decay rate**: 1% per day (configurable via `DEFAULT_DECAY_CONFIG.baseRate`)
- **Genome multiplier**: Genome memories decay at 30% the rate of phenotype (`genomeMultiplier: 0.3`)
- **Access reinforcement**: Each memory access reduces effective age by 7 days (`accessReinforcementDays: 7`)
- **Salience threshold**: Memories below salience 0.1 are eligible for archival
- **Exponential decay formula**: `salience * exp(-lambda * effectiveAge)` where lambda is salience-dependent

The decay engine runs as a background job (triggered via `POST /api/admin/decay/run`) and archives low-salience memories to keep the knowledge base healthy.

---

## Durable Memory System

Engram uses a durable memory repository with automatic classification:

- **Genome vs Phenotype**: Content is automatically classified using pattern matching heuristics (`classifyMemory` in `memoryInjector.ts`)
  - Genome patterns include capitals, definitions, scientific constants, mathematical identities, historical dates
  - Short declarative sentences without first-person pronouns default to genome
- **Sector inference**: Automatically infers sector from content keywords (procedural, episodic, emotional, reflective)
- **Supersession tracking**: New memories supersede old ones with audit logging

---

## Quick Start (Docker)

The fastest way to get Engram running is with Docker Compose — it pulls all models and starts every service in one command.

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
| **postgres** | 5432 | PostgreSQL with pgvector — memory storage |
| **redis** | 6379 | Redis cache / valkey storage |
| **ollama** | 11434 | Ollama LLM server (auto-pulls models on startup) |
| **engram** | 8098 | Engram proxy — the main API endpoint |
| **searxng** | 8888 | SearXNG search engine (for auto-search service) |
| **searxncrawl** | 9555 | Auto-search MCP server |
| **web** | 8099 | Engram Web GUI — real-time dashboard (see [Web GUI](#web-gui)) |

> **Observability:** Langfuse was removed. The built-in **Engram Web GUI** (`apps/web`, port 8099) is the primary dashboard — live server logs, memory activity, recall, and performance metrics. No separate tracing stack is required.

### Auto-Pulled Models

On container start, a model-loader service automatically pulls:

| Model | Purpose |
|---|---|
| `qwen3.5:2b` | Primary generative — extraction, compaction, consolidation |
| `qwen2.5:3b` | Generative fallback (stays offline unless primary fails) |
| `nomic-embed-text-v1.5` | Primary embedding model (768-dim, served by `EG_EMBED_MODEL`) |
| `bge-m3` | Embedding fallback (stays offline unless primary fails) |

> **Note:** Only `qwen3.5:2b` and `nomic-embed-text-v1.5` need to be running at all times. The fallback models are downloaded but normally stay idle until needed.

### Stop & Clean

```bash
# Stop all services
docker compose down

# Stop and remove all data volumes (fresh start)
docker compose down -v
```

---

## Client Configuration

Point your IDE or CLI tool to the Engram proxy:

```
http://<your-server-ip>:8098/v1
```

The proxy forwards enriched requests to the upstream LLM configured via `EG_UPSTREAM_LLM_URL`. Engram supports OpenAI, Gemini, and Siray as fallback upstream providers — just set the corresponding API key and base URL in `.env`.

---

## Configuration

Copy `.env.example` to `.env` and adjust as needed. Here are the most important variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `EG_PORT` | `8080` | Server HTTP port (internal container) |
| `EG_STORAGE` | `postgres` | Storage backend (`postgres`, `sqlite`) |
| `EG_VEC_DIM` | `1536` | Embedding vector dimension |
| `EG_EMBEDDINGS` | `openai` | Embedding provider (`ollama`, `openai`, etc.) |
| `EG_EMBED_TIMEOUT_MS` | `30000` | Embedding request timeout in ms |
| `EG_EMBED_MODEL` | `nomic-embed-text-v1.5` | **Active embedding model env key** (note: not `EG_MODEL_EMBEDDING` — `resolveEmbeddingModel` reads `EG_EMBED_MODEL`). Model-name casing on the serving box matters. |
| `EG_PG_HOST` | `localhost` | PostgreSQL host |
| `EG_PG_PORT` | `5432` | PostgreSQL port |
| `EG_PG_DB` | `engram` | PostgreSQL database name |
| `EG_PG_USER` | `postgres` | PostgreSQL user |
| `EG_PG_PASSWORD` | _(required)_ | PostgreSQL password |
| `EG_PG_SCHEMA` | `public` | PostgreSQL schema |
| `EG_OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint for embeddings & generative tasks |
| `EG_GENERATIVE_URL` | _(empty)_ | Generative model API URL (extraction, compaction) |
| `EG_MODEL_GENERATIVE` | `qwen3.5:2b` | Primary model for extraction, compaction, consolidation |
| `EG_MODEL_GENERATIVE_FALLBACK` | `qwen2.5:3b` | Fallback generative model |
| `EG_EMBED_MODEL` | `nomic-embed-text-v1.5` | Primary embedding model (read by `resolveEmbeddingModel`; `EG_MODEL_EMBEDDING` is NOT read) |
| `EG_MODEL_EMBEDDING_FALLBACK` | `bge-m3` | Comma-separated fallback embedding models |
| `EG_UPSTREAM_LLM_URL` | _(empty)_ | Upstream LLM forwarding endpoint |
| `EG_OPENAI_API_KEY` | _(empty)_ | OpenAI-compatible provider API key |
| `EG_OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI base URL |
| `EG_GEMINI_API_KEY` | _(empty)_ | Google Gemini API key |
| `EG_SIRAY_API_KEY` | _(empty)_ | Siray API key/token |
| `EG_SIRAY_BASE_URL` | `https://api.siray.ai/v1` | Siray base URL |
| `EG_COMPACT_TRIGGER` | `25` (code) / `100` (.env.example) | Message count that triggers compaction |
| `EG_MAX_RAW_TURNS` | `8` (code) / `4` (.env.example) | Number of recent raw turns kept after compaction |
| `EG_COMPACT_PROMPT_MAX_CHARS` | `800` | Max prompt length for compaction LLM call |
| `EG_COMPACTION_COOLDOWN_MS` | `120000` (120s) | Minimum time between compactions |
| `EG_EXTRACTION_COOLDOWN_MS` | `30000` (30s) | Minimum time between memory extractions |
| `EG_MAX_FACTS_PER_TURN` | `8` | Maximum facts extracted per conversation turn |
| `EG_API_KEY` | _(empty)_ | API key for auth (leave empty to disable) |
| `EG_REQUIRE_API_KEY` | `false` | Require API key for all requests |
| `EG_RATE_LIMIT_ENABLED` | `false` | Enable rate limiting |
| `EG_RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in ms |
| `EG_RATE_LIMIT_MAX_REQUESTS` | `100` | Max requests per window |
| `EG_TELEMETRY` | `true` | Enable telemetry |
| `EG_AUTO_SEARCH_ENABLED` | `false` | Enable auto-search via searxNcrawl |

For the full list, see [`.env.example`](.env.example).

### Model Selection Guide

All models are configurable via env vars with a cascading resolution chain. No hardcoded defaults — the system reads from `.env`: **per-facet override → provider-wide override → global fallback → universal `bge-m3`**.

| Task | Default Model | Config Var(s) | Notes |
|---|---|---|---|
| Generative (all) | LFM2.5-1.2B-Instruct | `EG_MODEL_GENERATIVE` + `EG_GENERATIVE_URL` | MUST be running at all times, thinking disabled |
| Embedding (general) | nomic-embed-text-v1.5 | `EG_EMBED_MODEL` | Primary embedding (note: `resolveEmbeddingModel` reads `EG_EMBED_MODEL`, not `EG_MODEL_EMBEDDING`); multi-facet with bge-m3 fallback |
| Embedding (per-sector) | same as above | `EG_MODEL_EPOCHISODIC`, `EG_MODEL_SEMANTIC`, etc. | Per-sector model override |
| Fallback | qwen2.5:3b | `EG_MODEL_GENERATIVE_FALLBACK` | Backup for generative tasks if primary fails |

---

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
ollama pull nomic-embed-text-v1.5
ollama pull bge-m3

# 5. Set environment variables (minimum required)
export EG_OLLAMA_URL=http://localhost:11434
export EG_UPSTREAM_LLM_URL=http://your-gpu-server:8080/v1
export EG_STORAGE=postgres
export EG_PG_HOST=localhost
export EG_PG_DB=engram

# 6. Start the server
cd packages/engram-js && EG_PORT=8080 npx nodemon src/server.ts
```

---

## Web GUI

The web interface provides a real-time dashboard for monitoring and managing Engram:

- **Dashboard** — Memory counts, genome/phenotype breakdown, sector/tier statistics
- **Memory Explorer** — Search, edit, and delete stored memories with full context
- **Server Logs** — Live, auto-refreshing Pino logs with module and model annotations
- **Performance** — CPU, memory, disk, Ollama cache, and GPU metrics

```bash
# Dev mode (Vite + React)
cd apps/web && npm run dev

# Production build
cd apps/web && npm run build
```

---

## API Overview

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | OpenAI-compatible chat endpoint with memory injection |
| `/health` | GET | Health check |
| `/api/dashboard/stats` | GET | Dashboard statistics (genome/phenotype breakdown) |
| `/api/dashboard/memories` | GET | List memories (paginated, searchable, filterable by sector) |
| `/api/dashboard/memories/:id` | PUT | Update a memory's content, sector, or genome status |
| `/api/dashboard/memories/:id` | DELETE | Delete a memory |
| `/api/dashboard/logs` | GET | Recent interaction/extraction logs |
| `/api/dashboard/log` | GET | Full Pino log file contents |
| `/api/dashboard/log/clear` | POST | Clear the Pino log file |
| `/api/dashboard/consolidate` | POST | Trigger consolidation manually |
| `/api/dashboard/perf` | GET | Server + Ollama performance metrics |
| `/api/performance/system` | GET | System metrics (CPU, memory, disk, load, uptime) |
| `/api/stats/summary` | GET | Memory statistics summary |
| `/api/stats/timeseries` | GET | Timeseries memory data |
| `/api/recall` | POST | Direct memory recall/search endpoint |
| `/api/memories/create` | POST | Create a new memory |
| `/api/memories/update` | PUT | Update an existing memory |
| `/api/memories/delete` | DELETE | Delete a memory by ID |
| `/api/memories/explain` | GET | Explain why a memory was recalled |
| `/api/memories/reinforce` | POST | Reinforce a memory (boosts salience) |
| `/api/memories/tier` | PUT | Change memory tier (active/cold/archived) |
| `/api/contradictions/create` | POST | Create a contradiction between memories |
| `/api/contradictions/resolve` | POST | Resolve a contradiction |
| `/api/consolidations/*` | POST | Consolidation lifecycle endpoints (create/claim/complete) |
| `/api/graph/temporal/query` | GET | Temporal graph query for memory relationships |
| `/api/edges/execute` | POST | Execute edge operations on the knowledge graph |
| `/api/ingest/document` | POST | Ingest a document for memory extraction |
| `/api/ingest/event` | POST | Record an interaction event |
| `/api/ingest/candidates/accept` | POST | Accept a candidate memory |
| `/api/ingest/candidates/reject` | POST | Reject a candidate memory |
| `/api/sources/ingest` | POST | Ingest from external sources (GitHub, Google Drive, OneDrive) |
| `/api/admin/decay/run` | POST | Run the memory decay engine manually |
| `/api/ide/*` | GET/POST | IDE-specific integration endpoints |

---

<details>
<summary><strong>Troubleshooting</strong></summary>

### Models not loading
Check Ollama health: `curl http://localhost:11434`. Verify models are available with `ollama list` inside the container.

### Server won't start
Verify PostgreSQL is running and port 8098 is free (`lsof -i :8098`). Check logs: `docker compose logs engram`.

### Cannot reach upstream LLM
Confirm `EG_UPSTREAM_LLM_URL` points to your GPU machine or provider endpoint. Test with a direct curl request.

### Consolidation not running
The cron runs every 30 minutes. Trigger manually via `POST /api/dashboard/consolidate`. Memories must be older than 7 days, have `access_count >= 1`, and share a `consolidation_hash` (minimum 3 per group).

### Compaction not triggering
Compaction runs when a conversation exceeds `EG_COMPACT_TRIGGER` (code default: **25**, `.env.example` overrides to **100**). Check server logs for the `compactionEngine` module.

### Migration fails
Ensure PostgreSQL is running and the database exists before starting the server. Migrations run automatically on startup.

</details>

---

## Naming

The project was previously called **OpenMemory** and **CodeCortex**. The official name is **FTR10 Engram**:

- **Engram** — Server / core package
- **Engram Web GUI** — Dashboard interface (`apps/web`)
- **EngramVS** — VS Code extension (`apps/vscode-extension`)

