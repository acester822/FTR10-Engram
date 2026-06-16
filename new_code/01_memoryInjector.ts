/*
    ____                   __  __                                 
   / __ \                 |  \/  |                                
  | |  | |_ __   ___ _ __ | \  / | ___ _ __ ___   ___  _ __ _   _ 
  | |  | | '_ \ / _ \ '_ \| |\/| |/ _ \ '_ ` _ \ / _ \| '__| | | |
  | |__| | |_) |  __/ | | | |  | |  __/ | | | | | (_) | |  | |_| |
   \____/| .__/ \___|_| |_|_|  |_|\___|_| |_| |_|\___/|_|   \__, |
         | |                                                 __/ |
         |_|                                                |___/ 
  CaviraOSS @ 2026

 - filename: packages/engram-js/src/services/memoryInjector.ts (plan.md version)
 - what is the file used for: Genome vs Phenotype separation and Temporal Decay engine
*/

import { db } from '../database'; // Replace with your actual DB import (Drizzle, Prisma, raw pg/better-sqlite3, etc.)
import { embedText } from '../utils/embeddings'; // Replace with your embedding function (e.g., calling Ollama/OpenAI)

// --- Types & Interfaces ---

export enum MemorySector {
  EPISODIC = 'episodic',
  SEMANTIC = 'semantic',
  PROCEDURAL = 'procedural',
  EMOTIONAL = 'emotional',
  REFLECTIVE = 'reflective'
}

export interface Memory {
  id: string;
  content: string;
  sector: MemorySector;
  is_genome: boolean;
  decay_rate: number;
  access_count: number;
  created_at: Date;
  last_accessed: Date;
  vector_score?: number; // Populated during phenotype search
}

// --- The Core Engine ---

export class MemoryInjector {
  
  /**
   * Main entry point for the Smart Proxy.
   * Takes a user prompt and returns a fully formatted cognitive context string.
   */
  async buildCognitiveContext(userPrompt: string): Promise<string> {
    console.log('[Engram] Building cognitive context for prompt...');

    // 1. Fetch Genome (Immutable, fast SQL query, no vector math)
    const genomeMemories = await this.fetchGenome();

    // 2. Fetch Phenotype (Vector search + Temporal Decay)
    const phenotypeMemories = await this.fetchPhenotype(userPrompt);

    // 3. Update access counts in the background (Fire and forget)
    this.updateAccessCounts([...genomeMemories, ...phenotypeMemories]).catch(err => 
      console.error('[Engram] Failed to update access counts:', err)
    );

    // 4. Format into the final System Prompt injection
    return this.formatPromptInjection(genomeMemories, phenotypeMemories);
  }

  /**
   * GENOME: Fast retrieval of core, immutable directives.
   * These never decay and are always injected.
   */
  private async fetchGenome(): Promise<Memory[]> {
    // SQL works for both SQLite (1/0) and Postgres (true/false)
    const query = `
      SELECT * FROM memories 
      WHERE is_genome = 1 
      ORDER BY created_at DESC 
      LIMIT 10
    `;
    return await db.query(query); 
  }

  /**
   * PHENOTYPE: Contextual retrieval using Vector Search + Temporal Decay.
   */
  private async fetchPhenotype(userPrompt: string): Promise<Memory[]> {
    // 1. Embed the user's prompt
    const promptEmbedding = await embedText(userPrompt);

    // 2. Fetch top 20 raw candidates from the DB using vector similarity
    // (Assuming you have a vector search function. If using pgvector, use <=> or <#>. 
    // If using sqlite-vss, use your virtual table match).
    const rawCandidates: Memory[] = await db.vectorSearch(promptEmbedding, 20);

    // 3. Apply the Ebbinghaus Temporal Decay Algorithm in JS
    const now = Date.now();
    const scoredMemories = rawCandidates.map(memory => {
      const vectorScore = memory.vector_score || 0;
      
      // Calculate time elapsed in DAYS
      const timeDiffMs = now - new Date(memory.created_at).getTime();
      const timeDiffDays = timeDiffMs / (1000 * 60 * 60 * 24);
      
      // Ebbinghaus formula: Retention = e^(-time / decay_rate)
      // We multiply by an access multiplier so frequently used memories resist decay
      const recencyMultiplier = Math.exp(-memory.decay_rate * timeDiffDays);
      const accessMultiplier = 1 + Math.log(1 + memory.access_count);
      
      const finalScore = vectorScore * recencyMultiplier * accessMultiplier;

      return { ...memory, finalScore };
    });

    // 4. Sort by the new decayed score and take the top 5
    scoredMemories.sort((a, b) => b.finalScore - a.finalScore);
    return scoredMemories.slice(0, 5);
  }

  /**
   * Formats the retrieved memories into a clean, token-efficient string 
   * to be injected into the LLM's system prompt.
   */
  private formatPromptInjection(genome: Memory[], phenotype: Memory[]): string {
    let contextBlock = '[CODECORTEX COGNITIVE CONTEXT]\n';

    if (genome.length > 0) {
      contextBlock += '--- CORE DIRECTIVES (GENOME) ---\n';
      genome.forEach(m => {
        contextBlock += `- ${m.content}\n`;
      });
      contextBlock += '\n';
    }

    if (phenotype.length > 0) {
      contextBlock += '--- RECALLED CONTEXT (PHENOTYPE) ---\n';
      
      // Group by sector for better LLM comprehension
      const grouped = phenotype.reduce((acc, mem) => {
        if (!acc[mem.sector]) acc[mem.sector] = [];
        acc[mem.sector].push(mem.content);
        return acc;
      }, {} as Record<string, string[]>);

      for (const [sector, contents] of Object.entries(grouped)) {
        contextBlock += `[${sector.toUpperCase()}]\n`;
        contents.forEach(c => contextBlock += `- ${c}\n`);
        contextBlock += '\n';
      }
    }

    contextBlock += '[END CODECORTEX CONTEXT]\n';
    contextBlock += 'Use the above context silently to inform your response. Do not explicitly mention "Engram" or the context blocks unless directly asked about your memory.\n';

    return contextBlock;
  }

  /**
   * Background task: Every time a memory is recalled, it becomes more 
   * resistant to future decay. We update this asynchronously.
   */
  private async updateAccessCounts(memories: Memory[]): Promise<void> {
    if (memories.length === 0) return;
    
    const ids = memories.map(m => `'${m.id}'`).join(',');
    const query = `
      UPDATE memories 
      SET access_count = access_count + 1, 
          last_accessed = CURRENT_TIMESTAMP 
      WHERE id IN (${ids})
    `;
    await db.execute(query);
  }
}

// Export a singleton instance
export const memoryInjector = new MemoryInjector();
