/*
 - filename: packages/engram-js/src/services/consolidationEngine.ts
 - what is the file used for: Background cron job that groups memories by consolidation_hash first, then uses LLM to decide merge/update/promote/delete actions via structured JSON output per group (min 3 members), executes each action individually against the DB with per-action logging. Includes a synthesis fallback when the LLM forgets to provide new_content.
 */

import crypto from "node:crypto";
import { env } from "../configuration";
import { make_db as kit_make_db, run_async, all_async, transaction } from "../api/routes/_kit";
import { DEFAULT_GENOME_DECAY_RATE, DEFAULT_PHENOTYPE_DECAY_RATE, normalizeSector } from "./memoryInjector";
import { logger } from "../utils/logger";
import { resolveGenerativeModel } from "../database/modelRegistry";

// ── Configuration ─────────────────────────────────────────────────────

// Canonical consolidation model — Settings tab → env override → fail. Evaluated at
// call time so GUI changes apply without a restart.
const consolidationModel = (): string => {
  try { return resolveGenerativeModel("consolidation"); } catch { return ""; }
};

// Two-tier scheduling (all overridable via env):
//  - RECENT tier: scans the last N days frequently so standing rules / near-dupes
//    get promoted or merged promptly instead of waiting 7 days.
//  - DEEP tier: the original long-window cleanup/merge/decay pass.
const RECENT_INTERVAL_MS = parseInt(String(process.env.EG_CONSOLIDATION_RECENT_INTERVAL_MS), 10) || 4 * 60 * 60 * 1000; // every 4h
const DEEP_INTERVAL_MS  = parseInt(String(process.env.EG_CONSOLIDATION_DEEP_INTERVAL_MS), 10) || 24 * 60 * 60 * 1000;   // every 24h
const RECENT_MAX_AGE_DAYS = parseInt(String(process.env.EG_CONSOLIDATION_RECENT_MAX_AGE_DAYS), 10) || 7;                 // recent window
const DEEP_MAX_AGE_DAYS   = parseInt(String(process.env.EG_CONSOLIDATION_DEEP_MAX_AGE_DAYS), 10) || 30;                   // deep window (older than RECENT)
const RECENT_MIN_GROUP = parseInt(String(process.env.EG_CONSOLIDATION_RECENT_MIN_GROUP), 10) || 2;  // promote/merge recent pairs
const DEEP_MIN_GROUP   = parseInt(String(process.env.EG_CONSOLIDATION_DEEP_MIN_GROUP), 10) || 3;   // require clusters for deep

const CONSOLIDATION_BATCH_SIZE = 15; // Max groups to process per cycle
const MIN_MEMORIES_TO_CONSOLIDATE = 3; // Legacy default; tiers pass their own min-group instead.

// Max memories sent per LLM call. Groups larger than this are chunked so each
// prompt stays within the model's context window. The "unhashed" bucket is
// effectively the WHOLE store (consolidation_hash is never populated anywhere),
// so without chunking a single call can carry thousands of memories.
const MAX_MEMORIES_PER_CALL = parseInt(String(process.env.EG_CONSOLIDATION_BATCH_MEMORIES), 10) || 150;

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

// ── JSON response parsing helpers ─────────────────────────────────────
// The consolidation LLM is small/weak; even with `response_format: json_object`
// (llama.cpp forces an OBJECT, never a bare array) it can wrap the array in an
// arbitrary key, or emit prose around the JSON. These helpers make parsing
// tolerant: strip fences anywhere, extract the outermost [...] / {...}, and
// unwrap object-wrapped arrays.

function extractOuterJson(s: string, open: string, close: string): string | null {
  const i = s.indexOf(open);
  if (i === -1) return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === open) depth++;
    else if (s[j] === close) {
      depth--;
      if (depth === 0) return s.slice(i, j + 1);
    }
  }
  return null;
}

function parseConsolidationJson(raw: string): ConsolidationAction[] | null {
  const cleaned = raw.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1").trim();
  if (!cleaned) return null;

  let parsed: any = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const pairs: Array<[string, string]> = [["[", "]"], ["{", "}"]];
    for (const [open, close] of pairs) {
      const sub = extractOuterJson(cleaned, open, close);
      if (sub !== null) {
        try { parsed = JSON.parse(sub); break; } catch { /* keep trying */ }
      }
    }
  }
  if (parsed === null) return null;

  if (Array.isArray(parsed)) return parsed as ConsolidationAction[];
  if (typeof parsed === "object") {
    // Single action object → wrap it.
    if (typeof parsed.action === "string") return [parsed] as ConsolidationAction[];
    // Object-wrapped array(s) under json_object grammar → concatenate all arrays.
    const actions: any[] = [];
    for (const v of Object.values(parsed)) {
      if (Array.isArray(v)) actions.push(...v);
    }
    return actions as ConsolidationAction[];
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: string): boolean {
  return UUID_RE.test(v.trim());
}

/**
 * The consolidation LLM sometimes returns LIST-POSITION numbers (e.g. "10" for the
 * 10th memory in the chunk) instead of the real UUIDs shown in the prompt. Resolve
 * every target_id: keep valid UUIDs, map integer positions -> candidate id, and drop
 * ids that resolve to nothing. Actions left with zero targets are dropped.
 */
function resolveActionIds(actions: ConsolidationAction[], candidates: MemoryCandidate[]): ConsolidationAction[] {
  const byPosition = new Map<string, string>();
  candidates.forEach((c, i) => byPosition.set(String(i + 1), c.id));
  const out: ConsolidationAction[] = [];
  for (const a of actions) {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const raw of a.target_ids || []) {
      const t = String(raw).trim();
      const resolved = isUuid(t) ? t : byPosition.get(t) || "";
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved);
        ids.push(resolved);
      }
    }
    if (ids.length === 0) {
      logger.warn({ module: 'consolidationEngine', action: a.action, reason: a.reason }, 'Dropping action with unresolvable target_ids');
      continue;
    }
    if (ids.length !== (a.target_ids || []).length) {
      logger.info({ module: 'consolidationEngine', action: a.action, resolved: ids, raw: a.target_ids }, 'Resolved positional target_ids to memory UUIDs');
    }
    out.push({ ...a, target_ids: ids });
  }
  return out;
}

// ── Consolidation Engine ──

export class ConsolidationEngine {
  /**
   * Query the database for memories with age in [minAgeDays, maxAgeDays) — i.e.
   * recorded between `NOW() - maxAgeDays` and `NOW() - minAgeDays` — that have
   * been accessed at least `minAccess` times, grouped by consolidation_hash.
   * Only groups with `minGroup`+ members are returned (cheap pre-filter).
   *
   * Tier windows (documented in readme.md): RECENT = last RECENT_MAX_AGE_DAYS
   * days (minAgeDays=0), DEEP = older than RECENT, up to DEEP_MAX_AGE_DAYS.
   */
  private async fetchConsolidationGroups(
    minAgeDays: number,
    maxAgeDays: number,
    minGroup: number,
    minAccess = 1,
  ): Promise<Map<string | null, MemoryCandidate[]>> {
    const db = kit_make_db(run_async, all_async);

    const query = `
      SELECT id, content,
             COALESCE((metadata->>'sector')::text, 'semantic') as sector,
             (metadata->>'is_genome')::boolean as is_genome,
             COALESCE((metadata->>'access_count')::int, 0) as access_count,
             recorded_at,
             consolidation_hash
      FROM "public"."memories"
      WHERE memory_tier != 'archived'
        AND recorded_at > NOW() - INTERVAL '1 day' * ${maxAgeDays}
        AND recorded_at <= NOW() - INTERVAL '1 day' * ${minAgeDays}
        AND COALESCE((metadata->>'access_count')::int, 0) >= ${minAccess}
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

      // Filter out groups smaller than minGroup (cheap pre-filter)
      for (const [hash, batch] of grouped) {
        if (batch.length < minGroup) {
          grouped.delete(hash);
        }
      }

      return grouped;
    } catch (err) {
      logger.error({ module: 'consolidationEngine', model: consolidationModel(), err }, 'Failed to fetch consolidation groups');
      return new Map();
    }
  }

  /**
   * Synthesizes a concise summary from related memories. Used as fallback when the LLM
   * forgets to provide new_content in its actions.
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
      const chatUrl = `${env.generative_url}/chat/completions`;

      const response = await fetch(chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: consolidationModel(),
          messages: [
            { role: "system", content: prompt.substring(0, 400) + "\n\nReturn only the sentence." },
            { role: "user", content: prompt }
          ],
          stream: false,
          temperature: 0.1,
          max_tokens: 200,
        }),
      });

      if (!response.ok) return "";
      const data = await response.json();
      const synthesized = ((data.choices?.[0]?.message?.content || "") as string).trim().replace(/^["']|["']$/g, "");
      return synthesized.length >= 5 ? synthesized : "";
    } catch {
      return "";
    }
  }
  /**
   * Prompts the consolidation LLM to analyze a group of related memories and
   * return consolidation actions (merge/update/promote/delete) as JSON.
   * Parsing is tolerant (see parseConsolidationJson) and retries once.
   */
  private async generateConsolidationActions(candidates: MemoryCandidate[]): Promise<ConsolidationAction[]> {
    const memoryList = candidates.map((m, i) =>
      `[${i + 1}] ID: "${m.id}" | Sector: ${m.sector} | Genome: ${m.is_genome} | Accesses: ${m.access_count}\n    Content: "${m.content}"`
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
- Optional "new_sector" MUST be EXACTLY one of: "semantic", "procedural", "episodic", "emotional", "reflective". Do NOT invent other sector names; omit it if the sector should not change.

### OUTPUT SCHEMA ###
Return ONLY a JSON object whose "actions" value is the array of actions. No markdown, no explanations outside the "reason" field.
{
  "actions": [
    {
      "action": "merge",
      "target_ids": ["id1", "id2"],
      "new_content": "The merged, concise fact.",
      "new_sector": "procedural",
      "is_genome": false,
      "reason": "Merged duplicate JWT auth preferences."
    }
  ]
}
If no actions are needed, return: {"actions": []}

### EXECUTE CONSOLIDATION NOW ###`.trim();

    let cleanJson = "";
    try {
      logger.info({ module: 'consolidationEngine', model: consolidationModel(), candidateCount: candidates.length }, `Sending ${candidates.length} related memories to ${consolidationModel()} for consolidation...`);

      const chatUrl = `${env.generative_url}/chat/completions`;

      let parsed: ConsolidationAction[] | null = null;

      // Retry once: a small/weak model can fall out of JSON mode under a long
      // prompt even with response_format json_object.
      for (let attempt = 1; attempt <= 2 && parsed === null; attempt++) {
        const response = await fetch(chatUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: consolidationModel(),
            messages: [
              { role: "system", content: prompt.substring(0, 400) + "\n\nReturn ONLY valid JSON." },
              { role: "user", content: attempt > 1 ? prompt + "\n\nIMPORTANT: Reply with ONLY a JSON object. No prose, no markdown." : prompt }
            ],
            stream: false,
            temperature: 0.1,
            max_tokens: 4000,
            response_format: { type: "json_object" },
          }),
        });

        if (!response.ok) {
          throw new Error(`Consolidation LLM returned status ${response.status}`);
        }
        const data = await response.json();
        cleanJson = ((data.choices?.[0]?.message?.content || "") as string).trim();

        parsed = parseConsolidationJson(cleanJson);
        if (parsed === null) {
          logger.warn(
            { module: 'consolidationEngine', model: consolidationModel(), attempt, rawSnippet: cleanJson.substring(0, 500) },
            'Consolidation LLM returned unparseable output — retrying',
          );
        } else {
          parsed = resolveActionIds(parsed, candidates);
          logger.info(
            { module: 'consolidationEngine', model: consolidationModel(), candidateCount: candidates.length, actionCount: parsed.length, promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens },
            'Consolidation LLM returned actions',
          );
        }
      }

      if (parsed === null) {
        throw new Error('Consolidation LLM returned unparseable output after retry');
      }

      return parsed;
    } catch (error) {
      logger.error({ module: 'consolidationEngine', model: consolidationModel(), rawSnippet: cleanJson?.substring(0, 500), err: error }, 'Consolidation LLM failed');
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
          logger.info({ module: 'consolidationEngine', model: consolidationModel(), action: action.action, reason: action.reason }, `Executing ${action.action.toUpperCase()}`);

          if (action.action === "delete") {
            const validIds = action.target_ids.filter((id) => isUuid(id));
            if (validIds.length === 0) {
              logger.warn({ module: 'consolidationEngine', action: action.action }, 'DELETE skipped — no valid UUID targets');
              continue;
            }
            const placeholders = validIds.map((_, i) => `$${i + 1}`).join(",");
            await db.query(`DELETE FROM "public"."memories" WHERE id IN (${placeholders})`, validIds);
          }
          else if (action.action === "merge" || action.action === "update") {
            // For merge/update, new_content is REQUIRED. If LLM forgot it, synthesize from the source memories.
            let content = action.new_content;

            if (!content) {
              const targetCandidates = action.target_ids.map(id => candidateMap.get(id)).filter(Boolean);
              logger.warn({ module: 'consolidationEngine', model: consolidationModel(), action: action.action }, `${action.action} missing new_content — synthesizing from source memories`);
              content = await this.synthesizeContent(targetCandidates as MemoryCandidate[]);

              if (!content) {
                logger.error({ module: 'consolidationEngine', model: consolidationModel(), action: action.action }, `Synthesis failed for ${action.action}, skipping action`);
                continue;
              }
            }

            const newSector = normalizeSector(action.new_sector || candidateMap.get(action.target_ids[0])?.sector || "semantic");
            const isGenome = action.is_genome !== undefined ? action.is_genome : candidateMap.get(action.target_ids[0])?.is_genome || false;
            const decayRate = isGenome ? DEFAULT_GENOME_DECAY_RATE : DEFAULT_PHENOTYPE_DECAY_RATE;

            // For merge/update, we update the first target ID and delete the rest to avoid duplicates
            const validIds = action.target_ids.filter((id) => isUuid(id));
            if (validIds.length === 0) {
              logger.warn({ module: 'consolidationEngine', action: action.action }, `${action.action.toUpperCase()} skipped — no valid UUID targets`);
              continue;
            }
            const primaryId = validIds[0];
            const idsToDelete = validIds.slice(1);

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
            for (const targetId of action.target_ids.filter((id) => isUuid(id))) {
              const candidate = candidateMap.get(targetId);
              const newSector = normalizeSector(action.new_sector || candidate?.sector || "semantic");
              const decayRate = DEFAULT_GENOME_DECAY_RATE;

              await db.query(
                `UPDATE "public"."memories"
                 SET is_genome = true,
                     metadata = jsonb_set(jsonb_set(metadata, '{is_genome}', 'true'::jsonb), '{sector}', to_jsonb($1::text)),
                     decay_rate = $2::numeric
                 WHERE id = $3`,
                [newSector, decayRate, targetId]
              );

              logger.info({ module: 'consolidationEngine', model: consolidationModel(), memoryId: targetId }, `Promoted memory to genome`);
            }
          }
        } catch (err) {
          hasError = true;
          logger.error({ module: 'consolidationEngine', model: consolidationModel(), action, err }, 'Failed to execute consolidation action — will roll back entire batch');
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
      logger.error({ module: 'consolidationEngine', model: consolidationModel(), err }, 'Transaction failed in executeActions');
    }
  }

  /**
   * Main entry point to trigger consolidation. Runs BOTH tiers:
   *  - RECENT: last RECENT_MAX_AGE_DAYS, min-group RECENT_MIN_GROUP (promote/merge prompt)
   *  - DEEP: older than RECENT window up to DEEP_MAX_AGE_DAYS, min-group DEEP_MIN_GROUP
   * Each tier is a no-op when nothing is eligible, so frequent recent runs are cheap.
   */
  public async runConsolidation(): Promise<void> {
    await this.runTier("recent", 0, RECENT_MAX_AGE_DAYS, RECENT_MIN_GROUP, 0);
    await this.runTier("deep", RECENT_MAX_AGE_DAYS, DEEP_MAX_AGE_DAYS, DEEP_MIN_GROUP, 1);
  }

  /** Trigger a single tier manually (used by the GUI's per-tier consolidation buttons). */
  public async runTierByName(tier: "recent" | "deep"): Promise<void> {
    if (tier === "recent") {
      await this.runTier("recent", 0, RECENT_MAX_AGE_DAYS, RECENT_MIN_GROUP, 0);
    } else {
      await this.runTier("deep", RECENT_MAX_AGE_DAYS, DEEP_MAX_AGE_DAYS, DEEP_MIN_GROUP, 1);
    }
  }

  private async runTier(
    tier: "recent" | "deep",
    minAgeDays: number,
    maxAgeDays: number,
    minGroup: number,
    minAccess: number,
  ): Promise<void> {
    logger.info(
      { module: 'consolidationEngine', model: consolidationModel(), tier, minAgeDays, maxAgeDays, minGroup },
      `Starting ${tier} consolidation cycle`,
    );

    const groups = await this.fetchConsolidationGroups(minAgeDays, maxAgeDays, minGroup, minAccess);
    if (groups.size === 0) {
      logger.info({ module: 'consolidationEngine', model: consolidationModel(), tier }, `No ${tier} memories require consolidation at this time`);
      return;
    }

    let totalActions = 0;
    let processedGroups = 0;

    for (const [hash, batch] of groups) {
      if (processedGroups >= CONSOLIDATION_BATCH_SIZE) break;

      // Chunk oversized groups (the "unhashed" bucket effectively holds the whole
      // store) so every LLM call stays within the model's context window.
      let actions: ConsolidationAction[] = [];
      for (let i = 0; i < batch.length; i += MAX_MEMORIES_PER_CALL) {
        const chunk = batch.slice(i, i + MAX_MEMORIES_PER_CALL);
        actions = actions.concat(await this.generateConsolidationActions(chunk));
      }

      if (actions.length === 0) continue;

      await this.executeActions(actions, batch);
      totalActions += actions.filter(a => a.action !== "merge" && a.action !== "update").length + 1;
      processedGroups++;
    }

    logger.info({ module: 'consolidationEngine', model: consolidationModel(), tier, processedGroups, totalActions }, `${tier} consolidation cycle complete`);
  }

  /**
   * Starts the background consolidation cron job. Call this once when your server boots.
   *
   * Two independent timers:
   *  - RECENT tier every RECENT_INTERVAL_MS (default 4h) — prompt promotion/merge.
   *  - DEEP tier every DEEP_INTERVAL_MS (default 24h) — long-window cleanup.
   * Both are unref'd so they don't block process exit.
   */
  public start(): void {
    // Recent tier: frequent, cheap, prompt.
    this.runConsolidation().catch((err) => {
      logger.error({ module: 'consolidationEngine', model: consolidationModel(), err }, 'Initial consolidation cycle failed');
    });

    const recentTimer = setInterval(() => {
      this.runTier("recent", 0, RECENT_MAX_AGE_DAYS, RECENT_MIN_GROUP, 0).catch((err) => {
        logger.error({ module: 'consolidationEngine', model: consolidationModel(), err }, 'Scheduled recent consolidation cycle failed');
      });
    }, RECENT_INTERVAL_MS);
    recentTimer.unref?.();

    // Deep tier: slower, catches mature clusters the recent tier misses.
    const deepTimer = setInterval(() => {
      this.runTier("deep", RECENT_MAX_AGE_DAYS, DEEP_MAX_AGE_DAYS, DEEP_MIN_GROUP, 1).catch((err) => {
        logger.error({ module: 'consolidationEngine', model: consolidationModel(), err }, 'Scheduled deep consolidation cycle failed');
      });
    }, DEEP_INTERVAL_MS);
    deepTimer.unref?.();

    logger.info(
      { module: 'consolidationEngine', model: consolidationModel(), recentIntervalMs: RECENT_INTERVAL_MS, deepIntervalMs: DEEP_INTERVAL_MS },
      'Consolidation engine scheduled (two-tier: recent + deep)',
    );
  }
}

// ── Singleton ───────────────────────────────────────────────────────────

export const consolidationEngine = new ConsolidationEngine();
