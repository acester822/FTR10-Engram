/*
 - filename: packages/engram-js/src/services/recallGapEngine.ts
 - what is the file used for: the recall-gap -> enrichment feedback loop
   (user-designed, Aug 2026). When a /recall trace scores BELOW the policy
   bad threshold, that is a STORE-GAP signal: the recalled memories did not
   answer the query. This engine re-checks the query against the live store —
   if the answer has since been captured (extraction), the gap is closed and
   nothing happens. For TRUE gaps it proposes enrichment of the underperforming
   memory using the ANSWER from the same conversation (nearest /ingest trace
   after the recall) as a verbatim, same-project-by-construction source.
   ALWAYS flag-first: recall_gap findings are proposals (verdict "enrich");
   the user Applies through the normal ledger workflow.
*/

import { all_async as pg_all, run_async as pg_run } from "../database/connection";
import { embed, normalizeEmbedding } from "../embeddings/embed";
import { callJudge, parseJudge } from "./traceScorer";
import { policyThresholds } from "./traceStore";
import { parseEnrichmentJson } from "./enrichmentEngine";
import { enrichMemory } from "../durable/mutations";
import { logger } from "../utils/logger";

export function recallGapEnabled(): boolean {
  return (process.env.EG_RECALL_GAP_ENABLED ?? "true").toLowerCase() !== "false";
}

/** High-confidence auto-apply for composed recall-gap enrichments — sources
 *  are the user's own conversations (same-project by construction). Audited
 *  via enrichMemory (actor recall-gap-auto), always undoable. */
export function recallGapAutoApply(): boolean {
  return (process.env.EG_RECALL_GAP_AUTO_APPLY ?? "false").toLowerCase() === "true";
}
function windowDays(): number {
  const n = Number(process.env.EG_RECALL_GAP_WINDOW_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 7;
}
function maxPerRun(): number {
  const n = Number(process.env.EG_RECALL_GAP_MAX_PER_RUN);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
}

const ANSWERED_SIM = 0.75; // re-recall top sim >= this => the store now answers the query
const ANSWER_WINDOW_MIN = 20; // look for the answering conversation within N minutes after the recall

// Knowledge-question filter: conversational messages ("yes please", "proceed",
// "Here is another fail...") score low on recall_relevance but are NOT
// knowledge gaps. Bare "is/are/do" match almost any sentence, so we require
// question STRUCTURE: a trailing "?", a leading wh-word, or a question opener.
const QUESTION_RE =
  /^(\bwhat\b|\bwhats\b|\bhow\b|\bwhy\b|\bwhen\b|\bwhere\b|\bwhich\b|\bwho\b|\bdoes\b|\bdo\b|\bcan\b|\bcould\b|\bwould\b|\bshould\b|\bexplain\b|\bdefine\b|\bdescribe\b)/i;
const QUESTION_OPENER_RE =
  /\b(what is|what are|whats|what's|how does|how do|how to|how can|why is|why does|when did|where is|which is|is there|are there|is it|does it|can you|could you|would you|tell me about|difference between)\b/i;

function isKnowledgeQuery(q: string): boolean {
  const t = q.trim();
  if (t.length < 8) return false;
  if (t.includes("?")) return true;
  return QUESTION_RE.test(t) || QUESTION_OPENER_RE.test(t);
}

export async function runRecallGap(): Promise<{ checked: number; answered_now: number; gaps: number; proposed: number; skipped_non_query: number; skipped_dup_memory: number; failed: number; skipped_running?: boolean }> {
  if (running) return { checked: 0, answered_now: 0, gaps: 0, proposed: 0, skipped_non_query: 0, skipped_dup_memory: 0, failed: 0, skipped_running: true };
  running = true;
  try {
    return await doRun();
  } finally {
    running = false;
  }
}

let running = false;

async function doRun(): Promise<{ checked: number; answered_now: number; gaps: number; proposed: number; skipped_non_query: number; skipped_dup_memory: number; failed: number }> {
  const stats = { checked: 0, answered_now: 0, gaps: 0, proposed: 0, skipped_non_query: 0, skipped_dup_memory: 0, failed: 0 };
  if (!recallGapEnabled()) return stats;
  const bad = policyThresholds().bad;

  const traces = await pg_all(
    `SELECT t.id, t.ts, t.request_body, t.response_body
     FROM public.traces t
     WHERE t.route IN ('/recall', '/api/recall', '/api/dashboard/recall')
       AND t.ts > now() - ($1::int * interval '1 day')
       AND t.scores IS NOT NULL
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.scores) s
         WHERE (s->>'coverage')::int = 0
            OR ((s->>'coverage') IS NULL AND (s->>'score')::float < $2))
       AND NOT EXISTS (
         SELECT 1 FROM public.integrity_findings f
         WHERE f.check_name = 'recall_gap' AND f.detail->>'trace_id' = t.id::text
       )
     ORDER BY t.ts DESC LIMIT $3`,
    [windowDays(), bad, maxPerRun()],
  ).catch(() => []);

  for (const t of traces) {
    stats.checked++;
    const query = typeof t.request_body?.query === "string" ? t.request_body.query : "";
    if (!query || query.length < 3) continue;
    if (!isKnowledgeQuery(query)) {
      stats.skipped_non_query++;
      continue; // conversational messages are not knowledge gaps
    }

    try {
      // 1. Re-recall NOW — is the answer in the store yet?
      const vec = normalizeEmbedding(await embed(query));
      const top = await pg_all(
        `SELECT id, content, round((1 - (embedding <=> $1::halfvec))::numeric, 3) AS sim
         FROM public.memories WHERE superseded_at IS NULL AND embedding IS NOT NULL
         ORDER BY embedding <=> $1::halfvec LIMIT 1`,
        [JSON.stringify(vec)],
      ).catch(() => []);
      if (top[0] && Number(top[0].sim) >= ANSWERED_SIM) {
        stats.answered_now++;
        continue; // extraction closed the gap — nothing to do
      }
      stats.gaps++;

      // 2. Find the answer conversation: nearest /ingest trace after the recall.
      const answerRows = await pg_all(
        `SELECT id, request_body FROM public.traces
         WHERE route = '/ingest/conversation' AND ts > $1 AND ts <= $1 + ($2::int * interval '1 minute')
         ORDER BY ts ASC LIMIT 1`,
        [t.ts, ANSWER_WINDOW_MIN],
      ).catch(() => []);
      const llmResponse =
        typeof answerRows[0]?.request_body?.llm_response === "string"
          ? answerRows[0].request_body.llm_response
          : "";
      const answerTraceId = answerRows[0]?.id ?? null;

      // 3. The memory to enrich: the top result of the ORIGINAL recall (the
      //    results live in the trace's RESPONSE body), if still active; else
      //    the current top.
      let target: { id: string; content: string } | null = null;
      const orig = await pg_all(
        `SELECT id, content FROM public.memories WHERE id = ANY($1) AND superseded_at IS NULL LIMIT 1`,
        [[(t.response_body as any)?.results?.[0]?.id].filter(Boolean)],
      ).catch(() => []);
      if (orig[0]) target = { id: orig[0].id, content: orig[0].content };
      else if (top[0]) target = { id: top[0].id, content: top[0].content };
      if (!target) {
        // No memory to enrich — record the gap as informational.
        await writeGapFinding(t.id, query, null, null, null, llmResponse ? answerTraceId : null, llmResponse, false);
        continue;
      }

      // MEMORY-LEVEL DEDUPE: two recall traces can propose the same memory
      // (each guards its own trace_id) — one proposal per memory, ever.
      // A dismissed proposal means the user decided; don't re-propose.
      const dup = await pg_all(
        `SELECT id FROM public.integrity_findings
         WHERE check_name = 'recall_gap' AND memory_id = $1 LIMIT 1`,
        [target.id],
      ).catch(() => []);
      if (dup.length) {
        stats.skipped_dup_memory++;
        continue;
      }

      // 4. Compose enrichment from the conversation answer (same-project source).
      if (!llmResponse || llmResponse.length < 50) {
        // No answer captured yet — gap notice only.
        await writeGapFinding(t.id, query, target.id, target.content, null, null, null, false);
        continue;
      }
      let enriched = "";
      try {
        const c = await callJudge(
          `You are a memory enrichment composer. Given an ORIGINAL memory and the ANSWER from the user's own conversation, produce an enriched version. Rules: (1) keep the original text VERBATIM as the base; (2) append ONLY the facts from the answer that directly relate to the memory's topic; (3) tag each addition [src:1]; (4) never invent facts not in the answer. Return ONLY JSON: {"enriched": "<full enriched text>"}.`,
          `ORIGINAL:\n${target.content}\n\nANSWER FROM CONVERSATION:\n${llmResponse.slice(0, 3000)}`,
        );
        const parsed = c.ok ? parseEnrichmentJson(c.content || "") : null;
        enriched = parsed?.enriched && typeof parsed.enriched === "string" ? parsed.enriched.trim() : "";
      } catch {
        /* compose failed */
      }
      if (!enriched || enriched === target.content) {
        await writeGapFinding(t.id, query, target.id, target.content, null, answerTraceId, llmResponse, false);
        continue;
      }
      // No-op guard (same rule as enrichment): substantive addition required.
      {
        let addition = enriched.trim();
        const origNorm = target.content.trim();
        if (addition.startsWith(origNorm)) addition = addition.slice(origNorm.length);
        else if (addition.includes(origNorm)) addition = addition.replace(origNorm, "");
        const tagOnly = addition.replace(/\[\s*src:\s*\d+\s*\]/gi, "").trim();
        if (tagOnly.length < 40) {
          await writeGapFinding(t.id, query, target.id, target.content, null, answerTraceId, llmResponse, false);
          continue;
        }
      }
      // Validate (grounding passes trivially — the source is the user's own
      // conversation; validate still guards hallucination/drift).
      let valid = true;
      try {
        const v = await callJudge(
          `You are a strict enrichment validator. Given ORIGINAL, ENRICHED, and the ANSWER SOURCE, judge whether ENRICHED preserves the original and adds ONLY facts directly supported by the answer. REJECT (score 0) on hallucination, off-topic drift, or unsupported additions. Respond ONLY with JSON: {"score": <0.0-1.0>, "reason": "<one sentence>"}.`,
          `ORIGINAL:\n${target.content}\n\nENRICHED:\n${enriched}\n\nANSWER SOURCE:\n${llmResponse.slice(0, 3000)}`,
        );
        const parsed = v.ok ? parseJudge(v.content || "") : null;
        if (!parsed || parsed.score < 0.6) valid = false;
      } catch {
        valid = false;
      }
      if (!valid) {
        stats.failed++;
        continue;
      }

      await writeGapFinding(
        t.id,
        query,
        target.id,
        target.content,
        enriched,
        answerTraceId,
        llmResponse,
        true,
        recallGapAutoApply(),
      );
      stats.proposed++;
    } catch (e: any) {
      stats.failed++;
      logger.warn({ module: "recallGapEngine", err: e?.message, trace: t.id }, "recall-gap pass failed for trace");
    }
  }
  logger.info({ module: "recallGapEngine", ...stats }, "recall-gap pass complete");
  return stats;
}

async function writeGapFinding(
  traceId: string,
  query: string,
  memoryId: string | null,
  oldContent: string | null,
  newContent: string | null,
  answerTraceId: string | null,
  llmResponse: string | null,
  proposed: boolean,
  autoApply = false,
): Promise<void> {
  const detail: any = {
    trace_id: traceId,
    query,
    answer_found: Boolean(llmResponse && llmResponse.length >= 50),
  };
  if (answerTraceId) detail.answer_trace_id = answerTraceId;
  if (memoryId) detail.memory_id = memoryId;
  if (oldContent) detail.old_content = oldContent;
  if (newContent) {
    detail.new_content = newContent;
    detail.verdict = "enrich";
  }
  if (llmResponse) detail.sources = [{ type: "trace", trace_id: answerTraceId, content: llmResponse.slice(0, 500) }];
  const ins = await pg_all(
    `INSERT INTO public.integrity_findings (run_id, check_name, memory_id, severity, action_taken, detail, status)
     VALUES ((SELECT id FROM public.integrity_runs ORDER BY started_at DESC LIMIT 1),
             'recall_gap', $1, 'medium', 'flag', $2::jsonb, 'open') RETURNING id`,
    [memoryId, JSON.stringify(detail)],
  ).catch((e: any) => {
    logger.warn({ module: "recallGapEngine", err: e?.message }, "recall_gap finding write failed");
    return [];
  });
  // HIGH-CONFIDENCE AUTO-APPLY (v4.7.6, user-approved): recall-gap sources are
  // the user's OWN conversations — same-project by construction, zero
  // contamination risk — so when EG_RECALL_GAP_AUTO_APPLY is on, a composed
  // enrichment is applied immediately through the audited path instead of
  // waiting for a human Apply. Always audited + undoable (via: auto-apply).
  if (autoApply && memoryId && newContent && ins.length) {
    const r: any = await enrichMemory(memoryId, newContent, detail.sources ?? [], "recall-gap-auto").catch((e: any) => ({
      ok: false,
      error: e?.message || String(e),
    }));
    if (r.ok && r.new_id) {
      await pg_run(
        `UPDATE public.integrity_findings
         SET status = 'resolved', action_taken = 'enrich', resolved_at = now(),
             detail = jsonb_set(jsonb_set(detail, '{resolution}', '"auto-applied by user setting (EG_RECALL_GAP_AUTO_APPLY)"'::jsonb), '{successor_id}', to_jsonb($2::text))
         WHERE id = $1`,
        [ins[0].id, r.new_id],
      ).catch(() => {});
    } else {
      logger.warn({ module: "recallGapEngine", err: r.error }, "recall_gap auto-apply failed — finding left open for review");
    }
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
export const recallGapEngine = {
  start(): void {
    if (timer) return;
    const tick = async () => {
      try {
        await runRecallGap();
      } catch (e: any) {
        logger.error({ module: "recallGapEngine", err: e?.message }, "scheduled recall-gap pass failed");
      }
    };
    setTimeout(tick, 60000);
    timer = setInterval(tick, Number(process.env.EG_RECALL_GAP_INTERVAL_MS) || 6 * 60 * 60 * 1000);
  },
};
