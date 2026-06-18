/*
 - filename: packages/engram-js/src/services/memoryLogger.ts
 - what is the file used for: Async memory extraction and logging service
*/

import { env } from "../configuration";
import { make_db as kit_make_db, run_async, all_async } from "../api/routes/_kit";
import { rememberDurableMemory } from "../durable/repository";
import { DEFAULT_GENOME_DECAY_RATE, DEFAULT_PHENOTYPE_DECAY_RATE } from "./memoryInjector";
import { logger } from "../utils/logger";

const EXTRACTION_MODEL = env.generative_model;

/**
 * Async log interaction - extract new memories from conversation
 * Returns count of successfully stored memories
 */
export async function logInteractionAsync(
  userPrompt: string,
  llmResponseText: string,
): Promise<{ storedCount: number }> {
  try {
    // Truncate inputs to keep the prompt within reasonable bounds for Ollama's generate endpoint
    const truncatedPrompt = userPrompt.length > 1500 ? userPrompt.substring(0, 1500) + '... [TRUNCATED]' : userPrompt;
    const truncatedResponse = llmResponseText.length > 1500 ? llmResponseText.substring(0, 1500) + '... [TRUNCATED]' : llmResponseText;

    // Skip extraction for very short responses (nothing meaningful to extract)
    if (llmResponseText.trim().length < 50) {
      logger.debug({ module: 'memoryLogger' }, 'Skipping extraction - response too short');
      return { storedCount: 0 };
    }

    const extractionPrompt = `### SYSTEM DIRECTIVE ###
You are a background data-extraction API. You are NOT a chat assistant. 
You do not answer questions. You do not write code. You do not converse.
Your ONLY function is to analyze the provided text and output a strict JSON array of extracted facts.

CRITICAL RULE: If the user explicitly asks to "remember", "save", "store", or "add to memory" something, you MUST extract that exact information as a high-priority fact, regardless of whether it looks like documentation, a rule, or a preference. Treat explicit save requests as permanent (is_genome: true).

### INPUT DATA ###
User Prompt: ${truncatedPrompt}
AI Response: ${truncatedResponse}

### OUTPUT SCHEMA ###
Return ONLY a valid JSON array. No markdown, no explanations, no conversational text.
[
  {
    "content": "The extracted fact or rule",
    "sector": "procedural",
    "is_genome": true
  }
]
If no facts are worth saving, return exactly: []

### EXECUTE EXTRACTION NOW ###
`.trim();

    logger.info(
      { module: 'memoryLogger', model: EXTRACTION_MODEL, ollamaUrl: env.ollama_url, userPromptLength: truncatedPrompt.length, responseLength: truncatedResponse.length },
      'Analyzing conversation for new memories'
    );

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);
    
    try {
      const generateUrl = `${env.ollama_url}/api/generate`;
      logger.info(
        { module: 'memoryLogger', model: EXTRACTION_MODEL, url: generateUrl },
        'Sending extraction request to Ollama'
      );

      const response = await fetch(generateUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: EXTRACTION_MODEL,
          prompt: `${extractionPrompt}\n\n/no_think`, // Disable thinking for generative tasks
          stream: false,
          think: false, // Native API parameter to disable thinking
          options: {
            temperature: 0.1,
            num_predict: 500,
            num_ctx: 2048,
            num_batch: 512
          }
        }),
        signal: controller.signal,
      });

      if (!response.ok) { 
        const errorText = await response.text();
        logger.error(
          { module: 'memoryLogger', status: response.status, model: EXTRACTION_MODEL, url: generateUrl, error: errorText.substring(0, 500) },
          'Extraction LLM returned error status'
        );
        return { storedCount: 0 }; 
      }

      let extractedMemories: any[] = [];
      let parsed: any;

      const data = await response.json();
      let rawResponse: string;
      
      if (data.response && typeof data.response === 'string') {
        // /api/generate format
        rawResponse = data.response;
        logger.info(
          { module: 'memoryLogger', model: EXTRACTION_MODEL, url: generateUrl, responseLength: rawResponse.length },
          `Extraction LLM responded via /api/generate (first 200 chars: "${rawResponse.substring(0, 200)}")`
        );
      } else {
        logger.error(
          { module: 'memoryLogger', model: EXTRACTION_MODEL, response: JSON.stringify(data).substring(0, 500) },
          'Invalid response structure from extraction LLM'
        );
        return { storedCount: 0 };
      }

      try {
        const cleanJson = rawResponse.replace(/^```json\s*|\s*```$/g, "").trim();
        parsed = JSON.parse(cleanJson);
      } catch (e) { 
        logger.error(
          { module: 'memoryLogger', model: EXTRACTION_MODEL, url: generateUrl, rawOutput: rawResponse.substring(0, 500) },
          'Failed to parse extraction JSON'
        );
        return { storedCount: 0 }; 
      }

      // Normalize: if LLM returned a single object instead of an array, wrap it
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        logger.info(
          { module: 'memoryLogger', model: EXTRACTION_MODEL },
          `LLM returned single object, wrapping as array`
        );
        extractedMemories = [parsed];
      } else if (Array.isArray(parsed)) {
        extractedMemories = parsed;
      }

      if (!extractedMemories.length) {
        logger.info({ module: 'memoryLogger' }, 'No new significant memories extracted');
        return { storedCount: 0 };
      }

      // Store each extracted memory
      const db = kit_make_db(run_async, all_async);
      for (const mem of extractedMemories) {
        if (!mem?.content || typeof mem.content !== 'string' || mem.content.trim().length < 5) continue;

        let decayRate = DEFAULT_PHENOTYPE_DECAY_RATE;
        if (mem.is_genome) decayRate = DEFAULT_GENOME_DECAY_RATE;
        else if (mem.sector === "episodic") decayRate = 0.15;
        else if (["semantic", "procedural"].includes(mem.sector)) decayRate = 0.05;

        await rememberDurableMemory(db, {
          content: mem.content.trim(),
          user_id: "system",
          project_id: undefined,
          metadata: { sector: mem.sector || "semantic", decay_rate: decayRate, is_genome: Boolean(mem.is_genome) },
        });

        logger.info({ module: 'memoryLogger', sector: mem.sector || 'semantic', content: mem.content.substring(0, 60) }, `Saved ${mem.sector || 'semantic'} memory`);
      }
      
      const storedCount = extractedMemories.filter((m: any) => m?.content && typeof m.content === 'string' && m.content.trim().length >= 5).length;
      logger.info({ module: 'memoryLogger', count: storedCount }, `Saved ${storedCount} new memories`);
      return { storedCount };
    } finally { 
      clearTimeout(timeoutId); 
    }
  } catch (error) {
    logger.error({ module: 'memoryLogger', err: error }, 'Async memory logging failed');
    return { storedCount: 0 }; // Return 0 on error
  }
}