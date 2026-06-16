import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../database'; // Your DB instance
import { MemorySector } from './memoryInjector';

// Configuration
const CONSOLIDATION_THRESHOLD_DAYS = 2; // Memories older than 2 days are candidates
const MIN_MEMORIES_TO_CONSOLIDATE = 3;  // Don't consolidate unless we have at least 3 related memories
const LOCAL_LLM_MODEL = process.env.CONSOLIDATION_MODEL || 'phi3'; // Fast, cheap local model
const LOCAL_LLM_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

export class ConsolidationEngine {
  
  /**
   * Starts the background cron job. Call this once when your server boots.
   */
  public start() {
    // Run every 30 minutes: '*/30 * * * *'
    // For testing, you can change this to '* * * * *' (every minute)
    cron.schedule('*/30 * * * *', async () => {
      console.log('[Engram] 🧠 Starting memory consolidation cycle...');
      await this.runConsolidationCycle();
    });
    console.log('[Engram] Consolidation engine scheduled (every 30 mins).');
  }

  private async runConsolidationCycle() {
    try {
      // 1. Fetch candidate episodic memories older than X days
      // (SQLite syntax: datetime('now', '-2 days'). Postgres: NOW() - INTERVAL '2 days')
      const timeThreshold = this.getTimeThresholdSql();
      
      const candidates = await db.query(`
        SELECT id, content, created_at 
        FROM memories 
        WHERE sector = 'episodic' 
          AND created_at < ${timeThreshold}
          AND is_genome = FALSE
        ORDER BY created_at ASC
        LIMIT 50
      `);

      if (candidates.length < MIN_MEMORIES_TO_CONSOLIDATE) {
        console.log(`[Engram] Only ${candidates.length} candidates. Skipping consolidation.`);
        return;
      }

      // 2. Group candidates by a simple heuristic (e.g., first 3 words, or just batch them)
      // For simplicity, we'll batch the oldest 5-10 memories together per cycle.
      const batch = candidates.slice(0, 10);
      console.log(`[Engram] Synthesizing ${batch.length} episodic memories...`);

      // 3. Prompt the local LLM to synthesize
      const synthesizedContent = await this.synthesizeWithLLM(batch);

      if (!synthesizedContent || synthesizedContent.trim().length < 10) {
        console.warn('[Engram] LLM returned empty synthesis. Aborting.');
        return;
      }

      // 4. Insert the new SEMANTIC memory
      const newMemoryId = uuidv4();
      await db.execute(`
        INSERT INTO memories (id, content, sector, is_genome, decay_rate, access_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `, [
        newMemoryId,
        synthesizedContent,
        MemorySector.SEMANTIC,
        false,
        0.05, // Semantic memories decay much slower than episodic (0.05 vs 0.1)
        1
      ]);

      // 5. Delete the old episodic memories (or mark them as archived)
      const idsToDelete = batch.map(m => `'${m.id}'`).join(',');
      await db.execute(`
        DELETE FROM memories WHERE id IN (${idsToDelete})
      `);

      console.log(`[Engram] ✅ Consolidation complete. Created semantic memory: ${newMemoryId}`);

    } catch (error) {
      console.error('[Engram] ❌ Consolidation cycle failed:', error);
    }
  }

  /**
   * Sends a batch of memories to a local LLM to be compressed into a single fact.
   */
  private async synthesizeWithLLM(memories: { content: string; created_at: string }[]): Promise<string> {
    const memoryList = memories.map(m => `- [${m.created_at.split('T')[0]}] ${m.content}`).join('\n');
    
    const prompt = `
You are a cognitive memory consolidation engine. 
Your task is to read the following short-term, fragmented "episodic" memories and synthesize them into ONE concise, timeless "semantic" fact or rule.
Discard irrelevant details (like specific dates or one-off errors). Focus on the core pattern, preference, or architectural fact.
Respond ONLY with the synthesized sentence. Do not add quotes or introductory text.

Episodic Memories:
${memoryList}

Synthesized Semantic Memory:
    `.trim();

    try {
      const response = await fetch(`${LOCAL_LLM_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: LOCAL_LLM_MODEL,
          prompt: prompt,
          stream: false,
          options: {
            temperature: 0.1, // Keep it deterministic and factual
            num_predict: 150  // Keep it short
          }
        })
      });

      const data = await response.json();
      return data.response.trim();
    } catch (error) {
      console.error('[Engram] LLM Synthesis failed:', error);
      return '';
    }
  }

  /**
   * Helper to generate cross-compatible SQL time thresholds.
   */
  private getTimeThresholdSql(): string {
    // Detect DB type based on your config, or default to SQLite syntax
    const isPostgres = process.env.DB_TYPE === 'postgres';
    if (isPostgres) {
      return `NOW() - INTERVAL '${CONSOLIDATION_THRESHOLD_DAYS} days'`;
    }
    return `datetime('now', '-${CONSOLIDATION_THRESHOLD_DAYS} days')`;
  }
}

// Export singleton
export const consolidationEngine = new ConsolidationEngine();
