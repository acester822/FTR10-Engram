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
import { isEngramStatus } from "./engramStatus";

export type TraceDimension = "recall_relevance" | "extraction_fidelity" | "answer_quality";
export const TRACE_DIMENSIONS: TraceDimension[] = [
  "recall_relevance",
  "extraction_fidelity",
  "answer_quality",
];

const JUDGE_TIMEOUT_MS = 300000;
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
      if (!delta) continue;
      // v4.7.10: some providers (deepseek-reasoner-style, NOUS/Novita) put the
      // real answer in `reasoning` / `reasoning_content`, not `content`. Concat
      // both so the judge (and extraction) see the actual response, not just
      // the status chunk. Skip Engram's own transparent-proxy status lines.
      const pieces = [delta.content, delta.reasoning, delta.reasoning_content].filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      );
      for (const p of pieces) {
        if (!isEngramStatus(p)) out += p;
      }
    } catch { /* non-JSON SSE status line — skip */ }
  }
  return out.slice(0, 4000);
}

/** Hard-cap text sent to the judge model. Engram captures full Hermes
 *  transcripts (multi-KB system prompt + tool I/O) that exceed the judge
 *  box's 16K context window. The judge grades quality, not transcript
 *  fidelity, so ~6000 chars (~1500 tokens) with head+tail preserved is
 *  plenty and leaves room for the rubric + system prompt. */
function trimForJudge(s: string, max = 6000): string {
  if (!s) return "";
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return s.slice(0, head) + `\n…[${s.length - max} chars trimmed]…\n` + s.slice(s.length - tail);
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

/** Extract a clean {user, assistant} pair from a captured chat/completions
 *  body (which may be a {raw: "<stringified JSON or SSE>"} envelope). The
 *  judge scores answer QUALITY, so it needs the actual user prompt and the
 *  actual assistant answer — NOT the serialized request/response envelopes.
 *  Bodies may be truncated mid-JSON (EG_TRACE_MAX_BODY_CHARS), so we fall
 *  back to a tolerant regex extraction when JSON.parse fails. */
function extractChatTurn(body: unknown): { user: string; assistant: string } {
  const raw = typeof body === "string"
    ? body
    : (body as any)?.raw ?? (typeof body === "object" ? JSON.stringify(body) : "");
  const text = typeof raw === "string" ? raw : String(raw ?? "");

  // SSE stream (assistant answer)
  const assistant = text.includes("data:") ? sseAssistantText(text) : "";

  // Try structured parse (full JSON, or JSON inside a raw envelope)
  let messages: any[] = [];
  try {
    const parsed = typeof text === "string" ? JSON.parse(text) : text;
    if (parsed && Array.isArray(parsed.messages)) messages = parsed.messages;
    // v4.7.11: /v1/chat/completions/extract sends {conversation:[{role,content}...]}
    else if (parsed && Array.isArray(parsed.conversation)) messages = parsed.conversation;
    // v5.0.1: /ingest/conversation bodies are {user_prompt, llm_response, ...}
    // — not a messages array, and the tolerant regex below can't see that
    // shape. extractChatTurn returned "(no user message found)", so the judge
    // graded an empty turn and produced artifact 0.0 extraction_fidelity on
    // every Hermes-sidecar ingest.
    else if (parsed && (typeof parsed.user_prompt === "string" || typeof parsed.llm_response === "string")) {
      messages = [
        { role: "user", content: parsed.user_prompt || "" },
        { role: "assistant", content: parsed.llm_response || "" },
      ];
    } else if (parsed && typeof parsed.raw === "string") {
      const inner = JSON.parse(parsed.raw);
      if (inner && Array.isArray(inner.messages)) messages = inner.messages;
      else if (inner && Array.isArray(inner.conversation)) messages = inner.conversation;
      // v5.0.1: raw-envelope variant of the same shape.
      else if (typeof inner.user_prompt === "string" || typeof inner.llm_response === "string") {
        messages = [
          { role: "user", content: inner.user_prompt || "" },
          { role: "assistant", content: inner.llm_response || "" },
        ];
      }
    }
  } catch { /* truncated/escaped — fall through to regex */ }

  if (messages.length === 0) {
    // Tolerant fallback: find the LAST "role":"user" block and its content
    const m = [...text.matchAll(/"role"\s*:\s*"user"\s*,\s*"content"\s*:\s*("(?:[^"\\]|\\.)*"|\[[\s\S]*?\])/g)];
    if (m.length) {
      let c = m[m.length - 1][1];
      try { c = JSON.parse(c); } catch { /* leave as string */ }
      const userMsg = Array.isArray(c) ? c.map((x: any) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n") : String(c);
      return { user: userMsg.trim() || "(no user message found)", assistant: assistant || "(no assistant answer found)" };
    }
    return { user: "(no user message found)", assistant: assistant || "(no assistant answer found)" };
  }

  const userMsg = messages
    .filter((m) => m?.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
    .join("\n")
    .trim();

  // v4.7.11: for {conversation:[...]} bodies the assistant answer is IN the
  // array (the /extract route's response is just the storage receipt) — pull
  // the LAST assistant entry when no SSE answer was found.
  let asst = assistant;
  if (!asst) {
    const asstMsgs = messages
      .filter((m) => m?.role === "assistant")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")));
    if (asstMsgs.length) asst = asstMsgs[asstMsgs.length - 1].trim();
  }

  return { user: userMsg || "(no user message found)", assistant: asst || "(no assistant answer found)" };
}

async function buildRubric(dimension: TraceDimension, trace: any): Promise<{ system: string; user: string }> {
  // v4.7.10: trim request/response to a safe budget BEFORE building the rubric.
  // Engram captures full Hermes transcripts (multi-KB system prompt + tool I/O),
  // which blow past the judge box's 16K context window (REAP20) → 400 on every
  // chat/ingest trace. The judge grades quality, not transcript fidelity, so a
  // hard cap (~6000 chars ≈ ~1500 tokens) is plenty and leaves headroom.
  const chat = extractChatTurn(trace.request_body);
  const request = trimForJudge(chat.user);
  let response = trimForJudge(chat.assistant);
  if (dimension === "answer_quality" && typeof trace.response_body === "object") {
    const raw = (trace.response_body as any)?.raw;
    if (typeof raw === "string" && raw.includes("data:")) response = trimForJudge(sseAssistantText(raw));
  }
  const injection = trace.injection ? JSON.stringify(trace.injection) : "n/a";
  // v4.7.10: recall_relevance traces have a DIFFERENT shape than chat turns —
  // request_body is {query}, response_body is {results:[{content,score}]}.
  // Feed those to the judge instead of the chat-turn extraction.
  // v4.7.11: grade ONLY the injected Engram portion — response_body.context_block
  // (the actual [ENGRAM COGNITIVE CONTEXT] block). The raw results list is a
  // fallback for legacy traces; the user's spec: "recall only scores the
  // Engram portion, aka what is in between the context markers".
  if (dimension === "recall_relevance") {
    const q = (trace.request_body as any)?.query ?? chat.user;
    // v5.0.1: /api/cognitive-context responses carry the injected block in
    // `context` (NOT context_block — that's the /v1/chat/completions proxy
    // shape). The scorer only knew context_block, so sidecar recalls were
    // judged on "(none)" → guaranteed 0.0 recall_relevance.
    const block = (trace.response_body as any)?.context_block
      ?? (trace.response_body as any)?.context;
    const results = (trace.response_body as any)?.results;
    const retrieved = typeof block === "string" && block.trim().length
      ? block
      : Array.isArray(results) && results.length
        ? results.map((r: any) => `[score ${Number(r.score).toFixed(2)}] ${r.content ?? ""}`).join("\n")
        : "(none)";
    const r = RUBRICS[dimension];
    return {
      system: r.system,
      user: r.user({ request: trimForJudge(String(q)), response: trimForJudge(retrieved), injection }),
    };
  }
  // v4.7.11: OUT traces (label 'out') are the agent's RESPONSE scored ONLY
  // against the original question. request_body = {question}, response_body =
  // {answer}. Never grade working notes or the raw SSE envelope.
  if (dimension === "answer_quality" && (trace.label === "out" || (trace.request_body as any)?.question)) {
    const q = (trace as any).user_request || (trace.request_body as any)?.question || chat.user;
    const ans = (trace.response_body as any)?.answer;
    const r = RUBRICS[dimension];
    return {
      system: r.system,
      user: r.user({
        request: trimForJudge(String(q)),
        response: trimForJudge(typeof ans === "string" && ans.trim() ? ans : "(no answer captured)"),
        injection,
      }),
    };
  }
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
  // v5.0.1: the fidelity rubric judges extraction "vs. the conversation", so
  // the judge must see BOTH sides — assistant-elaborated facts (extraction
  // pulls from llm_response too) were flagged as hallucinations because the
  // assistant half never reached the judge prompt.
  const convoRequest =
    dimension === "extraction_fidelity" && chat.assistant.trim()
      ? trimForJudge(`${chat.user}\n\nASSISTANT: ${chat.assistant}`)
      : request;
  return { system: r.system, user: r.user({ request: convoRequest, response, injection, stored }) };
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
    const text = (await res.text().catch(() => "")).substring(0, 500);
    logger.warn({ module: "traceScorer", status: res.status, ms, url: `${baseUrl}/chat/completions`, model }, `judge HTTP ${res.status}: ${text}`);
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
    // v4.7.11: the IN trace is the user's question — NEVER scoreable, even via
    // an explicit dimension call (the GUI hides the button, the catch-up pass
    // skips it, but a direct API/calibration call must also be refused).
    if (trace.label === "in") return { ok: false, error: "in_trace_not_scorable" };

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
    // v5.0.1: this pass has been head-of-line blocked since Aug 6 — the
    // oldest-first LIMIT N window was entirely filled with receipt-era
    // ingests / conversational recalls that fail eligibleForScoring, so
    // `attempted` stayed 0 forever and every post-Aug-6 raced or judge-failed
    // trace never got retried. Over-fetch a wide window, apply eligibility
    // FIRST, and spend the attempt budget only on scoreable traces.
    const WINDOW = Math.max(Number(max) || 10, 50) * 20;
    const rows = await pg_all(
      `SELECT id, label, request_body, response_body FROM public.traces
       WHERE (scores IS NULL OR jsonb_array_length(scores) = 0)
         AND status < 400
         AND label IN ('chat', 'out', 'ingest', 'extract', 'remember', 'recall')
       ORDER BY ts ASC LIMIT ${Math.min(WINDOW, 1000)}`,
      [],
    );
    let attempted = 0;
    let scored = 0;
    let failed = 0;
    let skipped = 0;
    for (const t of rows) {
      const dim = eligibleForScoring(t);
      if (!dim) {
        skipped++;
        continue;
      }
      if (attempted >= Math.min(Math.max(Number(max) || 10, 1), 50)) break;
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
  // v4.7.11: the IN trace is the user's question — NEVER scored (NA).
  if (label === "in") return null;
  if (label === "chat" || label === "out") return "answer_quality";
  if (label === "ingest" || label === "extract" || label === "remember") return "extraction_fidelity";
  if (label === "recall") return "recall_relevance";
  return null;
}

/** Eligibility gate shared by auto-score and catch-up (v4.7.10). A trace is
 *  only scoreable when its dimension is meaningful for its SHAPE: an
 *  extraction trace with NO stored memories (receipt-era — no stored ids)
 *  cannot be graded on stored output, and a conversational recall is not a
 *  knowledge query. The auto-score path previously scored these anyway, and
 *  buildRubric fell back to grading the response ENVELOPE ("EXTRACTION
 *  SUMMARY"), producing bogus 0.0 extraction_fidelity verdicts on /memories
 *  and /ingest traces ("stored memory is merely a structural metadata
 *  object"). */
export function eligibleForScoring(t: {
  label?: string;
  request_body?: unknown;
  response_body?: unknown;
}): TraceDimension | null {
  const dim = autoScoreDimensionFor(t);
  if (!dim) return null;
  if (dim === "extraction_fidelity") {
    const ids = (t.response_body as any)?.stored_memory_ids;
    if (!(Array.isArray(ids) && ids.length > 0)) return null;
  }
  if (dim === "recall_relevance") {
    const q = (t.request_body as any)?.query;
    if (!isKnowledgeQuery(typeof q === "string" ? q : "")) return null;
  }
  if (dim === "answer_quality") {
    // v4.7.10: skip traces that aren't a genuine user↔assistant exchange.
    // The proxy also captures Hermes system/engine prompts, recall probes, and
    // "reply exactly: X" test turns as label=chat — grading answer_quality on
    // those produces uniform 0s that look like a broken pipeline. Require a
    // real user message that isn't itself a system/engine block.
    // v4.7.11: OUT traces carry the question in request_body.question and the
    // answer in response_body.answer — accept them directly.
    if (t.label === "out") {
      const q = (t.request_body as any)?.question;
      const a = (t.response_body as any)?.answer;
      if (typeof q !== "string" || !q.trim()) return null;
      if (typeof a !== "string" || !a.trim()) return null;
      return dim;
    }
    const turn = extractChatTurn(t.request_body);
    const u = turn.user.trim();
    if (
      !u ||
      u === "(no user message found)" ||
      u.startsWith("[ENGRAM COGNITIVE CONTEXT]") ||
      u.startsWith("[ENGram".toLowerCase()) ||
      /reply (with|exactly)|PROXY (HEALTHY|OK)|PORTAL KEY OK|test/i.test(u.slice(0, 60))
    ) {
      return null;
    }
  }
  return dim;
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
  // v4.7.10: apply the SAME eligibility gate as the catch-up pass. The
  // in-memory traceRec may lack bodies, so fetch the persisted trace —
  // scoring a receipt-era /memories or /ingest envelope was the bogus-0.0
  // class.
  pg_all(`SELECT request_body, response_body FROM public.traces WHERE id = $1`, [trace.id])
    .then((rows) => {
      const t = rows[0];
      // v5.0.1: persistTrace fires its INSERT without awaiting; when this
      // SELECT wins the race the trace was silently never scored (no log —
      // the interleaved scored/unscored afternoon pattern). One delayed
      // retry, then give up — the catch-up pass covers stragglers.
      if (!t) {
        return new Promise((resolve) => setTimeout(resolve, 2000))
          .then(() => pg_all(`SELECT request_body, response_body FROM public.traces WHERE id = $1`, [trace.id]))
          .then((retryRows) => {
            const rt = retryRows[0];
            if (!rt) return;
            if (!eligibleForScoring({ label: trace.label, request_body: rt.request_body, response_body: rt.response_body })) return;
            return doScore(trace, dimension as TraceDimension);
          })
          .catch(() => {});
      }
      if (!eligibleForScoring({ label: trace.label, request_body: t.request_body, response_body: t.response_body })) return;
      return doScore(trace, dimension as TraceDimension);
    })
    .catch(() => {});
}

/** v5.0.1: shared tail of the auto-score path (judge call + outcome feed +
 *  logging), extracted so the INSERT/SELECT race retry can reuse it. */
function doScore(
  trace: { id: string; label?: string },
  dimension: TraceDimension,
): Promise<void> | undefined {
  return scoreTrace(trace.id, dimension)
    .then(async (r) => {
      if (r.ok) {
        logger.info({ module: "traceScorer", id: trace.id, dimension, score: r.score }, `auto-scored trace`);
        // After scoring, feed the outcome signal (if answer_quality)
        if (dimension === "answer_quality") {
          try {
            const { ingestOutcomeFromTrace } = await import("./outcomeTracker");
            await ingestOutcomeFromTrace(trace.id);
          } catch { /* noop */ }
        }
      } else if (/no judge/i.test(r.error || "")) {
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
    // v4.7.12: apply the SAME shape-eligibility gate as auto-score and the
    // catch-up pass. scoreAllUnscored was the THIRD path missed by the v4.7.10
    // bogus-zero fix — it scored every labeled trace (health probes, system
    // notices, receipt-era extracts, empty-answer outs), producing artifact 0s.
    const persisted = await pg_all(
      `SELECT request_body, response_body FROM public.traces WHERE id = $1`,
      [row.id],
    );
    if (!persisted[0]) {
      skipped++;
      continue;
    }
    if (!eligibleForScoring({ label: row.label, request_body: persisted[0].request_body, response_body: persisted[0].response_body })) {
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
