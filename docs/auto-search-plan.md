# Auto-Search Plan (v2 — searxNcrawl Integration)

## Overview

When a user sends a prompt through Engram, the system detects knowledge gaps in its stored memories and proactively searches the web for relevant information via **searxNcrawl** — Engram's existing sister app. This happens invisibly before the LLM generates its response.

## Why searxNcrawl?

The existing `apps/searxNcrawl` provides everything we'd otherwise need to build from scratch:

| Need | What searxNcrawl gives us |
|---|---|
| **Search** | `search` MCP tool — SearXNG metasearch (privacy-respecting, no API key, ~50 engines) |
| **URL fetching** | `crawl` MCP tool — headless Chromium via Crawl4AI, returns clean Markdown/JSON |
| **Content quality** | JS-rendered pages, dedup, guardrails, CSS targeting — far better than regex HTML stripping |
| **Infrastructure** | Already containerized, has its own docker-compose, runs at `localhost:9555` |
| **Auth** | Optional HTTP Basic Auth, session capture for authenticated crawling |

## Architecture

```
[User Prompt]
     ↓
[ENGRAM PROXY (Node.js :8080)]
   ├─ 1. Genome recall (cached)
   ├─ 2. Phenotype recall (vector search)
   ├─ 3. Gap detection: check recall confidence vs EG_AUTO_SEARCH_MIN_CONFIDENCE
   │     └─ if score < threshold:
   │           ├─ Generate search queries via LLM (qwen3.5:2b)
   │           ├─ Send search request to searxNcrawl MCP
   │           │     POST http://searxncrawl:9555/mcp
   │           │     { tools/call, name: "search", args: { query, max_results: 5 } }
   │           ├─ Fetch top N URLs via searxNcrawl crawl
   │           │     POST http://searxncrawl:9555/mcp
   │           │     { tools/call, name: "crawl", args: { urls: [...], output_format: "markdown" } }
   │           └─ SSE: "🔍 Retrieved X sources"
   ├─ 4. Weave results into [ENGRAM COGNITIVE CONTEXT]
   ├─ 5. Forward to upstream LLM
   ├─ 6. Stream response back
   └─ 7. Async: log + extract memories (existing)
```

## Integration Method

Engram communicates with searxNcrawl over **MCP HTTP** using the JSON-RPC protocol. No MCP client SDK needed — the existing Node.js `fetch` is sufficient. The Docker compose network (`ftr10-engram`) is shared so inter-service communication works natively.

## New Files

| File | Purpose |
|---|---|
| `packages/engram-js/src/services/autoSearch.ts` | Gap detection + searxNcrawl client + context formatting |

## Modified Files

| File | Change |
|---|---|
| `packages/engram-js/src/configuration/index.ts` | Add `EG_AUTO_SEARCH_*` env vars |
| `packages/engram-js/src/api/routes/chat/completions/route.ts` | Wire auto-search into the flow |
| `docker-compose.yml` | Add searxNcrawl service (depends_on: ollama) |

## Implementation Steps

### Step 1: Docker Compose — add searxNcrawl service

Add to the root `docker-compose.yml` alongside the existing services:

```yaml
searxncrawl:
  build:
    context: ./apps/searxNcrawl
    dockerfile: Dockerfile
  image: engram-searxncrawl:latest
  env_file:
    - ./apps/searxNcrawl/.env
  environment:
    SEARXNG_URL: ${SEARXNG_URL:-http://searxng:8888}
  ports:
    - "9555:9555"
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
  networks:
    - ftr10-engram
  restart: unless-stopped
```

If searxNcrawl's own compose includes SearXNG, we may need to pull that out or reference it. **Decision**: searxNcrawl already includes SearXNG in its own compose (`SEARXNG_URL: http://localhost:8888`). We should add a separate SearXNG service to the root compose, or embed searxNcrawl's compose as a dependency. The simplest approach: add searxNcrawl to the root `docker-compose.yml` and override `SEARXNG_URL` to point to a shared SearXNG instance (or let searxNcrawl manage its own).

### Step 2: Configuration — add env vars to `configuration/index.ts`

```ts
// ── Auto-search via searxNcrawl ──
auto_search_enabled: bool(process.env.EG_AUTO_SEARCH_ENABLED),
auto_search_max_results: num(process.env.EG_AUTO_SEARCH_MAX_RESULTS, 3),
auto_search_min_confidence: (() => {
  const v = num(process.env.EG_AUTO_SEARCH_MIN_CONFIDENCE, 40);
  return Math.max(0, Math.min(1, v / 100));
})(),
auto_search_url: str(process.env.EG_AUTO_SEARCH_URL, "http://localhost:9555"),
```

### Step 3: Create `services/autoSearch.ts` — the auto-search engine

This service has four responsibilities:

#### 3a. Gap detection (`shouldSearch`)

```ts
shouldSearch(topScore: number, userPrompt: string): boolean {
  if (!this.config.enabled) return false;
  
  // Quick check: if we have strong phenotype context, skip
  if (topScore >= this.config.minConfidence) return false;
  
  // Heuristic: detect technology/framework keywords that benefit from online docs
  const techPatterns = [
    /\b(node\.?js|express|react|vue|angular|next\.?js|nuxt|svelte)\b/i,
    /\b(python|django|flask|fastapi|pytorch|tensorflow)\b/i,
    /\b(postgres|mysql|mongo|redis|prisma|typeorm)\b/i,
    /\b(docker|kubernetes|k8s|terraform|ansible)\b/i,
    /\b(aws|gcp|azure|cloudflare|vercel|netlify)\b/i,
    /\b(api|sdk|library|framework|package|module|dependency|config)\b/i,
    /\b(how\s+to|guide|tutorial|example|docs?|documentation)\b/i,
  ];
  
  return techPatterns.some(p => p.test(userPrompt));
}
```

#### 3b. Query generation (`generateQueries`)

Uses the existing generative model (qwen3.5:2b via `EG_GENERATIVE_URL` or local Ollama) to convert the user's prompt into 2-3 focused search queries. Response JSON format: `["query1", "query2"]`. System prompt enforces strict JSON output with `think: false` (same pattern as compaction engine).

Fallback: if the LLM call fails, extract keywords directly from the user prompt (noun phrases, tech keywords).

#### 3c. SearXNG search via MCP (`search`)

Calls searxNcrawl's `search` MCP tool:

```
POST http://searxncrawl:9555/mcp
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "search",
    "arguments": {
      "query": "generated search query",
      "max_results": 5,
      "language": "en",
      "safesearch": 1
    }
  }
}
```

Response contains `results[]` with `{ title, url, content (snippet), engine, category }`.

Apply domain allow-list filtering if `EG_AUTO_SEARCH_DOMAINS` is set.

#### 3d. URL fetching via MCP (`fetchContent`)

Calls searxNcrawl's `crawl` MCP tool for each selected URL:

```
POST http://searxncrawl:9555/mcp
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "crawl",
    "arguments": {
      "urls": ["https://docs.example.com/feature"],
      "output_format": "markdown",
      "timeout": 15
    }
  }
}
```

Returns markdown content of the page. Truncate to `EG_AUTO_SEARCH_MAX_CHARS` (default: 2000) to avoid prompt bloat.

#### 3e. Context formatting (`formatContext`)

Formats results into the `[ENGRAM COGNITIVE CONTEXT]` block:

```
--- WEB CONTEXT (auto-retrieved) ---
[Node.js Documentation - Child Process]
  Source: nodejs.org (engine: google)
  https://nodejs.org/api/child_process.html
  [Content preview — 842 chars]
  The child_process module provides the ability to spawn subprocesses...

[Node.js Child Process Example]
  Source: stackoverflow.com (engine: google)
  https://stackoverflow.com/questions/12345
  [Content preview — 631 chars]
  To spawn a child process in Node.js, use require('child_process')...
```

### Step 4: Integrate into `chat/completions/route.ts`

After the existing phenotype recall (line ~204 in `route.ts`), add:

```ts
// 1.5 AUTO-SEARCH: Detect knowledge gaps and fetch online content
let autoSearchResults: SearchResult[] = [];
if (env.auto_search_enabled) {
  const topScore = phenotypeMemories.length > 0 ? phenotypeMemories[0].score : 0;
  
  if (autoSearch.shouldSearch(topScore, userPrompt)) {
    const queries = await autoSearch.generateQueries(userPrompt, { signal: abortController.signal });
    
    if (queries.length > 0) {
      // Status update before potentially slow search
      res.write(createSSEChunk(`🌐 Searching web for context...`, body.model));
      
      const searchResults = await autoSearch.search(queries);
      autoSearchResults = await autoSearch.fetchContent(searchResults);
      
      res.write(createSSEChunk(`🔍 Retrieved ${autoSearchResults.length} sources`, body.model));
    }
  }
}
```

Also update `buildCognitiveContext()` to accept an optional third parameter for web results, appending them as a `--- WEB CONTEXT ---` section.

### Step 5: Configuration Reference

| Env Var | Default | Description |
|---|---|---|
| `EG_AUTO_SEARCH_ENABLED` | `false` | Opt-in toggle |
| `EG_AUTO_SEARCH_MAX_RESULTS` | `3` | Max URLs to crawl per request |
| `EG_AUTO_SEARCH_MIN_CONFIDENCE` | `40` | Threshold (0-100). Only search if top phenotype score < this |
| `EG_AUTO_SEARCH_URL` | `http://localhost:9555` | searxNcrawl MCP HTTP endpoint |
| `EG_AUTO_SEARCH_DOMAINS` | *(empty)* | Comma-separated domain allow-list |
| `EG_AUTO_SEARCH_MAX_CHARS` | `2000` | Max chars per crawled URL content |

## Implementation Order

1. **Docker Compose** — add searxNcrawl service to root compose, configure network
2. **Configuration** — add env vars to `configuration/index.ts`
3. **`services/autoSearch.ts`** — the core engine (gap detection → query generation → searxNcrawl MCP calls → context formatting)
4. **Route integration** — wire into `chat/completions/route.ts`
5. **Update `buildCognitiveContext`** — accept web results parameter
6. **SSE status** — add "🌐 Searching web..." / "🔍 Retrieved X sources" messages

## Risk Mitigation

- **searxNcrawl unavailable**: If the MCP endpoint is unreachable, log a warning and proceed without web context (same silent-failure pattern as compaction engine)
- **Slow crawl**: Each URL has a 15s timeout via searxNcrawl's `timeout` parameter. If searxNcrawl itself is slow, Engram's `abortController` can cancel the request
- **No results**: Search returns empty → skip gracefully
- **Prompt bloat**: Each crawled URL capped at `EG_AUTO_SEARCH_MAX_CHARS` (default 2000 chars). Max 3 URLs = 6000 chars worst case
- **Duplicate content**: Depulication via searxNcrawl's built-in dedup (`dedup_mode: "exact"`)