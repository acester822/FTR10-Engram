/*
 - filename: packages/engram-js/src/services/candidateProcessor.ts
 - what is the file used for: drains the extraction-candidates black hole.
   The Hermes plugin falls back to POST /ingest (raw event -> pending
   candidate) whenever /ingest/conversation fails (client timeout vs slow
   extraction, restart windows). Nothing ever processed those candidates —
   real conversations sat un-extracted forever. This service runs the REAL
   extraction pipeline (logInteractionAsync) over pending candidates and
   marks them processed. Scheduler tick + manual drain endpoint.
*/

import { all_async as pg_all, run_async as pg_run } from "../database/connection";
import { logInteractionAsync } from "./memoryLogger";
import { logger } from "../utils/logger";

let running = false;

export async function processPendingCandidates(limit = 5): Promise<{ processed: number; stored: number; raw: number; failed: number; skipped_running: boolean }> {
  if (running) return { processed: 0, stored: 0, raw: 0, failed: 0, skipped_running: true };
  running = true;
  const stats = { processed: 0, stored: 0, raw: 0, failed: 0, skipped_running: false };
  try {
    const rows = await pg_all(
      `SELECT id, content, project_id FROM public.extraction_candidates
       WHERE status = 'pending' ORDER BY created_at ASC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 20)],
    );
    for (const r of rows) {
      try {
        const content = r.content || "";
        // The plugin writes "USER: <p>\n\nASSISTANT: <r>" — split it back.
        const sep = content.indexOf("\n\nASSISTANT: ");
        const userPrompt = sep >= 0 ? content.slice(6, sep).trim() : content.slice(0, 2500);
        const llmResponse = sep >= 0 ? content.slice(sep + 13).trim() : "";
        if (!llmResponse || llmResponse.length < 50) {
          // Not a conversation turn — nothing to extract; park as raw.
          await pg_run(`UPDATE public.extraction_candidates SET status = 'processed_raw', rejection_reason = 'no assistant response to extract' WHERE id = $1`, [r.id]);
          stats.raw++;
          continue;
        }
        const res = await logInteractionAsync(userPrompt, llmResponse, undefined, r.project_id ?? undefined, false);
        stats.stored += res.storedCount;
        await pg_run(`UPDATE public.extraction_candidates SET status = 'processed' WHERE id = $1`, [r.id]);
        stats.processed++;
      } catch (e: any) {
        stats.failed++;
        logger.warn({ module: "candidateProcessor", err: e?.message, id: r.id }, "candidate processing failed");
      }
    }
    if (rows.length) {
      logger.info({ module: "candidateProcessor", ...stats }, "candidate drain complete");
    }
    return stats;
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;
export const candidateProcessor = {
  start(): void {
    if (timer) return;
    const tick = async () => {
      try {
        await processPendingCandidates(5);
      } catch (e: any) {
        logger.error({ module: "candidateProcessor", err: e?.message }, "scheduled candidate drain failed");
      }
    };
    setTimeout(tick, 45000);
    timer = setInterval(tick, 15 * 60 * 1000);
  },
};
