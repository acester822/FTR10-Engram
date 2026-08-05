# Logging in Engram

Engram uses **pino** (NDJSON, structured fields) for server logging — the logger lives at
`packages/engram-js/src/utils/logger.ts`. Every log call takes an object (structured metadata)
as the first argument and a message string as the second:

```typescript
logger.info({ module: 'compactionEngine', oldMessageCount: 15, model: resolvedModel }, 'Triggering context compaction');
logger.error({ module: 'chatRoute', err: error, model: body.model }, 'Proxy request failed'); // 'err' formats stack traces
```

## Output & rolling file

- Logs go to **stdout** (JSON in production / `pino-pretty` colorized in dev) **and** to a
  rolling file at `LOG_DIR/engram.log` (default `path.resolve(cwd, "../..", "logs")`).
- The file keeps `EG_LOG_MAX_LINES` (default 3000) lines, truncating the oldest when exceeded.
- **`EG_LOG_DIR` / `EG_LOG_MAX_LINES` / `LOG_LEVEL` must be set in `.env`** — the logger reads
  them at static-import time, before the settings store is available. The compose deployment
  mounts `./logs:/home/ftr/Apps/Engram/logs` and sets `EG_LOG_DIR=/home/ftr/Apps/Engram/logs`.
- Log level: `LOG_LEVEL` env var (`fatal | error | warn | info | debug | trace`, default `info`).

## Reading logs from the API / GUI

- `GET /api/dashboard/log?limit=N` — tail the log file (the **Server Logs** GUI tab polls this).
- `POST /api/dashboard/log/clear` — truncate the file.
- `docker compose logs -f engram` — container stdout.

## Grafana / Loki (optional)

Because logs are NDJSON, Loki parses them without regex:

```logql
{container="engram-engram-1"} | json | level="error" and module="compactionEngine"
{container="engram-engram-1"} | json | module="memoryLogger" | line_format "{{.msg}} took {{.durationMs}}ms"
sum by (model) (count_over_time({container="engram-engram-1"} | json | msg="Saved new memories" [24h]))
```

## Useful log modules

| Module | What it logs |
|--------|--------------|
| `chatRoute` | Proxy lifecycle: recall counts, forward, SSE, errors |
| `memoryLogger` | Extraction: gates, quality drops, saved memories |
| `compactionEngine` | Compaction runs, thinning, summarize/extract |
| `consolidationEngine` | Tier cycles, chunk sizes, LLM actions, execution |
| `settings` | Settings load/seed events |
| `pgpool` | Postgres pool errors |
| `http` | Request/response (debug level) |
