# Architecture

## Git Strategy

| Path | Method | Remote | Version |
|---|---|---|---|
| `apps/searxNcrawl` | `git submodule` | `https://github.com/acester822/searxNcrawl.git` | HEAD |

> **Langfuse was removed** from docker-compose (Aug 2026). Its code still exists under `apps/langfuse` (git subtree) but is NOT part of the running stack — no containers, no port 3000, `EG_LANGFUSE_ENABLED` off, `getLangfuse()` returns null. Treat it as dead/archived. Related design docs live in `docs/archive/`.

### Why submodule for searxNcrawl?
Standalone Python MCP service with no Engram-specific modifications. Submodule is sufficient.

## Final Stack

| Service | Purpose | Container |
|---|---|---|
| `postgres` | Memory store (pgvector) + settings store (`app_settings`) | pgvector/pgvector |
| `redis` | Optional cache / valkey storage | redis:7-alpine |
| `engram` | Memory proxy server + API (all `/api/*` + OpenAI-compatible chat proxy) | local build |
| `web` | Web GUI (nginx :8099, proxies `/api/` → `engram:8080`) | local build (nginx) |
| `searxncrawl` | Auto-search (web search + crawl) | local build |
| `searxng` | Meta-search engine | searxng/searxng |

External ports: **8098** (Engram API), **8099** (Web GUI), 5432 (Postgres), 6379 (Redis).

## Configuration (single source of truth)

Providers and models are configured in the **web GUI Settings tab** (persisted in Postgres `app_settings`; resolved via `packages/engram-js/src/database/modelRegistry.ts` with **no hardcoded model-name defaults**). The `.env` file holds only the ~17 startup values that cannot be GUI-managed (LLM-box URLs/auth, Postgres/Redis, log path, internal keys) — see `docs/model-config-audit.md` for the full variable/hardcoded-model audit.

## Clone / update

```bash
git clone --recurse-submodules https://github.com/acester822/FTR10-Engram.git
git submodule update --init --recursive
```
