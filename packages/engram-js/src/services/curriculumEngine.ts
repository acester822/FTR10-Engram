/*
 - filename: packages/engram-js/src/services/curriculumEngine.ts
 - what is the file used for: self-directed curriculum engine — the system
   generates its own probe queries in weak sectors, runs them through the
   proxy, and identifies gaps before the user hits them.
*/

import crypto from "node:crypto";
import { all_async as pg_all, run_async as pg_run } from "../database/connection";
import { policyThresholds } from "./traceStore";
import { logger } from "../utils/logger";

/** Write a finding directly to the integrity_findings ledger. */
async function writeCurriculumFinding(
  checkName: string,
  opts: { memoryId?: string | null; severity?: string; detail?: unknown },
): Promise<void> {
  await pg_run(
    `INSERT INTO public.integrity_findings
       (id, run_id, check_name, memory_id, severity, action_taken, detail, status)
     VALUES ($1, $2, $3, $4, $5, 'none', $6::jsonb, 'open')`,
    [
      crypto.randomUUID(),
      "curriculum",
      checkName,
      opts.memoryId || null,
      opts.severity || "medium",
      JSON.stringify(opts.detail || {}),
    ],
  ).catch((err: any) => {
    logger.warn({ module: "curriculumEngine", err: err?.message }, "finding write failed");
  });
}

// ── Config ───────────────────────────────────────────────────────────

function enabled(): boolean {
  return (process.env.EG_CURRICULUM_ENABLED ?? "false").toLowerCase() === "true";
}
function intervalMs(): number {
  const n = Number(process.env.EG_CURRICULUM_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? n : 168 * 60 * 60 * 1000; // weekly
}
function maxProbes(): number {
  const n = Number(process.env.EG_CURRICULUM_MAX_PROBES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
}
function minSectorSize(): number {
  const n = Number(process.env.EG_CURRICULUM_MIN_SECTOR_SIZE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

// ── Weak sector detection ────────────────────────────────────────────

interface WeakSector {
  sector: string;
  avg_quality: number;
  recall_count: number;
  memory_count: number;
}

async function detectWeakSectors(): Promise<WeakSector[]> {
  const rows = await pg_all(
    `SELECT m.sector,
            count(DISTINCT m.id) AS memory_count,
            avg(s.avg_answer_quality) AS avg_quality,
            sum(s.recall_count)::int AS recall_count
     FROM public.memories m
     JOIN public.memories_outcome_stats s ON s.memory_id = m.id
     WHERE m.memory_tier != 'archived'
       AND m.superseded_at IS null
       AND s.avg_answer_quality IS NOT NULL
       AND s.recall_count >= 3
     GROUP BY m.sector
     HAVING count(DISTINCT m.id) >= $1`,
    [minSectorSize()],
  ).catch(() => []);

  const { bad } = policyThresholds();
  return (rows || [])
    .map((r: any) => ({
      sector: r.sector,
      avg_quality: Number(r.avg_quality) || 0,
      recall_count: Number(r.recall_count) || 0,
      memory_count: Number(r.memory_count) || 0,
    }))
    .filter((s: WeakSector) => s.avg_quality < bad);
}

// ── Probe generation ─────────────────────────────────────────────────

interface Probe {
  query: string;
  sector: string;
  source_memory_ids: string[];
}

/**
 * Generate a natural question that a memory *should* answer.
 * The query must be different from the memory's own text.
 */
function probeFromMemory(memory: any): string | null {
  const content = memory.content || "";
  if (content.length < 20) return null;

  // Simple heuristic: take the first sentence, turn it into a question
  const firstSentence = content.split(/[.!?]/)[0].trim();
  if (firstSentence.length < 15) return null;

  // If it's already a question, return as-is
  if (firstSentence.includes("?")) return firstSentence;

  // Otherwise, form a "what is X?" or "how to X?" style query
  const lower = firstSentence.toLowerCase();
  if (lower.startsWith("the ") || lower.startsWith("a ") || lower.startsWith("an ")) {
    return `What is ${firstSentence.replace(/^(the |a |an )/i, "")}?`;
  }
  if (lower.includes(" is ") || lower.includes(" are ")) {
    const parts = firstSentence.split(/\s+is\s+|\s+are\s+/i);
    if (parts.length >= 2) return `What is ${parts[0].trim()}?`;
  }
  return `Tell me about ${firstSentence.slice(0, 80)}.`;
}

async function generateProbes(sector: WeakSector, limit: number): Promise<Probe[]> {
  // Get the worst-performing memories in this sector
  const memories = await pg_all(
    `SELECT m.id, m.content, s.avg_answer_quality, s.recall_count
     FROM public.memories m
     JOIN public.memories_outcome_stats s ON s.memory_id = m.id
     WHERE m.sector = $1
       AND m.memory_tier != 'archived'
       AND m.superseded_at IS null
       AND s.avg_answer_quality IS NOT NULL
       AND s.recall_count >= 3
     ORDER BY s.avg_answer_quality ASC, s.recall_count DESC
     LIMIT $2`,
    [sector.sector, limit],
  ).catch(() => []);

  const probes: Probe[] = [];
  for (const mem of memories || []) {
    const q = probeFromMemory(mem);
    if (q && q !== mem.content) {
      probes.push({
        query: q,
        sector: sector.sector,
        source_memory_ids: [mem.id],
      });
    }
  }
  return probes;
}

// ── Gap checking ─────────────────────────────────────────────────────

const GAP_SIM_THRESHOLD = 0.70; // below this, the store can't answer

async function checkGap(probe: Probe): Promise<{ gap: boolean; topSim: number }> {
  const { embed, normalizeEmbedding } = await import("../embeddings/embed");
  const vec = normalizeEmbedding(await embed(probe.query));
  const rows = await pg_all(
    `SELECT id, content, round((1 - (embedding <=> $1::halfvec))::numeric, 3) AS sim
     FROM public.memories
     WHERE superseded_at IS null AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::halfvec LIMIT 1`,
    [JSON.stringify(vec)],
  ).catch(() => []);

  const topSim = rows?.[0]?.sim ? Number(rows[0].sim) : 0;
  return { gap: topSim < GAP_SIM_THRESHOLD, topSim };
}

// ── Main run ─────────────────────────────────────────────────────────

export interface CurriculumResult {
  ran_at: string;
  weak_sectors: number;
  probes_generated: number;
  gaps_found: number;
  proposals: number;
}

export async function runCurriculum(): Promise<CurriculumResult> {
  const result: CurriculumResult = {
    ran_at: new Date().toISOString(),
    weak_sectors: 0,
    probes_generated: 0,
    gaps_found: 0,
    proposals: 0,
  };

  if (!enabled()) return result;

  const weakSectors = await detectWeakSectors();
  result.weak_sectors = weakSectors.length;

  if (weakSectors.length === 0) {
    logger.info({ module: "curriculumEngine" }, "no weak sectors detected");
    return result;
  }

  let probeBudget = maxProbes();
  for (const sector of weakSectors) {
    if (probeBudget <= 0) break;
    const probes = await generateProbes(sector, Math.min(probeBudget, 5));
    probeBudget -= probes.length;
    result.probes_generated += probes.length;

    for (const probe of probes) {
      try {
        const { gap, topSim } = await checkGap(probe);
        if (gap) {
          result.gaps_found++;
          // Write a finding (reuse integrity_findings with a special check_name)
          // so it appears in the existing integrity findings ledger.
          await writeCurriculumFinding(
            "curriculum_gap",
            {
              memoryId: probe.source_memory_ids[0] || null,
              severity: "medium",
              detail: {
                query: probe.query,
                sector: probe.sector,
                top_sim: topSim,
                source_memory_ids: probe.source_memory_ids,
              },
            },
          ).catch(() => {});
          result.proposals++;
        }
      } catch (err: any) {
        logger.warn({ module: "curriculumEngine", err: err?.message }, "probe failed");
      }
    }
  }

  logger.info(
    { module: "curriculumEngine", weak_sectors: result.weak_sectors, probes: result.probes_generated, gaps: result.gaps_found },
    "curriculum run complete",
  );
  return result;
}

// ── Scheduler ────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
export const curriculumEngine = {
  start(): void {
    if (timer) return;
    const tick = async () => {
      if (!enabled()) return;
      try {
        await runCurriculum();
      } catch (e: any) {
        logger.error({ module: "curriculumEngine", err: e?.message }, "scheduled curriculum run failed");
      }
    };
    setTimeout(tick, 180 * 1000); // 3min after boot
    timer = setInterval(tick, intervalMs());
  },
};
