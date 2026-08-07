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

/** Policy score thresholds (Settings → General → Policy, or EG_POLICY_*_THRESHOLD).
 *  Drive the distribution buckets, suggestions, policy alerts, and the review
 *  loop. Clamped to (0,1] with good strictly above bad. */
export function policyThresholds(): { good: number; bad: number } {
  const parse = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= 1 ? n : d;
  };
  let good = parse(process.env.EG_POLICY_GOOD_THRESHOLD, 0.7);
  let bad = parse(process.env.EG_POLICY_BAD_THRESHOLD, 0.4);
  if (bad >= good) bad = Math.max(good - 0.1, 0.1);
  return { good, bad };
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

/** True when a string contains a credential-like pattern (integrity check). */
export function containsSecret(value: string): boolean {
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0; // /g patterns are stateful — reset before test
    if (re.test(value)) return true;
  }
  return false;
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
  review?: string; // "1" = unreviewed traces with a score below the bad threshold
  since?: string;
  until?: string;
  limit?: string | number;
  offset?: string | number;
}

/** A trace "needs review" when it carries a low score AND is not one of the
 *  known-noise classes: conversational (non-question) /recall traces, ingest
 *  receipts where facts WERE stored (the judge grades the receipt, not the
 *  stored facts), POST /memories receipts, and non-200 (already-error) traces.
 *  Added 2026-08-07 after the 41-flag flood — the real gap signal for
 *  knowledge queries lives in the recall-gap engine instead. */
function needsReviewSql(bad: number): string {
  return `(
    reviewed_at IS NULL
    AND status < 400
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(scores, '[]'::jsonb)) s WHERE (s->>'score')::numeric < ${bad})
    AND NOT (
      route LIKE '/recall%'
      AND (request_body->>'query' IS NULL OR request_body->>'query' !~* '\\?|^(what|how|why|when|where|which|who|does|do|can|could|would|should|explain|define|describe)')
    )
    AND NOT (route LIKE '/ingest%' AND COALESCE((response_body->'extraction'->>'stored_count')::int, 0) > 0)
    AND NOT (route = '/memories' AND method = 'POST')
  )`;
}

/** List rows WITHOUT full bodies (summary + breakdown + scores + review state). */
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
  const policy = policyThresholds();
  if (f.review === "1" || f.review === "true") {
    params.push(policy.bad);
    where.push(
      `reviewed_at IS NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(scores, '[]'::jsonb)) s WHERE (s->>'score')::numeric < $${params.length})`,
    );
  }
  if (f.since) push("ts", ">=", new Date(String(f.since)).toISOString());
  if (f.until) push("ts", "<=", new Date(String(f.until)).toISOString());
  const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 500);
  const offset = Math.max(Number(f.offset) || 0, 0);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return pg_all(
    `SELECT id, ts, route, method, status, ms, direction, kind, label, model, breakdown, injection, scores, error, reviewed_at,
       (${needsReviewSql(policy.bad)}) AS needs_review
     FROM public.traces ${whereSql}
     ORDER BY ts DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
}

/** Mark a trace as reviewed (clears the needs-review flag). */
export async function markTraceReviewed(id: string): Promise<boolean> {
  const rows = await pg_all(`UPDATE public.traces SET reviewed_at = now() WHERE id = $1 RETURNING id`, [id]);
  return rows.length > 0;
}

/** Full row including request_body / response_body (+ review state). */
export async function getTrace(id: string): Promise<any | null> {
  const bad = policyThresholds().bad;
  const rows = await pg_all(
    `SELECT *, (${needsReviewSql(bad)}) AS needs_review
     FROM public.traces WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

export async function deleteAllTraces(): Promise<number> {
  const rows = await pg_all(`DELETE FROM public.traces RETURNING id`, []);
  return rows.length;
}

/** Hard-delete a single trace (and its calibration entries via FK cascade). */
export async function deleteTrace(id: string): Promise<boolean> {
  const rows = await pg_all(`DELETE FROM public.traces WHERE id = $1 RETURNING id`, [id]);
  return rows.length > 0;
}

export async function pruneTraces(days?: number): Promise<number> {
  const d = Number(days) || traceRetentionDays();
  const rows = await pg_all(
    `DELETE FROM public.traces WHERE ts < now() - make_interval(days => $1) RETURNING id`,
    [d],
  );
  return rows.length;
}

// ── Facets (for GUI dropdowns — distinct values from real data) ────────

export async function traceFacets(): Promise<{ routes: string[]; statuses: number[]; policy: { good: number; bad: number } }> {
  const [r, s] = await Promise.all([
    pg_all(`SELECT DISTINCT route FROM public.traces ORDER BY route`, []),
    pg_all(`SELECT DISTINCT status FROM public.traces WHERE status IS NOT NULL ORDER BY status`, []),
  ]);
  return {
    routes: r.map((x: any) => x.route).filter(Boolean),
    statuses: s.map((x: any) => x.status),
    policy: policyThresholds(),
  };
}

// ── Report aggregation (real data, no LLM) ─────────────────────────────

export interface TraceReportOptions {
  days?: number;
  from?: string; // ISO date-time
  to?: string; // ISO date-time
  route?: string;
  direction?: string;
  status?: number;
  limit?: number;
}

export interface TraceReport {
  window_days: number;
  from: string | null;
  to: string | null;
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
  policy: { good: number; bad: number };
  policy_alerts: Array<{ severity: "high" | "medium"; dimension: string | null; message: string }>;
}

/** Aggregate the trace store over a window — volume, errors, latency, score
 *  stats per dimension, good/medium/bad distribution, and the lowest-scored
 *  traces (the actionable signal). Pure SQL+JS, no LLM call. Filters:
 *  days (relative window, default 7), from/to (ISO bounds, override the
 *  window floor), route, direction. */
export async function traceReport(opts: TraceReportOptions = {}): Promise<TraceReport> {
  const d = Math.min(Math.max(Number(opts.days) || 7, 1), 365);
  const where: string[] = [`ts >= now() - make_interval(days => $1)`];
  const params: any[] = [d];
  if (opts.from) {
    params.push(new Date(opts.from).toISOString());
    where.push(`ts >= $${params.length}`);
  }
  if (opts.to) {
    params.push(new Date(opts.to).toISOString());
    where.push(`ts <= $${params.length}`);
  }
  if (opts.route) {
    params.push(opts.route);
    where.push(`route = $${params.length}`);
  }
  if (opts.direction) {
    params.push(opts.direction);
    where.push(`direction = $${params.length}`);
  }
  if (opts.status !== undefined && opts.status !== null) {
    params.push(Number(opts.status));
    where.push(`status = $${params.length}`);
  }
  const rows = await pg_all(
    `SELECT ts, route, direction, label, status, ms, breakdown, scores
     FROM public.traces
     WHERE ${where.join(" AND ")}
     ORDER BY ts DESC`,
    params,
  );

  const byRoute: Record<string, number> = {};
  const byDirection: Record<string, number> = {};
  const byLabel: Record<string, number> = {};
  const scoreByDim: Record<string, { count: number; sum: number; min: number; max: number }> = {};
  const policy = policyThresholds();
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
      if (sc >= policy.good) dist.good++;
      else if (sc >= policy.bad) dist.medium++;
      else dist.bad++;
      if (typeof s.judge_model === "string") judgeSet.add(s.judge_model);
      if (sc < policy.bad) {
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
  const worstSlice = worst.slice(0, Math.min(Math.max(Number(opts.limit) || 10, 1), 50));

  const scoreStats: Record<string, { count: number; avg: number; min: number; max: number }> = {};
  for (const [k, v] of Object.entries(scoreByDim)) {
    scoreStats[k] = {
      count: v.count,
      avg: Math.round((v.sum / v.count) * 100) / 100,
      min: v.min === Infinity ? 0 : v.min,
      max: v.max === -Infinity ? 0 : v.max,
    };
  }

  // Policy alerts: dimension averages below thresholds (with enough samples),
  // and any failed requests. The governance surface for "something is not right".
  const policyAlerts: TraceReport["policy_alerts"] = [];
  for (const [dim, st] of Object.entries(scoreStats)) {
    if (st.count >= 3 && st.avg < policy.bad) {
      policyAlerts.push({
        severity: "high",
        dimension: dim,
        message: `${dim} average ${st.avg} is BELOW the bad threshold (${policy.bad}) across ${st.count} scores`,
      });
    } else if (st.count >= 3 && st.avg < policy.good) {
      policyAlerts.push({
        severity: "medium",
        dimension: dim,
        message: `${dim} average ${st.avg} is below the good threshold (${policy.good}) across ${st.count} scores`,
      });
    }
  }
  if (errors > 0) {
    policyAlerts.push({
      severity: "high",
      dimension: null,
      message: `${errors} failed request(s) (status >= 400) in the window`,
    });
  }

  return {
    window_days: d,
    from: opts.from ? new Date(opts.from).toISOString() : null,
    to: opts.to ? new Date(opts.to).toISOString() : null,
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
    policy,
    policy_alerts: policyAlerts,
  };
}
