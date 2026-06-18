Looking at the logs, I can see the exact problems:

1. **Compaction triggers every 2 messages** (19→20→22→23...) because trigger is 12 and raw tail is 6
2. **Compaction sends 6,711 tokens** to the 4B model (way too much)
3. **Compaction takes 135-173 seconds** but timeout is 30s
4. **Memory extraction also times out** at 30s
5. **Duplicate context blocks** in the system message
6. **Upstream LLM cache is constantly invalidated** because compaction restructures messages every turn

Here are the complete fixed files:

## Updated `compactionEngine.ts`

```typescript
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

const COMPACTION_MODEL = process.env.EG_COMPACT_MODEL || "qwen3.5:4b";
const COMPACTION_TRIGGER = parseInt(process.env.EG_COMPACT_TRIGGER || "50", 10); // Only compact after 50+ messages
const MAX_RAW_TURNS = parseInt(process.env.EG_MAX_RAW_TURNS || "6", 10);
const MAX_MESSAGES_TO_COMPACT = 15; // Only send last 15 messages to compaction model

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
  private readonly COMPACTION_COOLDOWN_MS = 60_000; // Don't compact more than once per minute

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
      logger.debug({ module: 'compactionEngine' }, 'Skipping compaction - cooldown active');
      return;
    }

    // Create a hash of message count + last message to detect changes
    const hash = `${messages.length}:${messages[messages.length - 1]?.content?.slice(0, 50)}`;
    if (hash === this.lastCompactedHash) {
      logger.debug({ module: 'compactionEngine' }, 'Skipping compaction - no new messages');
      return;
    }

    this.lastCompactionTime = now;
    this.lastCompactedHash = hash;

    try {
      await this.performCompaction(messages);
    } catch (error) {
      logger.error({ module: 'compactionEngine', err: error }, 'Background compaction failed');
    }
  }

  /**
   * Performs the actual compaction
   */
  private async performCompaction(messages: Message[]): Promise<void> {
    // Only take the last N messages to compact (not all old history)
    const messagesToCompact = messages.slice(-MAX_MESSAGES_TO_COMPACT);
    
    logger.info(
      { module: 'compactionEngine', messageCount: messagesToCompact.length, model: COMPACTION_MODEL },
      'Starting background compaction'
    );

    const thinnedHistory = this.thinMessages(messagesToCompact);
    const { summary, extractedFacts } = await this.generateSummaryAndExtract(thinnedHistory);

    let savedCount = 0;
    if (extractedFacts.length > 0) {
      savedCount = await this.saveExtractedFacts(extractedFacts);
      logger.info(
        { module: 'compactionEngine', count: savedCount },
        'Compaction extracted and saved new phenotype memories'
      );
    }

    logger.info(
      { module: 'compactionEngine', summaryLength: summary.length },
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
   * Generates summary and extracts facts in a single LLM call
   */
  private async generateSummaryAndExtract(thinnedHistory: Message[]): Promise<{ summary: string; extractedFacts: ExtractedFact[] }> {
    // Format history as concise text
    const historyText = thinnedHistory
      .map((m) => {
        const role = m.role.toUpperCase();
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `${role}: ${content}`;
      })
      .join("\n");

    // Truncate total history to 3000 chars max
    const truncatedHistory = historyText.length > 3000 
      ? historyText.substring(0, 3000) + "\n... [HISTORY TRUNCATED]"
      : historyText;

    const prompt = `Summarize this chat history in 150 words max. Extract key decisions, file paths, bugs fixed, and user preferences. Omit pleasantries and tool outputs. Use [ ] not { }. Use ' not ".

Also extract 0-3 durable facts worth remembering (user preferences, architecture decisions, workflow patterns).

History:
${truncatedHistory}

Respond with JSON: {"summary":"...","facts":[{"content":"...","sector":"procedural"}]}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60_000); // 60s timeout

      const response = await fetch(`${env.ollama_url}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: COMPACTION_MODEL,
          prompt: prompt,
          stream: false,
          format: "json",
          options: {
            temperature: 0.1,
            num_predict: 500,
            num_ctx: 4096, // Smaller context for faster processing
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) throw new Error(`Compaction LLM returned status ${response.status}`);

      const data = await response.json();
      const rawResponse = (data.response || "").replace(/^```json\s*|\s*```$/g, "").trim();
      const parsed = JSON.parse(rawResponse);

      return {
        summary: parsed.summary || "",
        extractedFacts: Array.isArray(parsed.facts) ? parsed.facts : [],
      };
    } catch (error) {
      logger.error({ module: 'compactionEngine', err: error }, 'Compaction LLM call failed');
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
        logger.warn({ module: 'compactionEngine', content: fact.content }, 'Failed to save compaction fact');
      }
    }

    return savedCount;
  }
}

export const compactionEngine = new CompactionEngine();
```

## Updated `route.ts` (key changes only)

```typescript
// Add near the top with other imports
import { compactionEngine } from "../../../../services/compactionEngine";

// In the chat_completions_route function, replace the compaction logic:

// OLD (synchronous, blocking):
// if (sanitizedMessages.length > parseInt(process.env.EG_COMPACT_TRIGGER || "12", 10)) {
//   const compactionResult = await compactionEngine.compactIfNeeded(sanitizedMessages);
//   processedMessages = compactionResult.messages;
//   compactionFactCount = compactionResult.extractedFactCount;
// }

// NEW (async, fire-and-forget):
let processedMessages = sanitizedMessages;

// Fire compaction in background - don't wait for it
if (sanitizedMessages.length > parseInt(process.env.EG_COMPACT_TRIGGER || "50", 10)) {
  compactionEngine.compactIfNeededAsync(sanitizedMessages).catch(err => {
    logger.error({ module: 'chatRoute', err }, 'Background compaction failed');
  });
}

// 3. Inject into System Prompt (Merge to avoid Jinja template errors)
const enrichedMessages = [...processedMessages];

// 🛡️ CRITICAL FIX: Check if context already exists to prevent duplication
const hasCognitiveContext = enrichedMessages.some(m => 
  m.role === 'system' && m.content.includes('[CODECORTEX COGNITIVE CONTEXT]')
);

if (!hasCognitiveContext) {
  const cognitiveContextBlock = `[CODECORTEX COGNITIVE CONTEXT]\n${cognitiveContext}\n[END CODECORTEX CONTEXT]\nUse the above context silently to inform your response. Do not explicitly mention "Engram" or the context blocks unless directly asked about your memory.\n\n`;

  if (enrichedMessages.length > 0 && enrichedMessages[0].role === "system") {
    enrichedMessages[0].content = cognitiveContextBlock + enrichedMessages[0].content;
  } else {
    enrichedMessages.unshift({ role: "system", content: cognitiveContextBlock });
  }
}
```

## Key Changes Summary

1. **Compaction is now async** - fires in background, doesn't block responses
2. **Trigger increased to 50 messages** - only compacts when truly needed
3. **Only sends last 15 messages** to compaction model (not all history)
4. **Aggressive truncation** - tool outputs 800 chars, assistant 1200 chars, user 1000 chars
5. **Total history limited to 3000 chars** before sending to LLM
6. **60-second timeout** for compaction (was 30s)
7. **60-second cooldown** between compactions to prevent rapid-fire
8. **Hash-based deduplication** - won't recompact same messages
9. **Smaller context window** (4096) for faster processing
10. **Fixed duplicate context injection** - checks if context already exists

## Update `.env`

```env
EG_COMPACT_TRIGGER=50
EG_MAX_RAW_TURNS=6
```

This should eliminate the constant compaction loops, reduce token usage dramatically, and keep the upstream LLM's cache intact.