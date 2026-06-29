/*
 - filename: packages/engram-js/src/services/memoryLogger.ts
 - what is the file used for: Async memory extraction and logging service
*/

import { env } from "../configuration";
import { make_db as kit_make_db, run_async, all_async } from "../api/routes/_kit";
import { rememberDurableMemory } from "../durable/repository";
import { DEFAULT_GENOME_DECAY_RATE, DEFAULT_PHENOTYPE_DECAY_RATE } from "./memoryInjector";
import { logger } from "../utils/logger";
import { getLangfuse } from "./langfuseClient";

/**
 * Throttle: prevent extraction from running on every single turn.
 * Skips if extraction ran within the cooldown window.
 */
const EXTRACTION_COOLDOWN_MS = parseInt(String(process.env.EG_EXTRACTION_COOLDOWN_MS), 10) || 30_000;
const MAX_FACTS_PER_TURN = parseInt(String(process.env.EG_MAX_FACTS_PER_TURN), 10) || 8;
let _lastExtractionTime = 0;

/**
 * Async log interaction - extract new memories from conversation
 * Returns count of successfully stored memories
 */
export async function logInteractionAsync(
  userPrompt: string,
  llmResponseText: string,
  sessionId?: string,
  projectId?: string,
): Promise<{ storedCount: number }> {
  try {
    // Throttle: skip if extraction ran recently
    const now = Date.now();
    if (now - _lastExtractionTime < EXTRACTION_COOLDOWN_MS) {
      logger.debug({ module: 'memoryLogger', model: env.generative_model }, 'Skipping extraction - cooldown active');
      return { storedCount: 0 };
    }
    _lastExtractionTime = now;

    // Truncate inputs to keep the prompt within reasonable bounds
    const truncatedPrompt = userPrompt.length > 2500 ? userPrompt.substring(0, 2500) + '... [TRUNCATED]' : userPrompt;
    const truncatedResponse = llmResponseText.length > 3000 ? llmResponseText.substring(0, 3000) + '... [TRUNCATED]' : llmResponseText;

    // Skip extraction for very short responses (nothing meaningful to extract)
    if (llmResponseText.trim().length < 50) {
      logger.debug({ module: 'memoryLogger', model: env.generative_model }, 'Skipping extraction - response too short');
      return { storedCount: 0 };
    }

    const extractionPrompt = `### SYSTEM DIRECTIVE ###
You are a background data-extraction API. You are NOT a chat assistant. 
You do not answer questions. You do not write code. You do not converse.
Your ONLY function is to analyze the provided text and output a strict JSON array of extracted facts.

Extract ANY of the following when present:
- User preferences, constraints, or rules they want remembered
- Important decisions or conclusions reached
- Key facts about the project, codebase, or domain discussed
- Specific file paths, function names, or architecture decisions
- User's goals, priorities, or intent
- Explicit "remember", "save", "store", or "add to memory" requests (treat as permanent, is_genome: true)

### INPUT DATA ###
User Prompt: ${truncatedPrompt}
AI Response: ${truncatedResponse}

OUTPUT SCHEMA:
Return ONLY a valid JSON array of objects. Each object MUST have a "content" field and a "sector" field.
Do NOT include any other values, strings, or primitives in the array - ONLY objects.

Example of CORRECT output:
[
  {
    "content": "The user prefers TypeScript over JavaScript",
    "sector": "semantic"
  },
  {
    "content": "Always run tests before committing",
    "sector": "procedural"
  }
]

Example of INCORRECT output (DO NOT DO THIS):
[
  { "content": "something" },
  "remember": true,  ← WRONG! This breaks JSON
  "save": true       ← WRONG! This breaks JSON
]

### EXECUTE EXTRACTION NOW ###
`.trim();

    logger.info(
      { module: 'memoryLogger', model: env.generative_model, userPromptLength: truncatedPrompt.length, responseLength: truncatedResponse.length },
      'Analyzing conversation for new memories'
    );

   const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);

    try {
      let rawResponse: string | null = null;
      let generationEnded = false;

      const chatUrl = `${env.generative_url}/chat/completions`;
      logger.info(
        { module: 'memoryLogger', model: env.generative_model, url: chatUrl },
        'Sending extraction request to remote generative endpoint'
      );

      const lf = getLangfuse();
      let generation: any;
      if (lf && sessionId) {
        // Create a top-level trace for the session so memory extraction appears as its own entry.
        // The name "Memory Analysis" groups related extractions under one visible trace.
        const memTrace = lf.trace({ 
          name: "Memory Analysis", 
          sessionId, 
          metadata: { module: "memoryLogger" },
          input: extractionPrompt.substring(0, 2000),
        });
        generation = memTrace.generation({
          name: "extract",
          model: env.generative_model,
          modelParameters: { temperature: 0.3 },
          input: extractionPrompt,
          metadata: { module: "memoryLogger" },
        });
      } else if (lf) {
        generation = lf.generation({
          name: "memory-extraction",
          model: env.generative_model,
          modelParameters: { temperature: 0.3 },
          input: extractionPrompt,
          metadata: { module: "memoryLogger" },
        });
      }

      try {
        const response = await fetch(chatUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: env.generative_model,
            messages: [
              { role: "system", content: extractionPrompt.substring(0, 400) + "\n\nReturn ONLY valid JSON." },
              { role: "user", content: extractionPrompt }
            ],
            stream: false,
            temperature: 0.3,
            max_tokens: 200,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.error(
            { module: 'memoryLogger', status: response.status, model: env.generative_model, url: chatUrl, error: errorText.substring(0, 500) },
            'Extraction LLM returned error status'
          );
          generation?.end({ output: "", level: "ERROR" });
          generationEnded = true;
          return { storedCount: 0 };
        }

        const data = await response.json();
        rawResponse = ((data.choices?.[0]?.message?.content || "") as string);

        generation?.end({
          output: rawResponse,
          usage: {
            promptTokens: data.usage?.prompt_tokens,
            completionTokens: data.usage?.completion_tokens,
          },
        });
        generationEnded = true;
      } finally {
        if (!generationEnded) {
          generation?.end({ output: null, level: "ERROR" });
        }
      }

      let extractedMemories: any[] = [];
      let parsed: any;

      try {
        const cleanJson = rawResponse.replace(/^```json\s*|\s*```$/g, "").trim();
        parsed = JSON.parse(cleanJson);
      } catch (e) { 
        logger.error(
          { module: 'memoryLogger', model: env.generative_model, rawOutput: rawResponse.substring(0, 500) },
          'Failed to parse extraction JSON'
        );
        return { storedCount: 0 }; 
      }

      // Normalize: if LLM returned a single object instead of an array, wrap it
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        logger.info(
          { module: 'memoryLogger', model: env.generative_model },
          `LLM returned single object, wrapping as array`
        );
        extractedMemories = [parsed];
      } else if (Array.isArray(parsed)) {
        extractedMemories = parsed;
      }

      if (!extractedMemories.length) {
        logger.info({ module: 'memoryLogger', model: env.generative_model }, 'No new significant memories extracted');
        return { storedCount: 0 };
      }

      // Cap extracted facts to prevent memory explosion
      if (extractedMemories.length > MAX_FACTS_PER_TURN) {
        logger.info({ module: 'memoryLogger', model: env.generative_model, total: extractedMemories.length, capped: MAX_FACTS_PER_TURN }, 'Capping extracted facts');
        extractedMemories = extractedMemories.slice(0, MAX_FACTS_PER_TURN);
      }

      // Store each extracted memory
      const db = kit_make_db(run_async, all_async);
      let storedCount = 0;
      for (const mem of extractedMemories) {
        if (!mem?.content || typeof mem.content !== 'string' || mem.content.trim().length < 5) continue;

        // Dedup: skip if an identical memory already exists
        const dedupResult = await db.query(
          `select 1 from "public"."memories" where content = $1 and superseded_at is null limit 1`,
          [mem.content.trim()],
        );
        if (dedupResult.rows?.length) {
          logger.debug({ module: 'memoryLogger', content: mem.content.substring(0, 60) }, 'Skipping duplicate memory');
          continue;
        }

        let decayRate = DEFAULT_PHENOTYPE_DECAY_RATE;
        if (mem.is_genome) decayRate = DEFAULT_GENOME_DECAY_RATE;
        else if (mem.sector === "episodic") decayRate = 0.15;
        else if (["semantic", "procedural"].includes(mem.sector)) decayRate = 0.05;

        await rememberDurableMemory(db, {
          content: mem.content.trim(),
          user_id: "system",
          project_id: projectId,
          metadata: { sector: mem.sector || "semantic", decay_rate: decayRate, is_genome: Boolean(mem.is_genome) },
        });

        storedCount++;
        logger.info({ module: 'memoryLogger', model: env.generative_model, sector: mem.sector || 'semantic', content: mem.content.substring(0, 60) }, `Saved ${mem.sector || 'semantic'} memory`);
      }
      
      logger.info({ module: 'memoryLogger', model: env.generative_model, count: storedCount }, `Saved ${storedCount} new memories`);
      return { storedCount };
    } finally { 
      clearTimeout(timeoutId); 
    }
  } catch (error) {
    logger.error({ module: 'memoryLogger', model: env.generative_model, err: error }, 'Async memory logging failed');
    return { storedCount: 0 }; // Return 0 on error
  }
}