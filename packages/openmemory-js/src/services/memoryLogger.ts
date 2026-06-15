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

 - filename: packages/openmemory-js/src/services/memoryLogger.ts
 - what is the file used for: Async memory extraction and logging service
*/

import { env } from "../configuration";
import { make_db as kit_make_db, run_async, all_async } from "../api/routes/_kit";
import { rememberDurableMemory } from "../durable/repository";
import { DEFAULT_GENOME_DECAY_RATE, DEFAULT_PHENOTYPE_DECAY_RATE } from "./memoryInjector";


/**
 * Async log interaction - extract new memories from conversation
 * Returns count of successfully stored memories
 */
export async function logInteractionAsync(
  userPrompt: string,
  llmResponseText: string,
): Promise<{ storedCount: number }> {
  try {
    console.log('[CodeCortex] 🧠 Analyzing conversation for new memories...');

    const extractionPrompt = `
### SYSTEM DIRECTIVE ###
You are a background data-extraction API. You are NOT a chat assistant. 
You do not answer questions. You do not write code. You do not converse.
Your ONLY function is to analyze the provided text and output a strict JSON array of extracted facts.

CRITICAL RULE: If the user explicitly asks to "remember", "save", "store", or "add to memory" something, you MUST extract that exact information as a high-priority fact, regardless of whether it looks like documentation, a rule, or a preference. Treat explicit save requests as permanent (is_genome: true).

### INPUT DATA ###
User Prompt: ${userPrompt}
AI Response: ${llmResponseText}

### OUTPUT SCHEMA ###
Return ONLY a valid JSON array. No markdown, no explanations, no conversational text.
[
  {
    "content": "The extracted fact or rule",
    "sector": "procedural", // Options: semantic, procedural, episodic, emotional, reflective
    "is_genome": true // Set to true if the user explicitly asked to remember it as a permanent rule
  }
]
If no facts are worth saving, return exactly: []
`.trim();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000); // 30s timeout for extraction
    try {
      const response = await fetch(`${env.ollama_url}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.EXTRACTION_MODEL || "qwen2.5:3b",
          prompt: extractionPrompt,
          stream: false,
          format: "json"
        }),
        signal: controller.signal,
      });

      if (!response.ok) { 
        console.warn('[CodeCortex] Extraction LLM returned status', response.status); 
        return { storedCount: 0 }; 
      }

      const data = await response.json();
      let extractedMemories: any[] = [];
      
      try {
        const cleanJson = (data.response || "").replace(/^```json\s*|\s*```$/g, "").trim();
        extractedMemories = JSON.parse(cleanJson);
      } catch { 
        console.error('[CodeCortex] Failed to parse extraction JSON:', data.response); 
        return { storedCount: 0 }; 
      }

      if (!Array.isArray(extractedMemories) || extractedMemories.length === 0) {
        console.log('[CodeCortex] No new significant memories extracted.');
        return { storedCount: 0 };
      }

      // Store each extracted memory via the durable repository
      for (const mem of extractedMemories) {
        let decayRate = DEFAULT_PHENOTYPE_DECAY_RATE;
        if (mem.is_genome) decayRate = DEFAULT_GENOME_DECAY_RATE;
        else if (mem.sector === "episodic") decayRate = 0.15;
        else if (["semantic", "procedural"].includes(mem.sector)) decayRate = 0.05;

        // Use real DB connection (not mock) so INSERT operations work properly
        await rememberDurableMemory(kit_make_db(run_async, all_async), {
          content: mem.content,
          user_id: "system",
          project_id: undefined,
          metadata: { sector: mem.sector, decay_rate: decayRate },
        });

        console.log(`[CodeCortex] 💾 Saved [${mem.sector}] memory: "${mem.content.substring(0, 60)}..."`);
      }
      
      console.log(`[CodeCortex] 💾 Saved ${extractedMemories.length} new memories.`);
      
      // Return the count of successfully stored memories
      return { storedCount: extractedMemories.length };
    } finally { 
      clearTimeout(timeoutId); 
    }
  } catch (error) {
    console.error('[CodeCortex] ❌ Async memory logging failed:', error);
    return { storedCount: 0 }; // Return 0 on error
  }
}