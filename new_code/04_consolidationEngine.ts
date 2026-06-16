import { env } from "../configuration";
import { make_db as kit_make_db, run_async, all_async } from "../api/routes/_kit";
import { DEFAULT_GENOME_DECAY_RATE, DEFAULT_PHENOTYPE_DECAY_RATE } from "./memoryInjector";

const CONSOLIDATION_MODEL = process.env.CONSOLIDATION_MODEL || "qwen2.5:14b";
const CONSOLIDATION_BATCH_SIZE = 15; // Keep batch small to fit in 14B's context window comfortably

interface MemoryCandidate {
  id: string;
  content: string;
  sector: string;
  is_genome: boolean;
  access_count: number;
  recorded_at: string;
}

interface ConsolidationAction {
  action: "merge" | "update" | "promote" | "delete";
  target_ids: string[]; // IDs of memories this action applies to
  new_content?: string; // Required for merge/update/promote
  new_sector?: string;  // Optional: change sector if context shifts
  is_genome?: boolean;  // Optional: promote to permanent rule
  reason: string;       // Brief explanation for logging/debugging
}

export class ConsolidationEngine {
  /**
   * Fetches a batch of memories that are candidates for consolidation.
   * Prioritizes older phenotype memories or those with high access counts.
   */
  private async fetchConsolidationCandidates(): Promise<MemoryCandidate[]> {
    const db = kit_make_db(run_async, all_async);
    
    // Fetch older phenotype memories that have been accessed at least once, 
    // or any memory older than 7 days.
    const query = `
      SELECT id, content, 
             COALESCE((metadata->>'sector')::text, 'semantic') as sector,
             (metadata->>'is_genome')::boolean as is_genome,
             COALESCE((metadata->>'access_count')::int, 0) as access_count,
             recorded_at
      FROM "public"."memories"
      WHERE memory_tier != 'archived'
      ORDER BY recorded_at ASC
      LIMIT $1
    `;

    try {
      const result = await db.query(query, [CONSOLIDATION_BATCH_SIZE]);
      return (result.rows || []).map((r: any) => ({
        id: r.id,
        content: r.content,
        sector: r.sector,
        is_genome: r.is_genome,
        access_count: r.access_count,
        recorded_at: r.recorded_at,
      }));
    } catch (err) {
      console.error("[Engram] Failed to fetch consolidation candidates:", err);
      return [];
    }
  }

  /**
   * Prompts the 14B model to analyze the batch and return consolidation actions.
   */
  private async generateConsolidationActions(candidates: MemoryCandidate[]): Promise<ConsolidationAction[]> {
    const memoryList = candidates.map((m, i) => 
      `[${i + 1}] ID: ${m.id} | Sector: ${m.sector} | Genome: ${m.is_genome} | Accesses: ${m.access_count}\n    Content: "${m.content}"`
    ).join("\n");

    const prompt = `
### SYSTEM DIRECTIVE ###
You are an elite Memory Consolidation Engine. Your job is to analyze a batch of stored memories and output a strict JSON array of consolidation actions to keep the knowledge base clean, dense, and accurate.

### INPUT DATA ###
${memoryList}

### CONSOLIDATION RULES ###
1. MERGE: If two or more memories state the same fact or rule, merge them into one concise memory. Set action="merge", provide target_ids, and new_content.
2. UPDATE: If a memory is partially outdated but still relevant, update it. Set action="update", provide target_ids, and new_content.
3. PROMOTE: If a phenotype memory has proven to be a permanent, unchangeable rule (high access count, foundational), promote it. Set action="promote", target_ids, new_content (optional), and is_genome=true.
4. DELETE: If a memory is obsolete, superseded, or trivial noise, delete it. Set action="delete" and target_ids.

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

### EXECUTE CONSOLIDATION NOW ###
`.trim();

    try {
      console.log(`[Engram] 🧠 Sending ${candidates.length} memories to ${CONSOLIDATION_MODEL} for consolidation...`);
      
      const response = await fetch(`${env.ollama_url}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: CONSOLIDATION_MODEL,
          prompt: prompt,
          stream: false,
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
            num_predict: 1000
          }
        }),
      });

      if (!response.ok) {
        throw new Error(`Consolidation LLM returned status ${response.status}`);
      }

      const data = await response.json();
      const cleanJson = (data.response || "").replace(/^```json\s*|\s*```$/g, "").trim();
      
      return JSON.parse(cleanJson) as ConsolidationAction[];
    } catch (error) {
      console.error("[Engram] ❌ Consolidation LLM failed:", error);
      return [];
    }
  }

  /**
   * Executes the consolidation actions against the database.
   */
  private async executeActions(actions: ConsolidationAction[], candidates: MemoryCandidate[]) {
    const db = kit_make_db(run_async, all_async);
    const candidateMap = new Map(candidates.map(c => [c.id, c]));

    for (const action of actions) {
      try {
        console.log(`[Engram] ⚙️ Executing ${action.action.toUpperCase()}: ${action.reason}`);

        if (action.action === "delete") {
          const placeholders = action.target_ids.map((_, i) => `$${i + 1}`).join(",");
          await db.query(`DELETE FROM "public"."memories" WHERE id IN (${placeholders})`, action.target_ids);
        } 
        else if (action.action === "merge" || action.action === "update" || action.action === "promote") {
          if (!action.new_content) {
            console.warn(`[Engram] Skipping ${action.action} due to missing new_content`);
            continue;
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
                 metadata = jsonb_set(metadata, '{sector}', to_jsonb($2::text)),
                 metadata = jsonb_set(metadata, '{is_genome}', to_jsonb($3::boolean)),
                 metadata = jsonb_set(metadata, '{decay_rate}', to_jsonb($4::numeric))
             WHERE id = $5`,
            [action.new_content, newSector, isGenome, decayRate, primaryId]
          );

          if (idsToDelete.length > 0) {
            const placeholders = idsToDelete.map((_, i) => `$${i + 1}`).join(",");
            await db.query(`DELETE FROM "public"."memories" WHERE id IN (${placeholders})`, idsToDelete);
          }
        }
      } catch (err) {
        console.error(`[Engram] Failed to execute action:`, action, err);
        // Continue to next action even if one fails
      }
    }
  }

  /**
   * Main entry point to trigger consolidation.
   */
  public async runConsolidation(): Promise<void> {
    console.log("[Engram] 🔄 Starting memory consolidation cycle...");
    
    const candidates = await this.fetchConsolidationCandidates();
    if (candidates.length === 0) {
      console.log("[Engram] ✅ No memories require consolidation at this time.");
      return;
    }

    const actions = await this.generateConsolidationActions(candidates);
    if (actions.length === 0) {
      console.log("[Engram] ✅ LLM determined no consolidation actions are needed.");
      return;
    }

    await this.executeActions(actions, candidates);
    console.log(`[Engram] 🎉 Consolidation cycle complete. Executed ${actions.length} actions.`);
  }
}

export const consolidationEngine = new ConsolidationEngine();