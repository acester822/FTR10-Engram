/*
 - filename: packages/engram-js/src/services/consolidationEngine.ts
 - what is the file used for: Background cron job that groups memories by consolidation_hash first, then uses LLM to decide merge/update/promote/delete actions via structured JSON output per group (min 3 members), executes each action individually against the DB with per-action logging. Includes a synthesis fallback when the LLM forgets to provide new_content.
 */

import crypto from "node:crypto";
import { env } from "../configuration";
import { make_db as kit_make_db, run_async, all_async, transaction } from "../api/routes/_kit";
import { DEFAULT_GENOME_DECAY_RATE, DEFAULT_PHENOTYPE_DECAY_RATE } from "./memoryInjector";
import { logger } from "../utils/logger";

// ── Configuration ─────────────────────────────────────────────────────

const CONSOLIDATION_MODEL = env.generative_model;
const SYNTHESIS_MODEL   = env.fallback_model; // Fallback when the consolidation LLM omits new_content in merge/update actions
const CONSOLIDATION_BATCH_SIZE = 15; // Max groups to process per cycle
const MIN_MEMORIES_TO_CONSOLIDATE = 3; // Don't consolidate unless we have at least 3 related memories

// ── Types ─────────────────────────────────────────────────────────────

export interface MemoryCandidate {
  id: string;
  content: string;
  sector: string;
  is_genome: boolean;
  access_count: number;
  recorded_at: string;
}

export interface ConsolidationAction {
  action: "merge" | "update" | "promote" | "delete";
  target_ids: string[]; // IDs of memories this action applies to
  new_content?: string; // Required for merge/update/promote
  new_sector?: string;  // Optional: change sector if context shifts
  is_genome?: boolean;  // Optional: promote to permanent rule
  reason: string;       // Brief explanation for logging/debugging
}

// ── Consolidation Engine ──────────────────────────────────────────────

export class ConsolidationEngine {
  /**
   * Query the database for memories older than the threshold, grouped by consolidation_hash.
   * Only groups with MIN_MEMORIES_TO_CONSOLIDATE+ members are returned (cheap pre-filter).
   */
  private async fetchConsolidationGroups(): Promise<Map<string | null, MemoryCandidate[]>> {
    const db = kit_make_db(run_async, all_async);

    // Fetch memories older than 7 days that have been accessed at least once.
    // Grouped by consolidation_hash.
    const query = `
      SELECT id, content,
             COALESCE((metadata->>'sector')::text, 'semantic') as sector,
             (metadata->>'is_genome')::boolean as is_genome,
             COALESCE((metadata->>'access_count')::int, 0) as access_count,
             recorded_at,
             consolidation_hash
      FROM "public"."memories"
       WHERE memory_tier != 'archived'
         AND recorded_at < NOW() - INTERVAL '7 days'
       AND COALESCE((metadata->>'access_count')::int, 0) >= 1
      ORDER BY consolidation_hash ASC, recorded_at ASC
    `;

    try {
      const result = await db.query(query);
      const rows: any[] = result.rows || [];

      // Group by consolidation_hash (unhashed memories go into "unhashed" bucket)
      const grouped = new Map<string | null, MemoryCandidate[]>();
      for (const r of rows) {
        const key = r.consolidation_hash || "unhashed";
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push({
          id: r.id,
          content: r.content,
          sector: r.sector,
          is_genome: r.is_genome,
          access_count: r.access_count,
          recorded_at: r.recorded_at,
        });
      }

      // Filter out groups smaller than MIN_MEMORIES_TO_CONSOLIDATE (cheap pre-filter)
      for (const [hash, batch] of grouped) {
        if (batch.length < MIN_MEMORIES_TO_CONSOLIDATE) {
          grouped.delete(hash);
        }
      }

      return grouped;
    } catch (err) {
      logger.error({ module: 'consolidationEngine', model: CONSOLIDATION_MODEL, err }, 'Failed to fetch consolidation groups');
      return new Map();
    }
  }

  /**
   * Synthesizes a concise summary from related memories. Used as fallback when the LLM
   * forgets to provide new_content in its actions (which happens with Ollama's format param).
   */
  private async synthesizeContent(memories: MemoryCandidate[]): Promise<string> {
    const memoryList = memories.map((m, i) =>
      `[${i + 1}] Sector: ${m.sector} | Content: "${m.content}"`
    ).join("\n");

    const prompt = `You are a cognitive memory synthesis engine. Read the following related memories and produce ONE concise, timeless summary sentence that captures their core meaning.

Related Memories:
${memoryList}

Rules:
- Produce exactly one sentence (max 50 words)
- Discard specific dates, names, or trivial details
- Keep only the actionable fact, pattern, or preference
- Respond with ONLY the sentence — no quotes, no intro text

Synthesized Memory:`;

    try {
      const response = await fetch(`${env.ollama_url}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: SYNTHESIS_MODEL,
          prompt: `${prompt}\n\n/no_think`, // Disable thinking for generative tasks
          stream: false,
          think: false, // Native API parameter to disable thinking
          options: { temperature: 0.1, num_predict: 200 },
        }),
      });

      if (!response.ok) return "";

      const data = await response.json();
      const synthesized = (data.response || "").trim().replace(/^["']|["']$/g, "");
      return synthesized.length >= 5 ? synthesized : "";
    } catch {
      return "";
    }
  }

  /**
   * Prompts the 14B model to analyze a group of related memories and return consolidation actions.
   */
  private async generateConsolidationActions(candidates: MemoryCandidate[]): Promise<ConsolidationAction[]> {
    const memoryList = candidates.map((m, i) =>
      `[${i + 1}] ID: ${m.id} | Sector: ${m.sector} | Genome: ${m.is_genome} | Accesses: ${m.access_count}\n    Content: "${m.content}"`
    ).join("\n");

    const prompt = `### SYSTEM DIRECTIVE ###
You are an elite Memory Consolidation Engine. Your job is to analyze a batch of related stored memories and output a strict JSON array of consolidation actions to keep the knowledge base clean, dense, and accurate.

### INPUT DATA ###
${memoryList}

### CONSOLIDATION RULES ###
1. MERGE: If two or more memories state the same fact or rule, merge them into one concise memory. Set action="merge", provide target_ids, AND new_content (the merged summary).
2. UPDATE: If a memory is partially outdated but still relevant, update it. Set action="update", provide target_ids, AND new_content (the corrected version).
3. PROMOTE: If a phenotype memory has proven to be a permanent, unchangeable rule (high access count, foundational), promote it. Set action="promote", target_ids, is_genome=true. You MAY include new_content but it is optional for promotion.
4. DELETE: If a memory is obsolete, superseded, or trivial noise, delete it. Set action="delete" and target_ids.

### CRITICAL RULES ###
- MERGE and UPDATE actions MUST have non-empty new_content — this is the synthesized summary of the merged/updated memories.
- PROMOTE actions may omit new_content (the content stays the same).
- DELETE actions do not need new_content.
- If you cannot meaningfully merge or update, use DELETE instead.

### OUTPUT SCHEMA ###
Return ONLY a valid JSON array of actions. No markdown, no explanations outside the "reason" field.
[
  {
    "action": "merge",
    "target_ids": ["id1", "id2"],
    "new_content": "The merged, concise fact.",
    "new_sector": "procedural",
    "is_genome": false,
    "reason": "Merged duplicate JWT auth preferences."
  }
]
If no actions are needed, return exactly: []

### EXECUTE CONSOLIDATION NOW ###`.trim();

    try {
      logger.info({ module: 'consolidationEngine', model: CONSOLIDATION_MODEL, candidateCount: candidates.length }, `Sending ${candidates.length} related memories to ${CONSOLIDATION_MODEL} for consolidation...`);

      const response = await fetch(`${env.ollama_url}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: CONSOLIDATION_MODEL,
          prompt: `${prompt}\n\n/no_think`, // Disable thinking for generative tasks
          stream: false,
          think: false, // Native API parameter to disable thinking
          format: {
            type: "array",
            items: {
              type: "object",
              properties: {
                action: { type: "string", enum: ["merge", "update", "promote", "delete"] },
                target_ids: { type: "array", items: { type: "string" } },
                new_content: { type: "string" },
                new_sector: { type: "string" },
                is_genome: { type: "boolean" },
                reason: { type: "string" }
              },
              required: ["action", "target_ids", "reason"]
            }
          },
          options: {
            temperature: 0.1, // Highly deterministic for data operations
            num_predict: 1500
          }
        }),
      });

      if (!response.ok) {
        throw new Error(`Consolidation LLM returned status ${response.status}`);
      }

      const data = await response.json();
      const cleanJson = (data.response || "").replace(/^```json\s*|\s*```$/g, "").trim();
      let parsed: any = JSON.parse(cleanJson);

      // Normalize: if LLM returned a single object instead of an array, wrap it
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return [parsed] as ConsolidationAction[];
      }

      return parsed as ConsolidationAction[];
    } catch (error) {
      logger.error({ module: 'consolidationEngine', model: CONSOLIDATION_MODEL, err: error }, 'Consolidation LLM failed');
      return [];
    }
  }

  /**
   * Executes the consolidation actions against the database.
   */
  private async executeActions(actions: ConsolidationAction[], candidates: MemoryCandidate[]) {
    const db = kit_make_db(run_async, all_async);
    const candidateMap = new Map(candidates.map(c => [c.id, c]));

    // Wrap all actions in a single transaction so partial failures roll back
    await db.query("BEGIN");
    let hasError = false;
    try {
      for (const action of actions) {
        try {
          logger.info({ module: 'consolidationEngine', model: CONSOLIDATION_MODEL, action: action.action, reason: action.reason }, `Executing ${action.action.toUpperCase()}`);

          if (action.action === "delete") {
            const placeholders = action.target_ids.map((_, i) => `$${i + 1}`).join(",");
            await db.query(`DELETE FROM "public"."memories" WHERE id IN (${placeholders})`, action.target_ids);
          }
          else if (action.action === "merge" || action.action === "update") {
            // For merge/update, new_content is REQUIRED. If LLM forgot it, synthesize from the source memories.
            let content = action.new_content;

            if (!content) {
              const targetCandidates = action.target_ids.map(id => candidateMap.get(id)).filter(Boolean);
              logger.warn({ module: 'consolidationEngine', model: CONSOLIDATION_MODEL, action: action.action }, `${action.action} missing new_content — synthesizing from source memories`);
              content = await this.synthesizeContent(targetCandidates as MemoryCandidate[]);

              if (!content) {
                logger.error({ module: 'consolidationEngine', model: CONSOLIDATION_MODEL, action: action.action }, `Synthesis failed for ${action.action}, skipping action`);
                continue;
              }
            }

            const newSector = action.new_sector || candidateMap.get(action.target_ids[0])?.sector || "semantic";
            const isGenome = action.is_genome !== undefined ? action.is_genome : candidateMap.get(action.target_ids[0])?.is_genome || false;
            const decayRate = isGenome ? DEFAULT_GENOME_DECAY_RATE : DEFAULT_PHENOTYPE_DECAY_RATE;

            // For merge/update, we update the first target ID and delete the rest to avoid duplicates
            const primaryId = action.target_ids[0];
            const idsToDelete = action.target_ids.slice(1);

            await db.query(
              `UPDATE "public"."memories"
               SET content = $1,
                   metadata = jsonb_set(jsonb_set(jsonb_set(metadata, '{sector}', to_jsonb($2::text)), '{is_genome}', to_jsonb($3::boolean)), '{decay_rate}', to_jsonb($4::numeric))
               WHERE id = $5`,
              [content, newSector, isGenome, decayRate, primaryId]
            );

            if (idsToDelete.length > 0) {
              const placeholders = idsToDelete.map((_, i) => `$${i + 1}`).join(",");
              await db.query(`DELETE FROM "public"."memories" WHERE id IN (${placeholders})`, idsToDelete);
            }
          }
          else if (action.action === "promote") {
            // Promote each target individually — content stays the same, just set is_genome=true
            for (const targetId of action.target_ids) {
              const candidate = candidateMap.get(targetId);
              const newSector = action.new_sector || candidate?.sector || "semantic";
              const decayRate = DEFAULT_GENOME_DECAY_RATE;

              await db.query(
                `UPDATE "public"."memories"
                 SET is_genome = true,
                     metadata = jsonb_set(jsonb_set(metadata, '{is_genome}', 'true'::jsonb), '{sector}', to_jsonb($1::text)),
                     decay_rate = $2::numeric
                 WHERE id = $3`,
                [newSector, decayRate, targetId]
              );

              logger.info({ module: 'consolidationEngine', model: CONSOLIDATION_MODEL, memoryId: targetId }, `Promoted memory to genome`);
            }
          }
        } catch (err) {
          hasError = true;
          logger.error({ module: 'consolidationEngine', model: CONSOLIDATION_MODEL, action, err }, 'Failed to execute consolidation action — will roll back entire batch');
          break; // Exit the loop — outer try/catch handles rollback
        }
      }

      if (hasError) {
        await db.query("ROLLBACK");
      } else {
        await db.query("COMMIT");
      }
    } catch (err) {
      await db.query("ROLLBACK");
      logger.error({ module: 'consolidationEngine', model: CONSOLIDATION_MODEL, err }, 'Transaction failed in executeActions');
    }
  }

  /**
   * Main entry point to trigger consolidation.
   */
  public async runConsolidation(): Promise<void> {
    logger.info({ module: 'consolidationEngine', model: CONSOLIDATION_MODEL }, 'Starting memory consolidation cycle');

    const groups = await this.fetchConsolidationGroups();
    if (groups.size === 0) {
      logger.info({ module: 'consolidationEngine', model: CONSOLIDATION_MODEL }, 'No memories require consolidation at this time');
      return;
    }

    let totalActions = 0;
    let processedGroups = 0;

    for (const [hash, batch] of groups) {
      if (processedGroups >= CONSOLIDATION_BATCH_SIZE) break;

      const actions = await this.generateConsolidationActions(batch);
      if (actions.length === 0) continue;

      await this.executeActions(actions, batch);
      totalActions += actions.filter(a => a.action !== "merge" && a.action !== "update").length + 1; // count merge/update as one action each
      processedGroups++;
    }

    logger.info({ module: 'consolidationEngine', model: CONSOLIDATION_MODEL, processedGroups, totalActions }, 'Consolidation cycle complete');
  }

  /**
   * Starts the background consolidation cron job. Call this once when your server boots.
   */
  public start(): void {
    const intervalMs = 30 * 60 * 1000; // every 30 minutes

    // Run once immediately on startup, then periodically
    this.runConsolidation().catch((err) => {
      logger.error({ module: 'consolidationEngine', model: CONSOLIDATION_MODEL, err }, 'Initial consolidation cycle failed');
    });

    const timer = setInterval(() => {
      this.runConsolidation().catch((err) => {
        logger.error({ module: 'consolidationEngine', model: CONSOLIDATION_MODEL, err }, 'Scheduled consolidation cycle failed');
      });
    }, intervalMs);

    timer.unref?.(); // Don't prevent process exit

    logger.info({ module: 'consolidationEngine', model: CONSOLIDATION_MODEL, intervalMs: 1800000 }, 'Consolidation engine scheduled');
  }
}

// ── Singleton ───────────────────────────────────────────────────────────

export const consolidationEngine = new ConsolidationEngine();
