# Agents.md

## Important Files & Directories:
### Files:
- AGENTS.md - Project information, flows, commands, etc
- readme.md - Similar to the agents.md but will have less technical information
- docs/model-config-audit.md - **Configuration reference**: full audit of every model variable + the Settings-tab registry design
- docs/model-breakdowns.md - Model selection guide (current: Settings-tab registry, no hardcoded defaults)
- docs/todo.md - Implementation plans (kept as historical reference)
- docs/archive/ - Superseded design/plan documents (Langfuse plans, original plan.md, rebrand notes, etc.)
### Directories:
- packages/engram-js - Engram server (rebranded from OpenMemory/CodeCortex)
- apps/web - Web UI frontend (port 8099 in Docker)
- apps/vscode-extension - VS Code extension ("Engram for VS Code", `@cortex` chat participant)
- apps/searxNcrawl - Auto-search service (web search via SearXNG MCP server)
- apps/langfuse - Langfuse code still on disk but REMOVED from docker-compose (observability disabled — treat as dead)

## Important Commands:

### Command to Start the server:
  ```bash
  cd packages/engram-js && EG_PORT=8080 HOST=0.0.0.0 npx tsx src/server.ts
  ```
  
### Docker deployment:
```bash
docker compose up --build -d
```
Docker services: `postgres`, `redis`, `engram`, `searxncrawl`, `searxng`, `web`.
External ports: **8098** (Engram API), **8099** (Web GUI), 5432 (Postgres), 6379 (Redis).

## Project Flows:
```mermaid
flowchart TD
    classDef user fill:#e1f5fe,stroke:#01579b,stroke-width:2px
    classDef engram fill:#fff3e0,stroke:#e65100,stroke-width:2px
    classDef upstream fill:#e8f5e9,stroke:#1b5e20,stroke-width:2px
    classDef db fill:#f3e5f5,stroke:#4a148c,stroke-width:2px
    classDef infra fill:#f0f0f0,stroke:#666,stroke-width:1px

    U["👤 User Workspace (IDE / CLI)"]:::user

    E1["🖥️ Engram: Intercept Request (:8098)"]:::engram
    E2["🖥️ Engram: Embed via OpenAI-compatible (llama-swap)"]:::engram
    E3[("🗄️ PostgreSQL / pgvector")]:::db
    E4["🖥️ Engram: Weave Context"]:::engram
    E5["📡 SSE: 'Injected X memories'"]:::engram

    UP1["🚀 Upstream LLM (llama-swap / OpenAI)"]:::upstream
    UP2["🚀 Upstream: Generate & Stream"]:::upstream

    E6["🖥️ Engram: Accumulate Transcript"]:::engram
    E7["🖥️ Engram: Extract Facts (generative model)"]:::engram
    E8[("🗄️ PostgreSQL")]:::db
    E9["📡 SSE: 'Stored X memories'"]:::engram

    U -->|"1. POST /v1/chat/completions"| E1
    E1 --> E2
    E2 --> E3
    E3 --> E4
    E4 --> E5
    E5 -.->|"Real-time UI Update"| U
    E4 -->|"6. Forward Enriched Prompt"| UP1
    UP1 --> UP2
    UP2 -->|"7. Stream Tokens"| E6
    E6 -->|"Real-time pipe"| U
    E6 --> E7
    E7 --> E8
    E8 --> E9
    E9 -.->|"Final UI Update"| U

    classDef compaction fill:#fde8f7,stroke:#a12483,stroke-width:2px
    C1["⚙️ Compaction Engine"]:::compaction
    C2[("🗄️ PostgreSQL")]:::db
    E6 -.->|"Triggered at EG_COMPACT_TRIGGER"| C1
    C1 -->|"Summary + facts"| C2

    classDef consolidation fill:#e8f5e9,stroke:#1b5e20,stroke-width:2px
    S1["⏱ Consolidation Cron"]:::consolidation
    S2[("🗄️ PostgreSQL")]:::db
    S3["⚙️ LLM Actions\nmerge/update/promote/delete"]:::consolidation
    S1 -->|"Every 30 min"| S2
    S2 --> S3
```

### Compaction Flow:
When conversation exceeds `EG_COMPACT_TRIGGER` messages (code default: **50**, .env.example overrides to **100**), the compaction engine triggers **asynchronously** in the background (non-blocking, cooldown: 10s via `EG_COMPACTION_COOLDOWN_MS`):

1. **Isolate** — Split into old history + a recent raw tail (`EG_MAX_RAW_TURNS`, default: **6**, .env.example overrides to **4**)
2. **Thin** — Truncate tool outputs >800 chars, assistant responses >1200 chars, user messages >1000 chars; remove consecutive duplicate tool calls
3. **Summarize & Extract** — Single LLM call (model: `env.generative_model` from config) produces a dense summary AND durable facts in JSON format
4. **Reconstruct** — Old history replaced with `[COMPACTED SESSION SUMMARY]` plus raw tail; context never grows unbounded

If compaction fails, it drops old history silently and keeps only the raw tail to preserve conversation continuity.

### Consolidation Flow:
Two-tier background cron (intervals/windows/min-groups overridable via `EG_CONSOLIDATION_*` or the GUI Settings tab):
1. **RECENT tier** — every 4h, scans the last 7 days (min-group 2, access ≥ 0): promotes standing rules / merges near-dupes promptly.
2. **DEEP tier** — every 24h, scans memories 7–30 days old (min-group 3, access ≥ 1): long-window cleanup.
3. **Fetch Groups** — grouped by `consolidation_hash` (note: hashes are never written today, so the whole store behaves as one group).
4. **Chunk** — groups are split into ≤150 memories per LLM call (`EG_CONSOLIDATION_BATCH_MEMORIES`) so prompts fit the model context.
5. **Generate Actions** — LLM returns merge/update/promote/delete decisions as JSON (`response_format: json_object` + tolerant parsing); model resolved via the settings registry.
6. **Execute Actions** — applied per-action against the DB with transaction rollback on failure.

Manual trigger via API: `POST /api/dashboard/consolidate` (`?tier=recent` / `?tier=deep` / both by default)

### Model Selection Guide:
Models/providers are configured in the **web GUI Settings tab** (persisted in Postgres `app_settings`) — it is the single source of truth. Resolution (see `src/database/modelRegistry.ts`): **Settings → env override → fail with a clear message**. There are NO hardcoded model-name defaults anywhere in the codebase.

| Task | Deployed model | Notes |
|---|---|---|
| **Generative** (extraction, compaction, consolidation, autoSearch) | LFM2.5-1.2B-Instruct | Master model in Settings → Generative; per-task overrides available (extraction/compaction/consolidation) |
| **Embedding** | nomic-embed-text-v1.5 (768-dim) | Master model in Settings → Embedding; per-facet overrides for episodic/semantic/procedural/emotional/reflective (deployment: procedural = CodeRankEmbed) |
| **Provider** | llama-swap @ http://10.10.10.41:8080/v1 | Set in Settings → Provider (type OpenAI Compatible, host IP, port) |

Legacy env overrides still honored as fallback: `EG_MODEL_GENERATIVE`, `EG_MODEL_EMBEDDING`, `EG_MODEL_EMBED_<FACET>`, `EG_CONSOLIDATION_MODEL` — but they are no longer required.

Supported embedding providers: `openai`, `gemini`, `aws`, `siray`, `local`.

```text
[ USER IDE / CLI ] 
       │
       │ 1. Sends prompt + requested model
       ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│ 🖥️ ENGRAM PROXY (:8098)                                                    │
│                                                                       │
│ 2. Embeds via OpenAI-compatible provider (Settings tab)           │
│ 3. Queries PostgreSQL for Genome/Phenotype memories                 │
│ 4. Weaves memories invisibly into System Prompt                     │
│ 5. ⚡ SSE TO USER: "🧠 Injected X memories"                         │
│                                                                       │
│ 6. Forwards enriched prompt to upstream LLM                          │
│                                                                       │
│ 9. Receives streaming tokens from upstream                           │
│ 10. ⚡ PIPES tokens in real-time to USER                             │
│ 11. Accumulates full response text in background                    │
│                                                                       │
│ 12. Stream ends. Calls generative model for extraction              │
│     (resolved via Settings registry)                                 │
│ 13. Saves extracted JSON facts to PostgreSQL                        │
│ 14. ⚡ SSE TO USER: "🧠 Stored X memories"                           │
└───────────────────────────────────────────────────────────────────────┘
        ▲                              │
        │ 10. Streams tokens           │ 6. Forwards enriched prompt
        │                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 🚀 UPSTREAM LLM (llama-swap / OpenAI / Gemini / Siray)            │
│                                                               │
│ Configured via EG_UPSTREAM_LLM_URL + provider keys              │
│ 7. Receives request & generates response                        │
│ 8. Streams raw SSE tokens back to Engram Proxy                  │
└──────────────────────────────────────────────────────────────────────┘

[COMPACTION ENGINE] (Background, triggered when messages > EG_COMPACT_TRIGGER)
    ├─ 1. ISOLATE: Split old history + recent raw tail
    ├─ 2. THIN: Truncate massive outputs, remove duplicates
    ├─ 3. SUMMARIZE & EXTRACT: Single LLM call (config-driven model)
    └─ 4. RECONSTRUCT: Replace with [COMPACTED SESSION SUMMARY] + raw tail

[CONSOLIDATION ENGINE] (Two-tier cron: RECENT 4h / last 7d, DEEP 24h / 7–30d)
   ├─ 1. FETCH GROUPS: memories in tier window, grouped by consolidation_hash
   ├─ 2. CHUNK: ≤150 memories per LLM call
   ├─ 3. GENERATE ACTIONS: LLM JSON merge/update/promote/delete decisions
   ├─ 4. EXECUTE ACTIONS: per-action with transaction rollback
   └─ 5. SYNTHESIS FALLBACK: if LLM omits new_content, synthesize from sources
```

## Intended Operation
1. **Start your Backend**: `cd packages/engram-js && EG_PORT=8080 HOST=0.0.0.0 npx tsx src/server.ts`
   Ensure your Node.js proxy is running & verify it's listening on the configured port (default: 8080).
2. **Open the Chat Panel**: 
   In VS Code, open Kilo's Chat view (`Ctrl+Alt+I` or `Cmd+Option+I`).
3. **Invoke Engram**: 
   Type `@cortex How should I structure my auth middleware?`
4. **Observe the Magic**:
     * You will see "🧠 Querying Engram memory engine..."
     * The response will stream in naturally.
     * At the bottom, you will see a collapsible **"🧠 Engram Memory Trace"** section showing exactly *why* the AI answered the way it did, citing your postgres database.

## Current Status:
- **Rebrand complete**: Renamed from OpenMemory/CodeCortex to FTR10 Engram (packages, env vars, file names)
- **Compaction Engine**: Fully implemented — isolates recent tail, thins history, generates summary + facts via generative model
- **Consolidation Engine**: Background cron job for memory maintenance (merge/update/promote/delete with synthesis fallback)
- **Settings tab (single source of truth)**: providers, generative/embedding models, general tuning, and read-only advanced values — persisted in Postgres `app_settings`, no hardcoded model defaults
- **Model registry**: `modelRegistry.ts` resolves every model via Settings → env → fail
- **Auto-search**: Web search via searxNcrawl MCP server (configurable, disabled by default)
- **Memory decay engine**: Temporal salience computation with access-based reinforcement and exponential decay
- **Durable memory system**: Genome/Phenotype separation with automatic classification heuristics
- Server is online and operational

## Issues:
### Naming conventions are a bit scattered, in the end the project will be named FTR10 Engram. The server will be named Engram. The modified Kilo extension will be named EngramVS.

