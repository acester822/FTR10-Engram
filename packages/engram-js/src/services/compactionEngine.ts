/*
 - filename: packages/engram-js/src/services/compactionEngine.ts
 - what is the file used for: Async context compaction that runs in background, summarizes only the most recent 15 messages, and saves extracted facts to Phenotype DB
 */

import { env } from "../configuration";
import { make_db as kit_make_db, run_async, all_async } from "../api/routes/_kit";
import { rememberDurableMemory } from "../durable/repository";
import { DEFAULT_PHENOTYPE_DECAY_RATE } from "./memoryInjector";
import { logger } from "../utils/logger";

// ── Configuration ─────────────────────────────────────────────────────

const COMPACTION_MODEL = env.generative_model;
const COMPACTION_TRIGGER     = parseInt(String(process.env.EG_COMPACT_TRIGGER), 10) || 50;
const MAX_RAW_TURNS          = parseInt(String(process.env.EG_MAX_RAW_TURNS), 10) || 6;
const MAX_MESSAGES_TO_COMPACT = parseInt(String(process.env.EG_COMPACT_MAX_MESSAGES), 10) || 8;
const COMPACTION_PROMPT_MAX_CHARS = parseInt(String(process.env.EG_COMPACT_PROMPT_MAX_CHARS), 10) || 1200;
const COMPACTION_TIMEOUT_MS  = (parseInt(String(process.env.EG_COMPACT_TIMEOUT_SEC), 10) || 60) * 1000;

// ── Types ─────────────────────────────────────────────────────────────

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

// ── Compaction Engine ─────────────────────────────────────────────────

export class CompactionEngine {
  private lastCompactedHash: string | null = null;
  private lastCompactionTime: number = 0;
  private readonly COMPACTION_COOLDOWN_MS = parseInt(String(process.env.EG_COMPACTION_COOLDOWN_MS), 10) || 60_000; // Don't compact more than once per minute

  /**
   * Async compaction - runs in background, doesn't block the response
   */
  public async compactIfNeededAsync(messages: Message[]): Promise<void> {
    // Check if we should even try to compact
    if (messages.length <= COMPACTION_TRIGGER) {
      return;
    }

    // Check cooldown to prevent rapid-fire compaction
    const now = Date.now();
    if (now - this.lastCompactionTime < this.COMPACTION_COOLDOWN_MS) {
      logger.debug({ module: 'compactionEngine', model: COMPACTION_MODEL }, 'Skipping compaction - cooldown active');
      return;
    }

    // Create a hash of message count + last message to detect changes
    const hash = `${messages.length}:${messages[messages.length - 1]?.content?.slice(0, 50)}`;
    if (hash === this.lastCompactedHash) {
      logger.debug({ module: 'compactionEngine', model: COMPACTION_MODEL }, 'Skipping compaction - no new messages');
      return;
    }

    this.lastCompactionTime = now;
    this.lastCompactedHash = hash;

    try {
      await this.performCompaction(messages);
    } catch (error) {
      logger.error({ module: 'compactionEngine', model: COMPACTION_MODEL, err: error }, 'Background compaction failed');
    }
  }

  /**
   * Performs the actual compaction
   */
  private async performCompaction(messages: Message[]): Promise<void> {
    // Only take the last N messages to compact (not all old history)
    const messagesToCompact = messages.slice(-MAX_MESSAGES_TO_COMPACT);
    
    logger.info(
      { module: 'compactionEngine', messageCount: messagesToCompact.length, model: COMPACTION_MODEL, ollamaUrl: env.ollama_url },
      'Starting background compaction'
    );

    const thinnedHistory = this.thinMessages(messagesToCompact);
    logger.info(
      { module: 'compactionEngine', model: COMPACTION_MODEL, messageCount: thinnedHistory.length },
      'Sending to compaction LLM'
    );

    const { summary, extractedFacts } = await this.generateSummaryAndExtract(thinnedHistory);

    let savedCount = 0;
    if (extractedFacts.length > 0) {
      savedCount = await this.saveExtractedFacts(extractedFacts);
      logger.info(
        { module: 'compactionEngine', model: COMPACTION_MODEL, count: savedCount },
        'Compaction extracted and saved new phenotype memories'
      );
    }

    logger.info(
      { module: 'compactionEngine', model: COMPACTION_MODEL, summaryLength: summary.length },
      'Background compaction complete'
    );
  }

  /**
   * Aggressively thins messages to reduce token count
   */
  private thinMessages(messages: Message[]): Message[] {
    return messages
      .map((msg) => {
        // Truncate tool outputs to 800 chars max
        if (msg.role === "tool" && typeof msg.content === "string" && msg.content.length > 800) {
          return {
            ...msg,
            content: `${msg.content.substring(0, 800)}\n... [TRUNCATED]`,
          };
        }

        // Truncate assistant responses to 1200 chars max
        if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.length > 1200) {
          return {
            ...msg,
            content: `${msg.content.substring(0, 1200)}\n... [TRUNCATED]`,
          };
        }

        // Truncate user messages to 1000 chars max
        if (msg.role === "user" && typeof msg.content === "string" && msg.content.length > 1000) {
          return {
            ...msg,
            content: `${msg.content.substring(0, 1000)}\n... [TRUNCATED]`,
          };
        }

        return msg;
      })
      // Remove consecutive duplicate tool calls
      .filter((msg, index, arr) => {
        if (index > 0 && msg.role === "tool" && arr[index - 1].role === "tool") {
          return index === arr.length - 1 || arr[index + 1]?.role !== "tool";
        }
        return true;
      });
  }

    /**
   * Generates summary and extracts facts in a single LLM call.
   * Uses /api/generate for lower overhead and explicit CPU option control.
   */
  private async generateSummaryAndExtract(thinnedHistory: Message[]): Promise<{ summary: string; extractedFacts: ExtractedFact[] }> {
    // Build a very compact history — only role + first/last 80 chars of content
    const compactLines = thinnedHistory
      .slice(-MAX_MESSAGES_TO_COMPACT)
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

    const prompt = `Summarize the last few messages in 80 words max. Extract key decisions, file paths, bugs fixed, and user preferences.\n\n${compactLines}\n\nRespond with JSON: {"summary":"...","facts":[{"content":"...","sector":"procedural"}]}`;

    // Hard cap on prompt size
    const cappedPrompt = prompt.length > COMPACTION_PROMPT_MAX_CHARS 
      ? prompt.substring(0, COMPACTION_PROMPT_MAX_CHARS) + "\n... [PROMPT TRUNCATED]"
      : prompt;

    const generateUrl = `${env.ollama_url}/api/generate`;
    logger.info(
      { module: 'compactionEngine', model: COMPACTION_MODEL, url: generateUrl, promptChars: cappedPrompt.length },
      'Sending compaction request'
    );

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), COMPACTION_TIMEOUT_MS);

      // FIX: Switched to /api/generate for direct options control and lower overhead
      const response = await fetch(generateUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: COMPACTION_MODEL,
          prompt: `${cappedPrompt}\n\n/no_think`, 
          stream: false,
          think: false, 
          // FIX: Removed response_format: { type: "json_object" } to save CPU grammar overhead.
          options: {
            temperature: 0.1,
            num_predict: 256, // Keep output generation short
            num_ctx: 2048,    // CRITICAL FIX: Prevents Ollama from allocating an 8k KV cache in RAM
            num_batch: 512    // Speeds up prompt processing on multi-core CPUs
          }
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          { module: 'compactionEngine', status: response.status, model: COMPACTION_MODEL, url: generateUrl, error: errorText.substring(0, 500) },
          'Compaction LLM returned non-OK status'
        );
        throw new Error(`Compaction LLM returned status ${response.status}`);
      }

      const data = await response.json();
      
      // FIX: Parse using /api/generate response structure (data.response)
      const rawResponse = (data.response || "").replace(/^```json\s*|\s*```$/g, "").trim();

      if (!rawResponse) {
        logger.error(
          { module: 'compactionEngine', model: COMPACTION_MODEL, url: generateUrl, rawLength: (data.response || '').length },
          'Compaction LLM returned empty response'
        );
        return { summary: "", extractedFacts: [] };
      }

      let parsed;
      try {
        parsed = JSON.parse(rawResponse);
      } catch (parseErr) {
        logger.error(
          { module: 'compactionEngine', model: COMPACTION_MODEL, url: generateUrl, rawResponse: rawResponse.substring(0, 500) },
          'Compaction LLM returned invalid JSON'
        );
        return { summary: "", extractedFacts: [] };
      }

      logger.info(
        { module: 'compactionEngine', model: COMPACTION_MODEL, summaryLength: (parsed.summary || '').length, factCount: Array.isArray(parsed.facts) ? parsed.facts.length : 0 },
        'Compaction LLM response received'
      );

      return {
        summary: parsed.summary || "",
        extractedFacts: Array.isArray(parsed.facts) ? parsed.facts : [],
      };
    } catch (error) {
      logger.error({ module: 'compactionEngine', err: error, model: COMPACTION_MODEL, url: generateUrl }, 'Compaction LLM call failed');
      return { summary: "", extractedFacts: [] };
    }
  }

  /**
   * Saves extracted facts to Phenotype DB
   */
  private async saveExtractedFacts(facts: ExtractedFact[]): Promise<number> {
    const db = kit_make_db(run_async, all_async);
    let savedCount = 0;

    for (const fact of facts) {
      if (!fact.content || fact.content.trim().length < 10) continue;

      try {
        await rememberDurableMemory(db, {
          content: fact.content,
          user_id: "system",
          project_id: undefined,
          metadata: {
            sector: fact.sector || "semantic",
            decay_rate: DEFAULT_PHENOTYPE_DECAY_RATE,
            source: "compaction_engine"
          },
        });
        savedCount++;
      } catch (err) {
        logger.warn({ module: 'compactionEngine', model: COMPACTION_MODEL, content: fact.content }, 'Failed to save compaction fact');
      }
    }

    return savedCount;
  }
}

export const compactionEngine = new CompactionEngine();
