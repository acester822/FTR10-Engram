/*
 - filename: packages/engram-js/src/services/memoryLogger.ts
 - what is the file used for: Async memory extraction and logging service
*/

import { env } from "../configuration";
import { make_db as kit_make_db, run_async, all_async } from "../api/routes/_kit";
import { rememberDurableMemory } from "../durable/repository";
import { embed } from "../embeddings/embed";
import { DEFAULT_GENOME_DECAY_RATE, DEFAULT_PHENOTYPE_DECAY_RATE, normalizeSector } from "./memoryInjector";
import { logger } from "../utils/logger";
import { resolveGenerativeModel, tryResolveGenerativeModel, tryResolveProviderUrl } from "../database/modelRegistry";

// Extraction model comes from the canonical registry (Settings tab → env → fail).
const genModel = (): string => {
  try { return resolveGenerativeModel("extraction"); } catch { return ""; }
};
import { getLangfuse } from "./langfuseClient";

/**
 * Throttle: prevent extraction from running on every single turn.
 * Skips if extraction ran within the cooldown window.
 */
const EXTRACTION_COOLDOWN_MS = parseInt(String(process.env.EG_EXTRACTION_COOLDOWN_MS), 10) || 30_000;
const MAX_FACTS_PER_TURN = parseInt(String(process.env.EG_MAX_FACTS_PER_TURN), 10) || 5;
let _lastExtractionTime = 0;

/**
 * Heuristic gate that rejects content which is NOT worth persisting as a long-term
 * memory. The extraction LLM is asked to be selective, but we enforce a hard floor
 * here so loosened debug prompts can never flood the store with ephemeral chatter.
 */
function isWorthRemembering(content: string): boolean {
  const c = content.trim();
  if (c.length < 15) return false;          // too thin to be a meaningful fact
  if (c.length > 400) return false;         // summaries / dumps, not atomic facts
  const cl = c.toLowerCase();

  // Never store raw IDE-save diff dumps.
  if (cl.startsWith("[ide save:") || cl.includes("\ndiff for")) return false;

  // Never store anything that looks like a leaked secret / credential.
  if (/('|")?\s*(password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\b/i.test(c)
      && /[:=]\s*['"][^'"]{2,}/.test(c)) {
    return false;
  }

  // Reject pure ephemeral session state (working dir, clock, active file, session id).
  if (/^(the )?(current )?(working (directory|dir)|active file|session id|cwd)\b/i.test(cl)) return false;
  if (/^the current time is /i.test(cl)) return false;
  if (/\bsession id \d+ is currently active\b/i.test(cl)) return false;

  // Reject vague self-congratulatory boilerplate with no retrievable content.
  const vague = [
    /^no (user )?preferences or constraints (were |are )?(noted|specified)/i,
    /^no discrepancies detected/i,
    /^no permanent changes are stored/i,
    /^(the )?(system|task) (is |has )?(now )?(completed|ready|fully functional|working as expected|functioning correctly)/i,
    /^(all actions are temporary and (reversible|reversable))/i,
    /\b(build completed successfully|exit code 0|images? built without issues)\b/i,
  ];
  if (vague.some((re) => re.test(c))) return false;

  // Reject self-referential meta observations about the memory engine itself,
  // and self-narration about the current task / cleanup / "what we did".
  const meta = [
    /^(genome directive recalled|phenotype fact identified)/i,
    /(recalled \d+ relevant memories|memory injected|steer test triggered|memory block in the <memory-context>)/i,
    /^(full-coverage test|integration test):/i,
    /^(key (insight|fact)|important decision was to|the system remembers the need)/i,
    /^(the system confirms (successful|the health|memory retrieval))/i,
    /recall integrates genome/i,
    // Instruction/self-narration about the memory store itself.
    /^(the )?(system|engine|memory( store| engine| logging)?) (should|must|will|needs to|is (supposed to|configured to)|was) (remember|recall|forget|store|retain|remove|filter|adjust|log|note|recommend)/i,
    /^(the )?system should (remember|recall|note|log|store)/i,
    /^(recommended to|we should|i should|let'?s) (remove|keep|retain|clean|store|note|remember)/i,
    /memory logging was adjusted|non-essential noise|durable facts about memory structure|before (final )?consolidation/i,
    /a clear preference for (typescript|python|[\w-]+) is noted/i,
  ];
  if (meta.some((re) => re.test(c))) return false;

  // Reject "what we did this session" recaps and status self-narration: these are
  // ephemeral and not reusable facts. This is the class that previously slipped
  // through (e.g. "memory logging fixed with updated schema", "three files modified:",
  // "system recovered from a freeze", "system confirms it runs the latest version").
  const recap = [
    /^(the )?(system|engine|memory( store| engine| logging)?|task|build|service|extension) (was |has been |is now |now )?(fixed|updated|modified|adjusted|changed|patched|corrected|improved|restored|rebuilt|recreated)/i,
    /^(the )?(system|task|build|service) (recovered|resumed|restarted|reloaded) (from|operation)/i,
    /^(the )?system confirms (it |the )?(runs|is running|the latest|successful)/i,
    /^(the )?(system|build|extension|service) (runs|is) (the )?(latest|current|newest) (stable )?version/i,
    /^(the )?(system|task|build) (is |has )?(now )?(complete|completed|working|functional|ready|stable)/i,
    /^\d+ (files?|memories) (modified|changed|added|updated|created|deleted|removed)/i,
    /^(added|updated|modified|fixed|removed|deleted) \d+ (files?|memories|embeddings)/i,
    /^(verified|confirmed|tested|checked) (the |that )?(installed|running|current|latest|build)/i,
    /^(restarting|restoring|rebuilding) [a-z]+ (resolves|fixed|clears|recovers)/i,
  ];
  if (recap.some((re) => re.test(c))) return false;

  return true;
}

/**
 * Lexical near-duplicate check against existing active memories. Used as a cheap
 * pre-filter before the (more expensive) LLM extraction runs, and again after, to
 * stop near-identical re-phrasings from accumulating.
 */
async function isNearDuplicate(db: any, content: string): Promise<boolean> {
  const c = content.trim().toLowerCase().replace(/\s+/g, " ");
  try {
    const result = await db.query(
      `select content from "public"."memories" where superseded_at is null`,
      [],
    );
    for (const row of result.rows || []) {
      const existing = String(row.content || "").trim().toLowerCase().replace(/\s+/g, " ");
      if (!existing) continue;
      // Exact or one is a substring of the other → duplicate.
      if (c === existing) return true;
      if (c.length > 20 && existing.includes(c)) return true;
      if (existing.length > 20 && c.includes(existing)) return true;
    }
  } catch { /* best-effort */ }
  return false;
}

/**
 * Async log interaction - extract new memories from conversation
 * Returns count of successfully stored memories
 */
export async function logInteractionAsync(
  userPrompt: string,
  llmResponseText: string,
  sessionId?: string,
  projectId?: string,
  allowGenome: boolean = true,
): Promise<{ storedCount: number; sectors: Record<string, number> }> {
  const empty = () => ({ storedCount: 0, sectors: {} as Record<string, number> });
  try {
    // Throttle: skip if extraction ran recently
    const now = Date.now();
    if (now - _lastExtractionTime < EXTRACTION_COOLDOWN_MS) {
      logger.debug({ module: 'memoryLogger', model: genModel() }, 'Skipping extraction - cooldown active');
      return empty();
    }
    _lastExtractionTime = now;

    // Truncate inputs to keep the prompt within reasonable bounds
    const truncatedPrompt = userPrompt.length > 2500 ? userPrompt.substring(0, 2500) + '... [TRUNCATED]' : userPrompt;
    const truncatedResponse = llmResponseText.length > 3000 ? llmResponseText.substring(0, 3000) + '... [TRUNCATED]' : llmResponseText;

    // Skip extraction for very short responses (nothing meaningful to extract)
    if (llmResponseText.trim().length < 50) {
      logger.debug({ module: 'memoryLogger', model: genModel() }, 'Skipping extraction - response too short');
      return empty();
    }

    const extractionPrompt = `### SYSTEM DIRECTIVE ###
You are a conservative background memory-extraction API. You are NOT a chat assistant.
You do not answer questions. You do not write code. You do not converse.
Your ONLY function is to extract DURABLE, REUSABLE facts from the conversation that would
genuinely help a future session.

### WHAT IS WORTH EXTRACTING (be selective — only extract if it meets the bar) ###
- A clear, stated USER PREFERENCE, constraint, or standing rule (e.g. "prefers TypeScript", "always run tests before committing").
- A confirmed, non-obvious DECISION or CONCLUSION about architecture/design that is stable over time.
- A reusable FACT about the project, codebase, or domain (e.g. service ports, model names, config keys).
- An explicit "remember this / save this" request from the user (mark is_genome: true).

### DO NOT EXTRACT (these are noise — never emit them) ###
- Transient session/debugging chatter: build results, "working directory is X", timestamps, active file names, session IDs, "X is now functional" confirmations.
- IDE-save diff dumps, stack traces, or raw tool output.
- Self-referential meta about the memory system ("memory injected", "recalled N memories", "genome directive recalled").
- Vague boilerplate with no retrievable content ("no preferences were noted", "task completed").
- Anything that merely restates the user's immediate ask or the assistant's ephemeral status.
- Literal secrets, passwords, API keys, or tokens — NEVER extract credentials.

### OUTPUT SCHEMA ###
Return ONLY a valid JSON array of objects. Each object MUST have "content" and "sector".
- "content": a single self-contained, atomic fact written in third person (no "I"/"we"/"the user said"). 15–250 chars. No diffs, no timestamps, no file paths unless the path IS the fact.
- "sector": exactly one of: "semantic", "procedural", "episodic", "emotional", "reflective". If unsure, use "semantic".
- "is_genome": true ONLY for permanent standing rules/explicit save requests; otherwise omit (defaults to false).
Do NOT invent other fields. If nothing meets the bar, return [].

Example of CORRECT output:
[
  { "content": "The user prefers TypeScript over JavaScript", "sector": "semantic" },
  { "content": "Always run tests before committing", "sector": "procedural" }
]

### INPUT DATA ###
User Prompt: ${truncatedPrompt}
AI Response: ${truncatedResponse}

### EXECUTE EXTRACTION NOW ###
`.trim();

    // Split the directive (instructions, incl. the "DO NOT EXTRACT" rules) from the
    // input data so the FULL directive lands in the system role. Previously the system
    // message was truncated to 400 chars, which cut off the entire "DO NOT EXTRACT"
    // block — so the model was told what to extract but never what to avoid, and it
    // emitted session-recap chatter that slipped past the keyword gate.
    const _splitAt = extractionPrompt.indexOf("### INPUT DATA ###");
    const systemDirective = (_splitAt >= 0 ? extractionPrompt.substring(0, _splitAt) : extractionPrompt).trim();
    const userData = (_splitAt >= 0 ? extractionPrompt.substring(_splitAt) : "").trim();

    logger.info(
      { module: 'memoryLogger', model: genModel(), userPromptLength: truncatedPrompt.length, responseLength: truncatedResponse.length },
      'Analyzing conversation for new memories'
    );

   const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);

    try {
      let rawResponse: string | null = null;
      let generationEnded = false;

      const chatUrl = `${tryResolveProviderUrl("generative")}/chat/completions`;
      logger.info(
        { module: 'memoryLogger', model: genModel(), url: chatUrl },
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
          model: genModel(),
          modelParameters: { temperature: 0.3 },
          input: extractionPrompt,
          metadata: { module: "memoryLogger" },
        });
      } else if (lf) {
        generation = lf.generation({
          name: "memory-extraction",
          model: genModel(),
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
            model: genModel(),
            messages: [
              { role: "system", content: systemDirective },
              { role: "user", content: userData }
            ],
            stream: false,
            temperature: 0.2,
            max_tokens: 1000,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.error(
            { module: 'memoryLogger', status: response.status, model: genModel(), url: chatUrl, error: errorText.substring(0, 500) },
            'Extraction LLM returned error status'
          );
          generation?.end({ output: "", level: "ERROR" });
          generationEnded = true;
          return empty();
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
        // Strip markdown code fences (```json ... ``` or bare ``` ... ```) anywhere
        // in the response, then fall back to extracting the outermost JSON object in
        // case the model prepends prose (e.g. "Here is the extraction:").
        let cleanJson = rawResponse
          .replace(/```json\s*([\s\S]*?)\s*```/gi, "$1")
          .replace(/```\s*([\s\S]*?)\s*```/g, "$1")
          .trim();
        try {
          parsed = JSON.parse(cleanJson);
        } catch {
          const start = cleanJson.indexOf("{");
          const end = cleanJson.lastIndexOf("}");
          if (start !== -1 && end > start) {
            parsed = JSON.parse(cleanJson.slice(start, end + 1));
          } else {
            throw new Error("no JSON object found in extraction output");
          }
        }
      } catch (e) {
        logger.error(
          { module: 'memoryLogger', model: genModel(), rawOutput: rawResponse.substring(0, 500) },
          'Failed to parse extraction JSON'
        );
        return empty();
      }

      // Normalize: if LLM returned a single object instead of an array, wrap it
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        logger.info(
          { module: 'memoryLogger', model: genModel() },
          `LLM returned single object, wrapping as array`
        );
        extractedMemories = [parsed];
      } else if (Array.isArray(parsed)) {
        extractedMemories = parsed;
      }

      if (!extractedMemories.length) {
        logger.info({ module: 'memoryLogger', model: genModel() }, 'No new significant memories extracted');
        return empty();
      }

      // Cap extracted facts to prevent memory explosion
      if (extractedMemories.length > MAX_FACTS_PER_TURN) {
        logger.info({ module: 'memoryLogger', model: genModel(), total: extractedMemories.length, capped: MAX_FACTS_PER_TURN }, 'Capping extracted facts');
        extractedMemories = extractedMemories.slice(0, MAX_FACTS_PER_TURN);
      }

      // Quality gate: drop anything that isn't worth persisting long-term.
      const beforeGate = extractedMemories.length;
      extractedMemories = extractedMemories.filter((mem) =>
        mem?.content && typeof mem.content === 'string' && isWorthRemembering(mem.content),
      );
      if (extractedMemories.length < beforeGate) {
        logger.info({ module: 'memoryLogger', model: genModel(), dropped: beforeGate - extractedMemories.length }, 'Quality gate dropped low-value candidates');
      }

      if (!extractedMemories.length) {
        logger.info({ module: 'memoryLogger', model: genModel() }, 'No new significant memories extracted');
        return empty();
      }

      // Store each extracted memory
      const db = kit_make_db(run_async, all_async);
      let storedCount = 0;
      const sectors: Record<string, number> = {};
      for (const mem of extractedMemories) {
        const content = typeof mem.content === 'string' ? mem.content.trim() : '';
        if (content.length < 5) continue;

        // Normalize the LLM-provided sector to a canonical value before use.
        const sector = normalizeSector(mem.sector, "semantic");

        // Dedup: skip if an identical or near-duplicate memory already exists
        const dedupResult = await db.query(
          `select 1 from "public"."memories" where content = $1 and superseded_at is null limit 1`,
          [content],
        );
        if (dedupResult.rows?.length) {
          logger.debug({ module: 'memoryLogger', content: content.substring(0, 60) }, 'Skipping duplicate memory');
          continue;
        }
        if (await isNearDuplicate(db, content)) {
          logger.debug({ module: 'memoryLogger', content: content.substring(0, 60) }, 'Skipping near-duplicate memory');
          continue;
        }

        let decayRate = DEFAULT_PHENOTYPE_DECAY_RATE;
        if (mem.is_genome && allowGenome) decayRate = DEFAULT_GENOME_DECAY_RATE;
        else if (sector === "episodic") decayRate = 0.15;
        else if (["semantic", "procedural"].includes(sector)) decayRate = 0.05;

        await rememberDurableMemory(db, {
          content,
          user_id: "system",
          project_id: projectId,
          embedding: await embed(content),
          metadata: { sector, decay_rate: decayRate, is_genome: Boolean(mem.is_genome && allowGenome) },
        });

        storedCount++;
        sectors[sector] = (sectors[sector] || 0) + 1;
        logger.info({ module: 'memoryLogger', model: genModel(), sector, content: content.substring(0, 60) }, `Saved ${sector} memory`);
      }

      logger.info({ module: 'memoryLogger', model: genModel(), count: storedCount }, `Saved ${storedCount} new memories`);
      return { storedCount, sectors };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    logger.error({ module: 'memoryLogger', model: genModel(), err: error }, 'Async memory logging failed');
    return empty(); // Return 0 on error
  }
}