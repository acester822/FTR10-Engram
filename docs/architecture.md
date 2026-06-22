# Architecture

## Git Strategy

| Path | Method | Remote | Version |
|---|---|---|---|
| `apps/langfuse` | `git subtree` | `https://github.com/langfuse/langfuse.git` | v3.194.1 |
| `apps/searxNcrawl` | `git submodule` | `https://github.com/acester822/searxNcrawl.git` | HEAD |

### Why subtree for Langfuse?
Langfuse is forked with Engram-specific modifications (pages, tRPC routers, sidebar entries). Subtree keeps the code in-repo without submodule complexity. Engram modifications live in:
- `web/src/pages/project/[projectId]/engram/` — Engram management pages
- `web/src/features/engram/server/` — Engram tRPC routers
- `web/src/components/layouts/routes.tsx` — Sidebar entries
- `web/src/env.mjs` — Engram env vars

### Why submodule for searxNcrawl?
Standalone Python MCP service with no Engram-specific modifications. Submodule is sufficient.

## Final Stack

| Service | Purpose | Container |
|---|---|---|
| `postgres` | Dual: Engram DB + Langfuse DB | pgvector/pgvector |
| `redis` | BullMQ queues (Langfuse) | redis:7-alpine |
| `clickhouse` | Trace/score analytics (Langfuse) | clickhouse/clickhouse-server |
| `minio` | Ingestion event persistence (Langfuse) | minio/minio |
| `engram` | Memory proxy server | local build |
| `searxncrawl` | Auto-search (web search + crawl) | local build |
| `searxng` | Meta-search engine | searxng/searxng |
| `langfuse-web` | Combined UI | local build |
| `langfuse-worker` | Background job processing | local build |
| `langfuse-init` | One-shot DB creation | postgres:16-alpine |

## Subtree Commands

### Update Langfuse
```bash
git subtree pull --prefix=apps/langfuse https://github.com/langfuse/langfuse.git v3.200.0 --squash
```

### Clone everything
```bash
git clone --recurse-submodules https://github.com/acester822/FTR10-Engram.git
```

### Update submodules
```bash
git submodule update --init --recursive
```