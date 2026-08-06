/*
 - filename: packages/engram-js/src/services/traceStore.ts
 - what is the file used for: persistent request-trace store (v4.2.0-traces).
   Captures the memory/agent loop (recall, ingest, memories, chat proxy,
   cognitive-context, consolidation, settings saves) with full request/response
   bodies — regex-redacted for secrets (mirrors Hermes security.redact_secrets),
   genome/phenotype/sector breakdown, and judge scores. Written fire-and-forget
   from the request middleware — tracing must never block a response.
*/

import { run_async as pg_run, all_async as pg_all } from "../database/connection";
import { logger } from "../utils/logger";

// ── Config (values mirrored from GENERAL_SETTINGS → process.env at boot + on
//    GUI save, so plain process.env reads are live — the frozen-env trap does
//    not apply to call-time reads) ──
const TRACE_RETENTION_DEFAULT_DAYS = 30;
const TRACE_MAX_BODY_DEFAULT = 65536;

export function traceRetentionDays(): number {
  const n = Number(process.env.EG_TRACE_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : TRACE_RETENTION_DEFAULT_DAYS;
}

export function traceMaxBodyChars(): number {
  const n = Number(process.env.EG_TRACE_MAX_BODY_CHARS);
  return Number.isFinite(n) && n > 0 ? n : TRACE_MAX_BODY_DEFAULT;
}

/** 0 = off; N = auto-score every Nth eligible trace (chat/ingest/recall). Default 1 = score every eligible trace (user decision). */
export function traceAutoScoreRate(): number {
  const n = Number(process.env.EG_TRACE_AUTO_SCORE_RATE);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
}

// ── Route selection: the memory/agent loop, NOT GUI telemetry. Polling
//    endpoints (activity, logs, stats, settings GET) are excluded deliberately
//    so the store holds signal, not dashboard noise. ──
export function isTraceableRoute(method: string, url: string): boolean {
  const u = url.split("?")[0];
  if (u.startsWith("/api/dashboard/traces")) return false; // never self-trace
  if (u === "/health") return false;
  // Reads: recall + the Hermes sidecar prefetch path
  if (method === "POST" && (u === "/recall" || u === "/api/dashboard/recall" || u === "/api/cognitive-context")) return true;
  // Writes: explicit remember + native extraction paths
  if (method === "POST" && (u === "/memories" || u === "/ingest" || u === "/ingest/conversation" || u === "/ingest/document" || u === "/ingest/event")) return true;
  if (method === "DELETE" && u.startsWith("/memories/")) return true;
  // Chat proxy: full SSE stream captured (capped)
  if (u === "/v1/chat/completions") return true;
  // Explicit maintenance actions
  if (method === "POST" && u === "/api/dashboard/consolidate") return true;
  if (method === "PUT" && u === "/api/settings") return true;
  return false;
}

// ── Secret redaction — mirrors Hermes's security.redact_secrets approach:
//    regex-scan credential-like strings, store everything else verbatim. ──
const SECRET_PATTERNS: RegExp[] = [
  // key=value / key: value assignments (catches `password '1212'`-style leaks)
  /(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|bearer|client[_-]?secret)\s*[:=]\s*['"]?[^\s'",}]{6,}/gi,
  // JWTs
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // OpenAI-style sk- keys
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  // GitHub tokens
  /\bghp_[A-Za-z0-9]{16,}\b/g,
  // Slack tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // AWS access key IDs
  /\bAKIA[0-9A-Z]{16}\b/g,
  // PEM private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactSecrets(value: string): string {
  let out = value;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

export function redactPayload(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactPayload);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactPayload(v);
    }
    return out;
  }
  return value;
}

// ── Body encoding: redact, then cap at EG_TRACE_MAX_BODY_CHARS. Objects that
//    fit are stored as-is (nice JSON rendering in the GUI); strings are wrapped
//    {raw}; oversized payloads become {truncated, raw}. ──
function encodeBody(raw: unknown): unknown {
  if (raw === undefined || raw === null) return null;
  const redacted = redactPayload(raw);
  const max = traceMaxBodyChars();
  let text: string;
  try {
    text = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
  } catch {
    return { error: "unserializable_body" };
  }
  if (text.length <= max) {
    if (typeof redacted === "string") return { raw: redacted };
    return redacted;
  }
  return { truncated: true, raw: text.slice(0, max) };
}

export interface TraceRecord {
  id: string;
  ts: number;
  route: string;
  method: string;
  status: number;
  ms: number;
  direction: string;
  kind: string;
  label: string;
  sessionId?: string;
  projectId?: string;
  userId?: string;
  model?: string;
  requestBody?: unknown;
  responseBody?: unknown;
  breakdown?: unknown;
  injection?: unknown;
  error?: string;
}

/** Fire-and-forget insert — never awaited in the hot path. */
export function persistTrace(rec: TraceRecord): void {
  const sql = `INSERT INTO public.traces
    (id, ts, route, method, status, ms, direction, kind, label, session_id, project_id, user_id, model, request_body, response_body, breakdown, injection, error)
    VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18)`;
  pg_run(sql, [
    rec.id,
    rec.ts,
    rec.route,
    rec.method,
    rec.status,
    rec.ms,
    rec.direction,
    rec.kind,
    rec.label,
    rec.sessionId ?? null,
    rec.projectId ?? null,
    rec.userId ?? null,
    rec.model ?? null,
    JSON.stringify(encodeBody(rec.requestBody)),
    JSON.stringify(encodeBody(rec.responseBody)),
    rec.breakdown ? JSON.stringify(rec.breakdown) : null,
    rec.injection ? JSON.stringify(rec.injection) : null,
    rec.error ?? null,
  ]).catch((e: any) => {
    logger.warn({ module: "traceStore", err: e?.message }, "trace persist failed");
  });
}

// ── Queries ─────────────────────────────────────────────────────────────

export interface TraceFilter {
  route?: string;
  direction?: string;
  kind?: string;
  status?: string;
  model?: string;
  sector?: string;
  scored?: string | boolean;
  since?: string;
  until?: string;
  limit?: string | number;
  offset?: string | number;
}

/** List rows WITHOUT full bodies (summary + breakdown + scores). */
export async function listTraces(f: TraceFilter = {}): Promise<any[]> {
  const where: string[] = [];
  const params: any[] = [];
  const push = (col: string, op: string, v: any) => {
    params.push(v);
    where.push(`${col} ${op} $${params.length}`);
  };
  if (f.route) push("route", "=", f.route);
  if (f.direction) push("direction", "=", f.direction);
  if (f.kind) push("kind", "=", f.kind);
  if (f.status !== undefined && f.status !== "") push("status", "=", Number(f.status));
  if (f.model) push("model", "=", f.model);
  if (f.sector) {
    params.push(f.sector);
    where.push(`breakdown->'sectors' ? $${params.length}`);
  }
  if (f.scored === "true" || f.scored === true || f.scored === "1") {
    where.push(`jsonb_array_length(coalesce(scores, '[]'::jsonb)) > 0`);
  }
  if (f.since) push("ts", ">=", new Date(String(f.since)).toISOString());
  if (f.until) push("ts", "<=", new Date(String(f.until)).toISOString());
  const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 500);
  const offset = Math.max(Number(f.offset) || 0, 0);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return pg_all(
    `SELECT id, ts, route, method, status, ms, direction, kind, label, model, breakdown, injection, scores, error
     FROM public.traces ${whereSql}
     ORDER BY ts DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
}

/** Full row including request_body / response_body. */
export async function getTrace(id: string): Promise<any | null> {
  const rows = await pg_all(`SELECT * FROM public.traces WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function deleteAllTraces(): Promise<number> {
  const rows = await pg_all(`DELETE FROM public.traces RETURNING id`, []);
  return rows.length;
}

export async function pruneTraces(days?: number): Promise<number> {
  const d = Number(days) || traceRetentionDays();
  const rows = await pg_all(
    `DELETE FROM public.traces WHERE ts < now() - make_interval(days => $1) RETURNING id`,
    [d],
  );
  return rows.length;
}

// ── Report aggregation (real data, no LLM) ─────────────────────────────

export interface TraceReport {
  window_days: number;
  total: number;
  by_route: Record<string, number>;
  by_direction: Record<string, number>;
  by_label: Record<string, number>;
  errors: number;
  avg_ms: number | null;
  score_stats: Record<string, { count: number; avg: number; min: number; max: number }>;
  score_distribution: { good: number; medium: number; bad: number };
  worst: Array<{ ts: string; route: string; dimension: string; score: number; reason: string; judge_model: string }>;
  breakdown_totals: { genome: number; phenotype: number; sectors: Record<string, number> };
  judge_models: string[];
}

/** Aggregate the trace store over a window — volume, errors, latency, score
 *  stats per dimension, good/medium/bad distribution, and the lowest-scored
 *  traces (the actionable signal). Pure SQL+JS, no LLM call. */
export async function traceReport(days = 7, limit = 10): Promise<TraceReport> {
  const d = Math.min(Math.max(Number(days) || 7, 1), 90);
  const rows = await pg_all(
    `SELECT ts, route, direction, label, status, ms, breakdown, scores
     FROM public.traces
     WHERE ts >= now() - make_interval(days => $1)
     ORDER BY ts DESC`,
    [d],
  );

  const byRoute: Record<string, number> = {};
  const byDirection: Record<string, number> = {};
  const byLabel: Record<string, number> = {};
  const scoreByDim: Record<string, { count: number; sum: number; min: number; max: number }> = {};
  const dist = { good: 0, medium: 0, bad: 0 };
  const bdTotals: { genome: number; phenotype: number; sectors: Record<string, number> } = {
    genome: 0,
    phenotype: 0,
    sectors: {},
  };
  const judgeSet = new Set<string>();
  const worst: Array<{ ts: string; route: string; dimension: string; score: number; reason: string; judge_model: string }> = [];
  let errors = 0;
  let msSum = 0;
  let msN = 0;

  for (const t of rows) {
    byRoute[t.route] = (byRoute[t.route] || 0) + 1;
    byDirection[t.direction] = (byDirection[t.direction] || 0) + 1;
    byLabel[t.label] = (byLabel[t.label] || 0) + 1;
    if (typeof t.status === "number" && t.status >= 400) errors++;
    if (typeof t.ms === "number") {
      msSum += t.ms;
      msN++;
    }
    const bd = t.breakdown;
    if (bd) {
      bdTotals.genome += Number(bd.genome) || 0;
      bdTotals.phenotype += Number(bd.phenotype) || 0;
      for (const [k, v] of Object.entries(bd.sectors || {})) {
        bdTotals.sectors[k] = (bdTotals.sectors[k] || 0) + (Number(v) || 0);
      }
    }
    for (const s of t.scores || []) {
      const dim = s.dimension || "unknown";
      const st = scoreByDim[dim] || { count: 0, sum: 0, min: Infinity, max: -Infinity };
      st.count++;
      st.sum += Number(s.score) || 0;
      st.min = Math.min(st.min, Number(s.score) || 0);
      st.max = Math.max(st.max, Number(s.score) || 0);
      scoreByDim[dim] = st;
      const sc = Number(s.score) || 0;
      if (sc >= 0.7) dist.good++;
      else if (sc >= 0.4) dist.medium++;
      else dist.bad++;
      if (typeof s.judge_model === "string") judgeSet.add(s.judge_model);
      if (sc < 0.4) {
        worst.push({
          ts: t.ts,
          route: t.route,
          dimension: dim,
          score: sc,
          reason: typeof s.reason === "string" ? s.reason : "",
          judge_model: typeof s.judge_model === "string" ? s.judge_model : "",
        });
      }
    }
  }
  worst.sort((a, b) => a.score - b.score);
  const worstSlice = worst.slice(0, Math.min(Math.max(Number(limit) || 10, 1), 50));

  const scoreStats: Record<string, { count: number; avg: number; min: number; max: number }> = {};
  for (const [k, v] of Object.entries(scoreByDim)) {
    scoreStats[k] = {
      count: v.count,
      avg: Math.round((v.sum / v.count) * 100) / 100,
      min: v.min === Infinity ? 0 : v.min,
      max: v.max === -Infinity ? 0 : v.max,
    };
  }

  return {
    window_days: d,
    total: rows.length,
    by_route: byRoute,
    by_direction: byDirection,
    by_label: byLabel,
    errors,
    avg_ms: msN ? Math.round(msSum / msN) : null,
    score_stats: scoreStats,
    score_distribution: dist,
    worst: worstSlice,
    breakdown_totals: bdTotals,
    judge_models: Array.from(judgeSet),
  };
}
