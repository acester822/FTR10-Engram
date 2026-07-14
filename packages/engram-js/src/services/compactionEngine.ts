import { env } from "../configuration";
import { make_db as kit_make_db, run_async, all_async } from "../api/routes/_kit";
import { rememberDurableMemory } from "../durable/repository";
import { DEFAULT_PHENOTYPE_DECAY_RATE, normalizeSector } from "./memoryInjector";
import { logger } from "../utils/logger";
import { getLangfuse } from "./langfuseClient";

const COMPACTION_TRIGGER     = parseInt(String(process.env.EG_COMPACT_TRIGGER), 10) || 50;
const MAX_RAW_TURNS          = parseInt(String(process.env.EG_MAX_RAW_TURNS), 10) || 6;
const COMPACTION_PROMPT_MAX_CHARS = parseInt(String(process.env.EG_COMPACT_PROMPT_MAX_CHARS), 10) || 4096;
const COMPACTION_TIMEOUT_MS  = (parseInt(String(process.env.EG_COMPACT_TIMEOUT_SEC), 10) || 15) * 1000;

export interface Message {
  role: string;
  content: string | any[];
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

export interface CompactionResult {
  messages: Message[];
  extractedFactCount: number;
}

interface ExtractedFact {
  content: string;
  sector: "semantic" | "procedural" | "episodic" | "emotional" | "reflective";
}

export class CompactionEngine {
  private lastCompactedHash: string | null = null;
  private lastCompactionTime: number = 0;
  private readonly COMPACTION_COOLDOWN_MS = parseInt(String(process.env.EG_COMPACTION_COOLDOWN_MS), 10) || 10_000;

  public async compactIfNeeded(messages: Message[], sessionId?: string, projectId?: string): Promise<CompactionResult> {
    if (messages.length <= COMPACTION_TRIGGER) {
      return { messages, extractedFactCount: 0 };
    }

    const oldMessages = messages.slice(0, messages.length - MAX_RAW_TURNS);
    let recentMessages = messages.slice(-MAX_RAW_TURNS);

    logger.info(
      { module: 'compactionEngine', oldMessageCount: oldMessages.length, model: env.generative_model },
      'Triggering context compaction'
    );

    // 🛡️ CRITICAL: Ensure tool call/result pairs are not split across the boundary
    recentMessages = this.fixToolCallBoundaries(messages, recentMessages);

    // 🛡️ CRITICAL FIX: Find and preserve the most recent user message from oldMessages
    // Search backwards through old messages to find the last user query
    const lastUserMessage = oldMessages.slice().reverse().find(m => m.role === 'user');
    
    if (lastUserMessage) {
      // Prepend the user message to recent messages to preserve context
      recentMessages = [lastUserMessage, ...recentMessages];
      logger.info(
        { module: 'compactionEngine' },
        'Preserved user message from old history'
      );
    } else if (!recentMessages.some(m => m.role === 'user')) {
      // No user message anywhere - this is a critical error
      logger.error(
        { module: 'compactionEngine' },
        'No user message found in entire conversation history'
      );
    }

    const thinnedHistory = this.thinMessages(oldMessages);
    const { summary, extractedFacts } = await this.generateSummaryAndExtract(thinnedHistory);

    let savedCount = 0;
    if (extractedFacts.length > 0) {
      savedCount = await this.saveExtractedFacts(extractedFacts, projectId);
      logger.info(
        { module: 'compactionEngine', count: savedCount },
        'Compaction extracted and saved new phenotype memories'
      );
    }

    const safeSummary = this.sanitizeSummary(summary);
    const compactedSystemMessage: Message = {
      role: "system",
      content: `[COMPACTED SESSION SUMMARY]\n${safeSummary}\n[END COMPACTED SUMMARY]`,
    };

    const finalMessages = this.validateMessageStructure([compactedSystemMessage, ...recentMessages]);

    return {
      messages: finalMessages,
      extractedFactCount: savedCount,
    };
  }

  private thinMessages(messages: Message[]): Message[] {
    return messages
      .map((msg) => {
        if (msg.role === "tool" && typeof msg.content === "string" && msg.content.length > 800) {
          return { ...msg, content: `${msg.content.substring(0, 800)}\n... [TRUNCATED]` };
        }
        if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.length > 1200) {
          return { ...msg, content: `${msg.content.substring(0, 1200)}\n... [TRUNCATED]` };
        }
        if (msg.role === "user" && typeof msg.content === "string" && msg.content.length > 1000) {
          return { ...msg, content: `${msg.content.substring(0, 1000)}\n... [TRUNCATED]` };
        }
        return msg;
      })
      .filter((msg, index, arr) => {
        if (index > 0 && msg.role === "tool" && arr[index - 1].role === "tool") {
          return index === arr.length - 1 || arr[index + 1]?.role !== "tool";
        }
        return true;
      });
  }

  /**
   * Ensure tool call and result pairs are not split across the old/recent boundary.
   * If a tool_call_id in recentMessages has no matching tool response, search backwards in oldMessages for it.
   */
  private fixToolCallBoundaries(oldMessages: Message[], recentMessages: Message[]): Message[] {
    const toolResultsInRecent = new Set<string>();
    for (const msg of recentMessages) {
      if (msg.role === "tool" && msg.tool_call_id) {
        toolResultsInRecent.add(msg.tool_call_id);
      }
    }

    let missingToolCalls: Message[] = [];
    for (const msg of oldMessages.slice().reverse()) {
      if (!msg.tool_calls || !Array.isArray(msg.tool_calls)) continue;
      for (const tc of msg.tool_calls) {
        const id = tc.id || tc.tool_call_id;
        if (id && toolResultsInRecent.has(id)) {
          missingToolCalls.push({ ...msg, tool_calls: [tc] });
          toolResultsInRecent.delete(id);
        }
      }
    }

    if (missingToolCalls.length > 0) {
      logger.info(
        { module: 'compactionEngine', pairsRestored: missingToolCalls.length },
        'Restored split tool call/result pairs across compaction boundary'
      );
      recentMessages = [...missingToolCalls.reverse(), ...recentMessages];
    }

    return recentMessages;
  }

  /**
   * Sanitize summary text to prevent prompt injection or control characters.
   */
  private sanitizeSummary(summary: string): string {
    if (!summary) return '';
    // Remove null bytes and other control characters that could cause issues
    const sanitized = summary.replace(/[\x00-\x1F\x7F]/g, '');
    // Limit length to prevent context window bloat
    return sanitized.length > 5000 ? sanitized.substring(0, 5000) + '... [TRUNCATED]' : sanitized;
  }

  /**
   * Validate that the final message array has proper structure:
   * - Must start with a system message (the compaction summary)
   * - Must contain at least one user message
   * - No consecutive duplicate tool calls
   */
  private validateMessageStructure(messages: Message[]): Message[] {
    if (!messages.length) return messages;

    // Ensure first message is system type
    const result = [...messages];
    if (result[0].role !== 'system') {
      logger.warn({ module: 'compactionEngine' }, 'Compaction result missing system message — prepending');
      result.unshift({ role: "system", content: "[Session context has been summarized.]" });
    }

    // Ensure at least one user message exists
    const hasUser = result.some(m => m.role === 'user');
    if (!hasUser) {
      logger.warn({ module: 'compactionEngine' }, 'No user message in compaction result — adding placeholder');
      result.splice(result.length - 1, 0, {
        role: "user",
        content: "[Previous conversation context has been summarized. Continue with the current task.]"
      });
    }

    // Remove consecutive duplicate tool calls (same as thinMessages filter)
    return result.filter((msg, index, arr) => {
      if (index > 0 && msg.role === "tool" && arr[index - 1].role === "tool") {
        return index === arr.length - 1 || arr[index + 1]?.role !== "tool";
      }
      return true;
    });
  }

  private async generateSummaryAndExtract(thinnedHistory: Message[], sessionId?: string): Promise<{ summary: string; extractedFacts: ExtractedFact[] }> {
  const compactLines = thinnedHistory
    .map((m) => {
      if (typeof m.content === "string") {
        if (m.content.length <= 160) return `${m.role}: ${m.content}`;
        const head = m.content.substring(0, 75);
        const tail = m.content.substring(m.content.length - 75);
        return `${m.role}: [${m.content.length} chars] ${head} ... ${tail}`;
      }
      const jsonStr = JSON.stringify(m.content);
      if (jsonStr.length <= 160) return `${m.role}: [${jsonStr.length} chars] ${jsonStr}`;
      return `${m.role}: [${jsonStr.length} chars]`;
    })
    .join("\n");

  const prompt = `You are an elite conversation compressor and fact extractor. Your job is to analyze the following chat history and output a JSON object with two fields: "summary" and "facts".

RULES FOR SUMMARY:
1. Distill the history into a highly dense, bulleted summary.
2. EXTRACT: Key user preferences, architectural decisions, file paths modified, and bugs fixed.
3. OMIT: All pleasantries, conversational fluff, repeated tool calls, and verbose explanations.
4. Max 300 words. Tone: Objective, factual, and dense.

RULES FOR FACTS:
1. Extract any NEW, DURABLE facts that are worth remembering for future sessions.
2. Focus on: user preferences, project architecture decisions, recurring bugs, and workflow patterns.
3. Do NOT extract transient facts (e.g., "the user asked to run echo hello").
4. Categorize each fact into a sector. The "sector" field MUST be EXACTLY one of these five values: "semantic" (facts & domain knowledge), "procedural" (code patterns & workflows), "episodic" (events & specific interactions), "emotional" (preferences, tone, sentiment), "reflective" (lessons learned, meta-cognition). Do NOT invent other sectors; if unsure, use "semantic".

OUTPUT SCHEMA:
Return ONLY a valid JSON object. No markdown, no explanations.
{
  "summary": "The compacted summary text...",
  "facts": [
    {
      "content": "The extracted fact",
      "sector": "procedural"
    }
  ]
}
If no facts are worth saving, return an empty array for "facts".

### CHAT HISTORY ###
${compactLines}`;

  const cappedPrompt = prompt.length > COMPACTION_PROMPT_MAX_CHARS
    ? prompt.substring(0, COMPACTION_PROMPT_MAX_CHARS) + "\n... [PROMPT TRUNCATED]"
    : prompt;

  let rawResponse: string;
  let generation: any;
  let genTrace: any = null;

  try {
    const chatUrl = `${env.generative_url}/chat/completions`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), COMPACTION_TIMEOUT_MS);

    const lf = getLangfuse();
    if (lf) {
      genTrace = sessionId ? lf.trace({ name: "Compaction", sessionId, metadata: { module: "compactionEngine" }, input: cappedPrompt.substring(0, 2000) }) : null;
      if (genTrace) {
        generation = genTrace.generation({
          name: "summarize",
          model: env.generative_model,
          modelParameters: { temperature: 0.1 },
          input: cappedPrompt,
          metadata: { module: "compactionEngine" },
        });
      } else {
        generation = lf.generation({
          name: "Compaction",
          model: env.generative_model,
          modelParameters: { temperature: 0.1 },
          input: cappedPrompt,
          metadata: { module: "compactionEngine" },
        });
      }
    }

    // Validate model name
    if (!env.generative_model || env.generative_model.trim() === '') {
      throw new Error('env.generative_model is not set');
    }

    const requestBody = {
      model: env.generative_model,
      messages: [
        { role: "system", content: "You are a data extraction engine. Return only valid JSON." },
        { role: "user", content: cappedPrompt }  // ✅ REMOVED /no_think suffix
      ],
      stream: false,
      temperature: 0.1,
      max_tokens: 2048,
    };

    logger.debug({ module: 'compactionEngine', model: env.generative_model, promptLength: cappedPrompt.length }, 'Sending compaction request');

    const response = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);

    // ✅ IMPROVED ERROR HANDLING: Log the actual error from the LLM
    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        { 
          module: 'compactionEngine', 
          status: response.status, 
          model: env.generative_model,
          errorBody: errorText.substring(0, 500),
          promptLength: cappedPrompt.length
        }, 
        'Compaction LLM returned error status'
      );
      throw new Error(`Compaction LLM returned status ${response.status}: ${errorText.substring(0, 200)}`);
    }

    const data = await response.json();
    rawResponse = ((data.choices?.[0]?.message?.content || "") as string).replace(/^```json\s*|\s*```$/g, "").trim();

    generation?.end({
      output: rawResponse,
      usage: {
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
      },
    });

    if (!rawResponse) {
      logger.warn({ module: 'compactionEngine' }, 'Compaction LLM returned empty response');
      return { summary: "", extractedFacts: [] };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawResponse);
    } catch (parseErr: any) {
      // LLM returned non-JSON text — try to extract a JSON object from it
      const jsonMatch = rawResponse.match(/\{[\s\S]*"summary"[\s\S]*\}/);
      if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[0]); } catch {}
      }
    }

    // Final fallback: if parsing still failed, create a safe minimal summary from raw text
    if (!parsed || typeof parsed !== 'object' || !rawResponse.trim().length) {
      logger.warn({ module: 'compactionEngine', responseLength: rawResponse.length }, 'Compaction LLM returned invalid JSON — using fallback');
      const truncated = rawResponse.substring(0, 1500);
      return { summary: `[COMPACTED] ${truncated}`, extractedFacts: [] };
    }

    return {
      summary: parsed.summary || "",
      extractedFacts: Array.isArray(parsed.facts) ? parsed.facts : [],
    };
  } catch (error: any) {
    generation?.end({ error: error.message || String(error) });
    logger.error({ module: 'compactionEngine', err: error }, 'Compaction LLM call failed');
    return { summary: "", extractedFacts: [] };
  }
}

  private async saveExtractedFacts(facts: ExtractedFact[], projectId?: string): Promise<number> {
    const db = kit_make_db(run_async, all_async);
    let savedCount = 0;

    await db.query("BEGIN");
    try {
      for (const fact of facts) {
        if (!fact.content || fact.content.trim().length < 10) continue;
        try {
          const sector = normalizeSector(fact.sector, "semantic");
          await rememberDurableMemory(db, {
            content: fact.content,
            user_id: "system",
            project_id: projectId,
            metadata: {
              sector,
              decay_rate: DEFAULT_PHENOTYPE_DECAY_RATE,
              source: "compaction_engine"
            },
          });
          savedCount++;
        } catch (err) {
          logger.warn({ module: 'compactionEngine', content: fact.content }, 'Failed to save compaction fact — rolling back');
          await db.query("ROLLBACK");
          return savedCount;
        }
      }
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      logger.error({ module: 'compactionEngine', err }, 'Transaction failed in saveExtractedFacts');
      return 0;
    }

    return savedCount;
  }
}

export const compactionEngine = new CompactionEngine();