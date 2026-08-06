# Implementation Plan: Persistent Trace Store + Response Scoring

> **Status:** PLANNED — not yet implemented. This is the design doc for the "track everything, score responses" work. Open items are marked **[DECIDE]**. When implemented, append the ✅ Implementation Summary at the bottom of this file per repo convention.

## Overview

Engram currently captures live traffic only in an **in-memory ring buffer** (`src/api/activity.ts`, `MAX_ACTIVITY = 500`) — summaries + genome/phenotype/sector breakdown per request, lost on restart. There is no persistent history ("what did the system do last Tuesday?"), no full request/response payloads, and no scoring of extraction/recall/answer quality outside the ad-hoc benchmark harness.

This plan adds:

1. **Persistent trace store** — every inbound request (recall, ingest, memories, chat proxy, cognitive-context) written to Postgres with full request/response bodies, breakdown, timing, and model. Retention-pruned by hard DELETE.
2. **Scoring hook** — LLM-as-judge (same rubric-judge pattern as the benchmark harness) scoring traces on demand + optional auto-sampling. Scores stored on the trace row.
3. **Traces tab** in the existing web GUI (`apps/web`) — list/filter/detail + "Score now".

**Explicitly NOT in scope:** no vendor platform (Langfuse/Opik/Phoenix). Langfuse was removed (Aug 2026) — ClickHouse+MinIO+2-container weight, dormant wrappers, user stopped using the UI. The value here is *Engram-semantic* traces (genome/phenotype/sector are already computed by `deriveBreakdown` for free) persisted locally — a generic platform would need custom metadata wiring to reproduce what this middleware already produces.

## Plan → reality notes (read before implementing)

- **No versioned migrations.** Schema is `src/durable/schema.ts` `buildDurableSchemaSql()` — ONE idempotent statement list (`IF NOT EXISTS` everywhere), run at every boot via `src/database/migrate.ts`. New table goes in `DURABLE_TABLES` + a `CREATE TABLE IF NOT EXISTS` block; bump `DURABLE_SCHEMA_VERSION` (`"4.1.0-settings"` → `"4.2.0-traces"`). Do NOT create a `migrations/` dir.
- **Capture plumbing already exists.** `src/api/index.ts` (~lines 31–62) wraps `res.write` + `res.end` and `JSON.parse`s the body into `respJson` (this is what feeds the activity buffer). Persistence hooks here — no new capture machinery. **Pitfall already documented in skill:** JSON bodies go through `res.end`, not `res.write`; SSE bodies go through `res.write` chunks — capture BOTH.
- **Do not trace the trace routes.** The middleware must skip `/api/dashboard/traces*` (and the health path) or every GUI poll writes a row.
- **Auth:** `/api/dashboard/*` requires `x-api-key` unless `EG_REQUIRE_API_KEY=false` (dev default here). Traces contain full conversation bodies — keep the dashboard auth semantics; do NOT add traces routes to `PUBLIC_ENDPOINTS`.
- **Settings:** any new `EG_TRACE_*` key the GUI should expose MUST be a live getter in `src/configuration/index.ts` (`getSetting(...)` + `process.env` fallback) and listed in `GENERAL_SETTINGS` (`src/services/settingsService.ts`) — frozen-at-boot properties silently ignore GUI edits (the known CONFIG GOTCHA).
- **Streaming responses:** the chat proxy streams SSE; the accumulated body can be large. Cap stored body size (`EG_TRACE_MAX_BODY_CHARS`) and always store `request_body` (small) even when `response_body` is truncated.
- **PII/secret risk:** trace bodies will contain raw prompts/replies. The store had a literal sudo-password leak incident (June 2026). Apply a **redaction pass** before persisting reusing the SECRET regexes from the memory-cleanup rules (`references/memory-cleanup.md`) — [DECIDE] redact-by-default vs. store-verbatim-with-flag.

## Phase 1: Database schema

**File:** `packages/engram-js/src/durable/schema.ts`

Add to `DURABLE_TABLES` and append to `buildDurableSchemaSql()`:

```sql
create table if not exists traces (
  id             uuid primary key default gen_random_uuid(),
  ts             timestamptz not null default now(),
  route          text not null,
  method         text not null,
  status         integer,
  ms             integer,
  direction      text,          -- 'in' | 'out' | 'chat'  (memory traffic vs proxy)
  kind           text,          -- 'write' | 'read' | 'chat'
  label          text,          -- 'recall' | 'ingest' | 'remember' | 'cognitive-context' | ...
  session_id     text,
  project_id     text,
  user_id        text,
  model          text,          -- resolved model (proxy) / null
  request_body   jsonb,
  response_body  jsonb,         -- truncated per EG_TRACE_MAX_BODY_CHARS
  breakdown      jsonb,         -- {genome, phenotype, sectors} from deriveBreakdown
  injection      jsonb,         -- chat/cognitive-context only: {genome_count, phenotype_count, web_used}
  scores         jsonb not null default '[]'::jsonb,  -- [{dimension, score, reason, judge_model, ts}]
  error          text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_traces_ts    on traces (ts desc);
create index if not exists idx_traces_route on traces (route);
```

Bump `DURABLE_SCHEMA_VERSION` to `"4.2.0-traces"`. No FK to `memories` — traces must survive memory deletion (and vice versa).

## Phase 2: Middleware persistence

**File:** `packages/engram-js/src/api/index.ts`

Inside the existing `res.end`/`res.write` wrappers (where `respJson` is already produced):

1. Build the trace row from the same inputs `recordActivityWithBreakdown` uses (request path/method/status/ms, body, `respJson`, `deriveBreakdown` result).
2. **Fire-and-forget INSERT** (never block the response): `run_async` on the pool with `INSERT INTO traces ...`. No await in the hot path; swallow errors with a `logger.warn` (tracing must never break a request).
3. Redaction pass on `request_body`/`response_body` before insert (secret/session-id regexes) per the PII note above.
4. Cap `response_body` at `EG_TRACE_MAX_BODY_CHARS` (default 65536); mark `{"truncated": true}`.
5. Skip paths: `/api/dashboard/traces*`, `/health`, and any route the middleware itself serves that would self-recurse.
6. Chat proxy injection stats: `src/api/routes/chat/completions/route.ts` already builds injection status (`genome_count`, `phenotype_count`, web) — surface it on the response (`choices[0]._trace` exists today; also attach `_trace.injection` or read from the shaped `/api/cognitive-context` response) so the middleware can store it in `injection`. **[DECIDE]** exact field placement.
7. Keep the ring buffer as-is (activity buffer + `engram watch` + VS Code observer keep working unchanged) — the trace table is additive, not a replacement.

## Phase 3: API routes

**New file:** `packages/engram-js/src/api/routes/dashboard/traces/route.ts` → `export const dashboard_traces_route = (app: any) => {...}`; register in `src/api/routes/index.ts` alongside `dashboard_route`. All under `/api/dashboard/traces*` (GUI nginx proxies only `/api/`; root routes are unreachable from the browser).

- `GET /api/dashboard/traces` — filters: `route`, `direction`, `kind`, `status`, `model`, `sector` (matches inside `breakdown.sectors`), `scored=true|false`, `since`/`until` (ISO), `limit` (default 100, max 500), `offset`. Returns list rows (NO full bodies — summary + breakdown + latest score per row).
- `GET /api/dashboard/traces/:id` — full row incl. `request_body`, `response_body`, `scores`.
- `POST /api/dashboard/traces/:id/score?dimension=recall_relevance|extraction_fidelity|answer_quality` — runs the judge now, appends to `scores` (see Phase 4).
- `DELETE /api/dashboard/traces` — clear all (mirrors `POST /api/dashboard/log/clear` semantics; hard DELETE per preference).
- `DELETE /api/dashboard/traces/prune?days=N` — retention run (hard DELETE `WHERE ts < now() - interval 'N days'`).

**Route registration order matters:** register BEFORE the catch-all/404 handler in `index.ts`.

## Phase 4: Scoring hook (LLM-as-judge)

**Files:** `packages/engram-js/src/database/modelRegistry.ts`, `packages/engram-js/src/services/traceScorer.ts` (new)

1. **Judge model:** add `"judge"` to the `GenerativeTask` union + `GENERATIVE_TASK_KEYS` so `resolveGenerativeModel("judge")` resolves via Settings → `EG_JUDGE_MODEL` → master model. Default should be the benchmark's judge (Gemma-4-26B-A4B-MTP on the llama-swap box) — NOT LFM2.5-1.2B, which is too weak for judging (same lesson as consolidation). [DECIDE] whether to add a dedicated `judge` settings row in the Settings tab (registry recipe in `references/settings-registry.md`).
2. **`src/services/traceScorer.ts`** — one exported `scoreTrace(traceRow, dimension): Promise<{dimension, score, reason, judge_model, ts}>`:
   - Builds a rubric prompt from the trace (request body + response body + breakdown + injection counts).
   - Calls the judge via the existing retryFetch/llama-swap path (`response_format: json_object`, tolerant parse — reuse the fence-stripping + unwrap logic pattern from consolidation).
   - Returns a bounded score (`0–1` or `1–5`) + one-line reason. Log raw snippet on parse failure (the lesson from the consolidation JSON failures).
3. **Dimensions:**
   - `recall_relevance` — read traces (`/recall`, `/api/cognitive-context`, chat injection): were the returned/injected memories relevant to the query?
   - `extraction_fidelity` — write traces (`/ingest/conversation`, chat): did extraction store the right facts, miss key facts, or add noise? (This is THE quality metric for the memory store — ties directly to the store-hygiene work.)
   - `answer_quality` — chat proxy traces: grounded in injected context, helpful, no hallucination.
4. **Auto-sampling:** `EG_TRACE_AUTO_SCORE_RATE` (default `0` = off; `N` = score every Nth chat/write trace). Fire-and-forget after the trace insert, debounced — never blocks the request. **[DECIDE]** default off vs on for extraction_fidelity.

## Phase 5: GUI — Traces tab

**File:** `apps/web/src/App.tsx` (single-file app)

Follow the documented new-tab recipe (`references/gui-dark-mode.md` — "New tab" section): extend the `Tab` union + `NavButton` + `{activeTab===x && <TracesView/>}` render line + `function TracesView()`.

- **List:** filter row (route/direction/status/scored + limit) → `GET /api/dashboard/traces`; table of ts, route, direction, status, ms, breakdown (genome/phenotype/sectors), score badges.
- **Detail:** click row → `GET /api/dashboard/traces/:id`; JSON panels for request/response (collapsible, monospace), breakdown, scores list, and a **"Score now"** button (dimension select → `POST .../score`).
- **Clear/Prune buttons** in the header (confirm dialog).
- **Type gotchas (this repo):** `@types/react` is unresolved — cast-form `useState(null as null|Date)` style, `(e: any)` param annotations, no hook type-args; `setX((prev: X) => ...)` needs explicit param annotation. `cd apps/web && npm run build` must pass before shipping.

## Phase 6: Config + settings

**Files:** `packages/engram-js/src/configuration/index.ts`, `packages/engram-js/src/services/settingsService.ts`

New keys (all live getters with `process.env` fallback; add the GUI-exposed ones to `GENERAL_SETTINGS`):

| Key | Default | Meaning |
|---|---|---|
| `EG_TRACE_RETENTION_DAYS` | `30` | Hard-delete traces older than N days (prune on boot + piggyback the consolidation scheduler tick) |
| `EG_TRACE_MAX_BODY_CHARS` | `65536` | Cap stored response body size |
| `EG_TRACE_AUTO_SCORE_RATE` | `0` | Score every Nth trace (0 = off) |
| `EG_JUDGE_MODEL` | unset → master | Judge model override |

Prune job: boot-time sweep + reuse the existing consolidation scheduler interval (do not add a second cron framework). Hard DELETE (user preference: hard deletion over soft).

## Phase 7: Verification (change-verification ladder)

1. **Build both containers** — `docker compose build engram` AND `docker compose build web` (backend + SPA touched), then `docker compose up -d` (background; verify in separate call). Stale image = 404 on new routes (documented gotcha).
2. **Schema proof** — `GET /health` shows `schema_version: "4.2.0-traces"`; `docker exec` psql: `SELECT count(*) FROM traces;` = 0 rows, table exists.
3. **Live probe with cleanup** — fire `POST /recall` + `POST /ingest/conversation` + one chat-proxy turn; confirm 3 trace rows with correct `breakdown`; fetch one by id and confirm bodies + redaction; then `DELETE /api/dashboard/traces` and confirm 0 rows (leave no test data).
4. **Score probe** — `POST /api/dashboard/traces/:id/score?dimension=extraction_fidelity` on a known-good ingest trace; confirm `scores` array populated with plausible score + reason.
5. **Regression** — activity buffer/`engram watch`/VS Code observer still work (trace persistence is additive); GUI tabs all render; `npm run build` clean on `apps/web`.
6. Confirm trace routes are NOT written back as traces (no self-recursion storm).

## Files changed (planned)

| File | Change |
|---|---|
| `packages/engram-js/src/durable/schema.ts` | `traces` table + index + version bump |
| `packages/engram-js/src/api/index.ts` | persistence hook in existing capture wrappers + skip-list |
| `packages/engram-js/src/api/routes/dashboard/traces/route.ts` | NEW — list/get/score/clear/prune |
| `packages/engram-js/src/api/routes/index.ts` | register traces route |
| `packages/engram-js/src/api/routes/chat/completions/route.ts` | surface injection stats on response (`_trace.injection`) |
| `packages/engram-js/src/database/modelRegistry.ts` | `"judge"` GenerativeTask + key |
| `packages/engram-js/src/services/traceScorer.ts` | NEW — judge scoring |
| `packages/engram-js/src/configuration/index.ts` + `settingsService.ts` | `EG_TRACE_*` live getters + `GENERAL_SETTINGS` |
| `apps/web/src/App.tsx` | Traces tab (list + detail + score + prune) |
| `readme.md` / `AGENTS.md` | endpoints + settings tables (post-implementation) |

## Open decisions

- [DECIDE] Redact trace bodies by default (secret regex pass) vs. store verbatim with a flag. Leaning: redact-by-default — the June 2026 leaked-sudo-password incident is the cautionary tale.
- [DECIDE] `EG_TRACE_AUTO_SCORE_RATE` default: 0 (manual only) vs. auto-score `extraction_fidelity` (the highest-value metric for store quality).
- [DECIDE] Dedicated judge model row in Settings tab vs. env-only (`EG_JUDGE_MODEL`).

---

## ✅ Implementation Summary

*(append here when implemented — table of files changed, plan↔reality deviations, config flags, verification performed)*
