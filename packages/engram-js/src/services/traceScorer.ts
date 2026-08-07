/*
 - filename: packages/engram-js/src/services/traceScorer.ts
 - what is the file used for: LLM-as-judge scoring for the persistent trace
   store. The judge is a FULLY INDEPENDENT model/provider (Settings tab "Judge"
   section, or EG_JUDGE_MODEL / EG_JUDGE_URL / EG_JUDGE_API_KEY) — deliberately
   NOT tied to the generative chain, so scoring never contends with the active
   chat's generative model (user decision, Aug 2026). Same rubric-judge pattern
   as the benchmark harness, with the tolerant JSON parsing lessons from the
   consolidation engine (strip fences anywhere, unwrap, log raw on failure).
*/

import {
  resolveJudgeModel,
  resolveJudgeProviderUrl,
  resolveJudgeApiKey,
} from "../database/modelRegistry";
import { run_async as pg_run, all_async as pg_all } from "../database/connection";
import { logger } from "../utils/logger";
import { traceAutoScoreRate } from "./traceStore";
import { isKnowledgeQuery } from "./traceStore";

export type TraceDimension = "recall_relevance" | "extraction_fidelity" | "answer_quality";
export const TRACE_DIMENSIONS: TraceDimension[] = [
  "recall_relevance",
  "extraction_fidelity",
  "answer_quality",
];

const JUDGE_TIMEOUT_MS = 60000;
const JUDGE_MAX_TOKENS = 400;

// ── Body helpers (trace bodies are stored via traceStore.encodeBody) ──

function bodyText(body: unknown): string {
  if (body === null || body === undefined) return "";
  if (typeof body === "string") return body;
  const obj = body as any;
  if (obj && typeof obj === "object") {
    if (typeof obj.raw === "string") return obj.raw; // string-wrapped
    if (obj.truncated) return String(obj.raw || obj.text || "").slice(0, 4000);
    if (typeof obj.content === "string") return obj.content;
    if (Array.isArray(obj.results)) {
      return obj.results
        .map((r: any) =>
          typeof r === "string"
            ? r
            : `${r?.score !== undefined ? String(Number(r.score).toFixed(3)) + " | " : ""}${r?.content ?? ""}`,
        )
        .filter(Boolean)
        .join("\n");
    }
    if (obj.messages && Array.isArray(obj.messages)) {
      return obj.messages
        .map((m: any) => `${m?.role || "?"}: ${typeof m?.content === "string" ? m.content : JSON.stringify(m?.content || "")}`)
        .join("\n");
    }
    if (typeof obj.user_prompt === "string" || typeof obj.llm_response === "string") {
      return `USER: ${obj.user_prompt || ""}\nASSISTANT: ${obj.llm_response || ""}`;
    }
  }
  try {
    return JSON.stringify(body).slice(0, 4000);
  } catch {
    return "";
  }
}

/** Extract the assistant's answer text from a captured SSE chat stream. */
function sseAssistantText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let out = "";
  for (const line of raw.split("\n")) {
    const m = line.match(/^data: (.*)$/);
    if (!m) continue;
    const payload = m[1].trim();
    if (payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload);
      const delta = obj?.choices?.[0]?.delta;
      if (typeof delta?.content === "string") out += delta.content;
    } catch {
      /* non-JSON SSE status line — skip */
    }
  }
  return out.slice(0, 4000);
}

// ── Rubrics ─────────────────────────────────────────────────────────────

const RUBRICS: Record<TraceDimension, { system: string; user: (ctx: any) => string }> = {
  recall_relevance: {
    system:
      "You are a strict evaluator of a memory retrieval system. Given a query and the memories the system retrieved, judge TWO axes: RELEVANCE — how relevant and useful is the retrieved set to the query, graded against what was retrieved (on-topic context counts as relevant even when it does not fully answer; do NOT penalize the retrieval for the store lacking the answer — that is a COVERAGE miss, not a relevance failure); COVERAGE — did the store actually contain the answer to the query (1) or not (0)? Respond ONLY with a JSON object of EXACTLY this shape: {\\\"relevance\\\": <0.0-1.0>, \\\"coverage\\\": <0 or 1>, \\\"reason\\\": \\\"<one sentence>\\\"} — e.g. {\\\"relevance\\\": 0.6, \\\"coverage\\\": 0, \\\"reason\\\": \\\"Right topic, but the store lacks the answer.\\\"}. The field is \\\"relevance\\\", NOT \\\"score\\\". Off-topic retrievals must score low relevance; retrievals that find the right topic but not the answer are relevant but coverage 0.",
    user: (c: any) =>
      `QUERY:\n${c.request}\n\nMEMORIES RETRIEVED (scores shown):\n${c.response || "(none)"}\n\nINJECTION STATS:\n${c.injection}\n\nJudge relevance 0.0-1.0 and coverage 0/1.`,
  },
  extraction_fidelity: {
    system:
      "You are a strict evaluator of a memory extraction pipeline. Given a conversation turn and the memories that were ACTUALLY STORED from it, judge extraction fidelity: (a) did extraction capture the durable facts present in the conversation? (b) are the stored memories SPECIFIC and self-contained (not vague announcements like 'important decision: restructure X')? (c) are they correct vs. the conversation, with no invented content? Respond ONLY with JSON: {\"score\": <0.0-1.0>, \"reason\": \"<one sentence>\"}. Missing durable facts, storing noise, or vague announcements must score low.",
    user: (c: any) =>
      c.stored
        ? `CONVERSATION TURN:\n${c.request}\n\nSTORED MEMORIES (extraction output):\n${c.stored}\n\nScore extraction fidelity 0.0-1.0.`
        : `CONVERSATION TURN:\n${c.request}\n\nEXTRACTION SUMMARY:\n${c.response || "(none)"}\n\nScore extraction fidelity 0.0-1.0.`,
  },
  answer_quality: {
    system:
      "You are a strict evaluator of an LLM answer produced with injected memory context. Judge the ASSISTANT ANSWER on: grounding in the provided context (no hallucination), accuracy, and helpfulness. Respond ONLY with JSON: {\"score\": <0.0-1.0>, \"reason\": \"<one sentence>\"}.",
    user: (c: any) =>
      `USER PROMPT:\n${c.request}\n\nINJECTED MEMORY STATS:\n${c.injection}\n\nASSISTANT ANSWER:\n${c.response || "(empty)"}\n\nScore answer quality 0.0-1.0.`,
  },
};

async function buildRubric(dimension: TraceDimension, trace: any): Promise<{ system: string; user: string }> {
  const request = bodyText(trace.request_body);
  let response = bodyText(trace.response_body);
  if (dimension === "answer_quality" && typeof trace.response_body === "object") {
    const raw = (trace.response_body as any)?.raw;
    if (typeof raw === "string" && raw.includes("data:")) response = sseAssistantText(raw);
  }
  const injection = trace.injection ? JSON.stringify(trace.injection) : "n/a";
  // True extraction-fidelity (v4.7.0): grade the STORED output, not the receipt.
  let stored: string | null = null;
  if (dimension === "extraction_fidelity") {
    const ids = (trace.response_body as any)?.stored_memory_ids;
    if (Array.isArray(ids) && ids.length) {
      const rows = await pg_all(`SELECT content, sector FROM public.memories WHERE id = ANY($1)`, [ids]).catch(() => []);
      if (rows.length) {
        stored = rows.map((r: any) => `[${r.sector ?? "?"}] ${r.content}`).join("\n");
      }
    }
  }
  const r = RUBRICS[dimension];
  return { system: r.system, user: r.user({ request, response, injection, stored }) };
}

// ── Tolerant JSON parse (fences anywhere, outermost object, log raw) ──

export function parseJudge(content: string): { score: number; reason: string; coverage?: number } | null {
  let text = content.trim().replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    let score = Number(obj.score);
    if (!Number.isFinite(score)) score = Number(obj.relevance); // two-axis rubric field
    if (!Number.isFinite(score) || score < 0 || score > 1) return null;
    const coverage = obj.coverage === undefined ? undefined : Number(obj.coverage) ? 1 : 0;
    return {
      score: Math.round(score * 100) / 100,
      reason: typeof obj.reason === "string" ? obj.reason.slice(0, 500) : "",
      ...(coverage !== undefined ? { coverage } : {}),
    };
  } catch {
    return null;
  }
}

// ── Scoring ─────────────────────────────────────────────────────────────

// ── Generic judge call (shared by trace scoring AND the integrity engine's
//    memory-validity rubric). Returns the raw assistant content; callers parse. ──

export async function callJudge(
  system: string,
  user: string,
): Promise<{ ok: boolean; content?: string; error?: string; ms?: number; model?: string }> {
  const model = resolveJudgeModel();
  const baseUrl = resolveJudgeProviderUrl();
  const apiKey = resolveJudgeApiKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: JUDGE_MAX_TOKENS,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const ms = Date.now() - started;
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).substring(0, 300);
    logger.warn({ module: "traceScorer", status: res.status, ms }, `judge HTTP ${res.status}`);
    return { ok: false, error: `judge HTTP ${res.status}: ${text}` };
  }
  const data: any = await res.json().catch(() => null);
  const content: string =
    typeof data?.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content : "";
  return { ok: true, content, ms, model };
}

export async function scoreTrace(
  id: string,
  dimension: TraceDimension,
  opts: { persist?: boolean } = {},
): Promise<{ ok: boolean; error?: string; raw?: string; score?: number; reason?: string; judge_model?: string; ms?: number; ts?: string }> {
  const persist = opts.persist !== false;
  try {
    const rows = await pg_all(`SELECT * FROM public.traces WHERE id = $1`, [id]);
    const trace = rows[0];
    if (!trace) return { ok: false, error: "trace_not_found" };

    const model = resolveJudgeModel();
    const { system, user } = await buildRubric(dimension, trace);

    const judge = await callJudge(system, user);
    const ms = judge.ms ?? 0;
    if (!judge.ok) {
      return { ok: false, error: judge.error };
    }
    const content = judge.content || "";
    const parsed = parseJudge(content);
    if (!parsed) {
      logger.warn({ module: "traceScorer", snippet: content.slice(0, 500) }, "judge returned unparseable JSON");
      return { ok: false, error: "judge returned unparseable JSON", raw: content.slice(0, 300) };
    }

    const entry = {
      dimension,
      score: parsed.score,
      reason: parsed.reason,
      judge_model: model,
      ms,
      ts: new Date().toISOString(),
      ...(parsed.coverage !== undefined ? { coverage: parsed.coverage } : {}),
    };
    if (persist) {
      const scores = Array.isArray(trace.scores) ? trace.scores : [];
      await pg_run(`UPDATE public.traces SET scores = $2::jsonb WHERE id = $1`, [
        id,
        JSON.stringify([...scores, entry]),
      ]);
    }
    return { ok: true, ...entry };
  } catch (e: any) {
    logger.warn({ module: "traceScorer", err: e?.message }, "scoreTrace failed");
    return { ok: false, error: e?.message || String(e) };
  }
}

// ── Catch-up scoring (v4.7.2): auto-drain eligible unscored traces ──
// Auto-score fails silently when the judge call times out under load; this
// scheduled pass retries them. Applies the SAME correctness filters as the
// report stats: receipt-era ingests (no stored ids) and conversational
// recalls are skipped — they can't produce a meaningful score, so they stay
// honestly unscored rather than re-creating the artifact class.

let catchupRunning = false;

export async function runCatchupScoring(
  max = 10,
): Promise<{ attempted: number; scored: number; failed: number; skipped_ineligible: number; skipped_running?: boolean }> {
  if (catchupRunning) return { attempted: 0, scored: 0, failed: 0, skipped_ineligible: 0, skipped_running: true };
  catchupRunning = true;
  try {
    const rows = await pg_all(
      `SELECT id, label, request_body, response_body FROM public.traces
       WHERE (scores IS NULL OR jsonb_array_length(scores) = 0)
         AND status < 400
         AND label IN ('chat', 'ingest', 'remember', 'recall')
       ORDER BY ts ASC LIMIT ${Math.min(Math.max(Number(max) || 10, 1), 50)}`,
      [],
    );
    let attempted = 0;
    let scored = 0;
    let failed = 0;
    let skipped = 0;
    for (const t of rows) {
      const dim = autoScoreDimensionFor(t);
      if (!dim) {
        skipped++;
        continue;
      }
      if (dim === "extraction_fidelity") {
        const ids = (t.response_body as any)?.stored_memory_ids;
        if (!(Array.isArray(ids) && ids.length > 0)) {
          skipped++; // receipt-era — no meaningful fidelity score possible
          continue;
        }
      }
      if (dim === "recall_relevance") {
        const q = (t.request_body as any)?.query;
        if (!isKnowledgeQuery(typeof q === "string" ? q : "")) {
          skipped++; // conversational — not a knowledge query
          continue;
        }
      }
      attempted++;
      const r = await scoreTrace(t.id, dim, { persist: true });
      if (r.ok) scored++;
      else failed++;
    }
    if (attempted > 0) {
      logger.info({ module: "traceScorer", attempted, scored, failed, skipped }, `catch-up scoring pass done`);
    }
    return { attempted, scored, failed, skipped_ineligible: skipped };
  } finally {
    catchupRunning = false;
  }
}

// ── Auto-scoring (EG_TRACE_AUTO_SCORE_RATE: 0 = off, N = every Nth) ──

let autoScoreCounter = 0;

export function autoScoreDimensionFor(trace: { label?: string }): TraceDimension | null {
  const label = trace.label || "";
  if (label === "chat") return "answer_quality";
  if (label === "ingest" || label === "remember") return "extraction_fidelity";
  if (label === "recall") return "recall_relevance";
  return null;
}

/** Fire-and-forget: score an eligible trace when the rate hits. Skips failed
 *  requests (status >= 400) — a 404 chat turn isn't worth judging. */
export function maybeAutoScore(trace: { id: string; label?: string; status?: number }): void {
  const rate = traceAutoScoreRate();
  if (rate <= 0) return;
  if (typeof trace.status === "number" && trace.status >= 400) return;
  const dimension = autoScoreDimensionFor(trace);
  if (!dimension) return;
  autoScoreCounter = (autoScoreCounter + 1) % rate;
  if (autoScoreCounter !== 0) return;
  scoreTrace(trace.id, dimension)
    .then((r) => {
      if (r.ok) {
        logger.info({ module: "traceScorer", id: trace.id, dimension, score: r.score }, `auto-scored trace`);
      } else if (/no judge/i.test(r.error || "")) {
        // judge not configured yet — silent (debug) until the user sets it
        logger.debug({ module: "traceScorer", id: trace.id, error: r.error }, "auto-score skipped (judge unconfigured)");
      } else {
        logger.warn({ module: "traceScorer", id: trace.id, error: r.error }, "auto-score failed");
      }
    })
    .catch(() => {});
}

/** Backfill: score every unscored eligible trace (oldest first, bounded batch).
 *  Auto-score covers NEW traces at capture time; this covers traces recorded
 *  before the judge existed. Re-invoke for the next batch. */
export async function scoreAllUnscored(
  limit = 25,
): Promise<{ scored: number; failed: number; skipped: number; remaining: number }> {
  const rows = await pg_all(
    `SELECT id, label, status FROM public.traces
     WHERE jsonb_array_length(coalesce(scores, '[]'::jsonb)) = 0
       AND (status IS NULL OR status < 400)
     ORDER BY ts ASC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 100)],
  );
  let scored = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of rows) {
    const dim = autoScoreDimensionFor(row);
    if (!dim) {
      skipped++;
      continue;
    }
    const r = await scoreTrace(row.id, dim);
    if (r.ok) scored++;
    else failed++;
  }
  const remainingRows = await pg_all(
    `SELECT count(*)::int AS n FROM public.traces
     WHERE jsonb_array_length(coalesce(scores, '[]'::jsonb)) = 0
       AND (status IS NULL OR status < 400)`,
    [],
  );
  return { scored, failed, skipped, remaining: remainingRows[0]?.n || 0 };
}
