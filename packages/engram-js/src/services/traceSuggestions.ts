/*
 - filename: packages/engram-js/src/services/traceSuggestions.ts
 - what is the file used for: rule-based remediation suggestions derived from a
   trace report. DETERMINISTIC — grounded in the report numbers plus live store
   health queries (NULL/synthetic embeddings), with pointers to the actual fixes
   known to matter in this deployment. No LLM call (the judge already scores;
   suggestions must be explainable and stable).
*/

import { all_async as pg_all } from "../database/connection";
import type { TraceReport } from "./traceStore";

export interface Suggestion {
  severity: "high" | "medium" | "info";
  dimension: string | null;
  title: string;
  detail: string;
}

/** Live store-health evidence: NULL embeddings are the #1 recall killer here. */
async function embeddingHealth(): Promise<{ nulls: number; synths: number }> {
  try {
    const rows = await pg_all(
      `SELECT
         count(*) FILTER (WHERE embedding IS NULL AND superseded_at IS NULL)::int AS nulls,
         count(*) FILTER (WHERE embedding_synthetic = true AND superseded_at IS NULL)::int AS synths
       FROM public.memories`,
      [],
    );
    return { nulls: rows[0]?.nulls || 0, synths: rows[0]?.synths || 0 };
  } catch {
    return { nulls: 0, synths: 0 };
  }
}

function sectorMix(r: TraceReport): string {
  const s = r.breakdown_totals?.sectors || {};
  const entries = Object.entries(s);
  if (!entries.length) return "no sector data in window";
  return entries.map(([k, v]) => `${k}:${v}`).join(", ");
}

export async function generateSuggestions(r: TraceReport): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  const dimAvg = (d: string) => r.score_stats?.[d]?.avg;
  const dimCount = (d: string) => r.score_stats?.[d]?.count || 0;
  const dims = Object.keys(r.score_stats || {});

  if (!dims.length) {
    out.push({
      severity: "info",
      dimension: null,
      title: "No scores in this window",
      detail:
        "Nothing was scored. Configure the Judge model in Settings (Judge section) and click 'Score unscored' in the Traces tab to backfill; new traces auto-score on capture.",
    });
  }

  // ── recall_relevance ──
  const rr = dimAvg("recall_relevance");
  if (dims.includes("recall_relevance")) {
    if (rr !== undefined && rr < 0.5) {
      out.push({
        severity: "high",
        dimension: "recall_relevance",
        title: `Recall relevance is weak (avg ${rr} over ${dimCount("recall_relevance")} scores)`,
        detail:
          "Run `bun run tsx scripts/recall-eval.ts` in packages/engram-js to get the recall@1/@3/@5 baseline, then investigate below.",
      });
      const health = await embeddingHealth();
      if (health.nulls > 0) {
        out.push({
          severity: "high",
          dimension: "recall_relevance",
          title: `${health.nulls} active memories have NULL embeddings`,
          detail:
            "NULL-embedded rows are invisible to similarity recall. Backfill with `scripts/backfill_embeddings.py` (batched UPDATEs, pace embeds, llama-swap concurrencyLimit 32).",
        });
      }
      if (health.synths > 0) {
        out.push({
          severity: "medium",
          dimension: "recall_relevance",
          title: `${health.synths} active memories use synthetic (hash) embeddings`,
          detail:
            "Synthetic vectors rank poorly. Check the embedding provider (EG_OPENAI_BASE_URL / Settings → Embedding) — a failed embed at write time falls back to the hash.",
        });
      }
      out.push({
        severity: "medium",
        dimension: "recall_relevance",
        title: "Store may contain recall-diluting noise",
        detail:
          `Trigger POST /api/dashboard/consolidate (tier=recent + deep) to fold near-duplicates, then audit the active store for junk (see memory-cleanup rules: IDE-save dumps, session state, self-referential meta). Sector mix in window: ${sectorMix(r)}.`,
      });
    } else if (rr !== undefined && rr >= 0.7) {
      out.push({
        severity: "info",
        dimension: "recall_relevance",
        title: `Recall relevance is healthy (avg ${rr})`,
        detail: "No action needed — the store is retrieving relevant memories.",
      });
    }
  }

  // ── extraction_fidelity ──
  const ef = dimAvg("extraction_fidelity");
  if (dims.includes("extraction_fidelity") && ef !== undefined && ef < 0.5) {
    out.push({
      severity: "high",
      dimension: "extraction_fidelity",
      title: `Extraction quality is low (avg ${ef})`,
      detail:
        "The extraction model matters more than anything else here: the default LFM2.5-1.2B-Instruct is KNOWN to be too weak for extraction (mis-sectors, drops durable facts). Switch to Gemma-4-12B-no-thinking in Settings → Generative → Extraction Model, then re-test.",
    });
    out.push({
      severity: "medium",
      dimension: "extraction_fidelity",
      title: "Review what extraction is actually storing",
      detail:
        `Sector mix in window: ${sectorMix(r)}. If one sector dominates (e.g. semantic), or stored_count is high relative to conversation content, the extraction prompt/gates may need tightening (isWorthRemembering / DO NOT EXTRACT list in memoryLogger.ts).`,
    });
  }

  // ── answer_quality ──
  const aq = dimAvg("answer_quality");
  if (dims.includes("answer_quality") && aq !== undefined && aq < 0.5) {
    if (r.errors > 0) {
      out.push({
        severity: "high",
        dimension: "answer_quality",
        title: `${r.errors} failed request(s) in the window`,
        detail:
          "Failed requests score 0 and drag the average down. Check the upstream LLM (llama-swap /v1/models — a 404 usually means the requested model isn't routed). These are skipped by auto-score now, but historical 0s remain.",
      });
    }
    out.push({
      severity: "medium",
      dimension: "answer_quality",
      title: "Check memory injection during chat",
      detail:
        `Window injected ${r.breakdown_totals.genome} genome + ${r.breakdown_totals.phenotype} phenotype total. If injection is near zero, answers are produced without memory context — verify the Hermes plugin prefetch path (/api/cognitive-context traces) and the embed fix on the chat proxy.`,
    });
  }

  // ── generic ──
  if (r.total > 0 && r.total < 10) {
    out.push({
      severity: "info",
      dimension: null,
      title: "Small sample",
      detail: `Only ${r.total} trace(s) in this window — score averages are noisy until there is more traffic.`,
    });
  }

  return out;
}
