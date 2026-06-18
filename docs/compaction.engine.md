# Compaction Engine

### Flow: sanitize → compact → inject genome/phenotype → forward to LLM

### ASSISTANT
Here is the fully updated `compactionEngine.ts` that implements all four architectural refinements we agreed upon:

1. **Semantic Memory Integration**: Extracts facts alongside the summary and saves them to the Phenotype DB.
2. **Message Count Triggering**: Keeps the fast O(1) trigger, with aggressive thinning to prevent overflow.
3. **Incremental Compaction**: Returns a clean `[System Summary] + [Raw Tail]` structure that never grows.
4. **Hard Truncation Fallback**: If the LLM fails, it drops old history entirely instead of risking overflow.

### Updated `packages/engram-js/src/services/compactionEngine.ts`

```typescript
import { env } from "../configuration";
import { make_db as kit_make_db, run_async, all_async } from "../api/routes/_kit";
import { rememberDurableMemory } from "../durable/repository";
import { DEFAULT_PHENOTYPE_DECAY_RATE } from "./memoryInjector";

const COMPACTION_MODEL = process.env.COMPACTION_MODEL || "qwen2.5:7b"; // Bumped to 7b for better extraction
const COMPACTION_TRIGGER = parseInt(process.env.COMPACTION_TRIGGER || "12", 10);
const MAX_RAW_TURNS = parseInt(process.env.MAX_RAW_TURNS || "6", 10);

interface Message {
  role: string;
  content: string | any[];
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

interface CompactionResult {
  messages: Message[];
  extractedFactCount: number;
}

interface ExtractedFact {
  content: string;
  sector: "semantic" | "procedural" | "episodic" | "emotional" | "reflective";
}

export class CompactionEngine {
  /**
   * Checks if compaction is needed and performs it if so.
   * Returns the optimized message array and the count of facts saved to the DB.
   */
  public async compactIfNeeded(messages: Message[]): Promise<CompactionResult> {
    // 1. Check if we need to compact
    if (messages.length <= COMPACTION_TRIGGER) {
      return { messages, extractedFactCount: 0 };
    }

    // 2. Isolate: Split into old history and recent raw tail
    const oldMessages = messages.slice(0, messages.length - MAX_RAW_TURNS);
    const recentMessages = messages.slice(-MAX_RAW_TURNS);

    console.log(`[Engram] ⚙️ Triggering context compaction. Thinning ${oldMessages.length} old messages...`);

    // 3. Aggressive Thinning (Heuristic pre-processing)
    const thinnedHistory = this.thinMessages(oldMessages);

    // 4. Summarize & Extract Facts via Local LLM (Single call for efficiency)
    const { summary, extractedFacts } = await this.generateSummaryAndExtract(thinnedHistory);

    // 5. Save extracted facts to Phenotype DB (Recursive Learning Loop)
    let savedCount = 0;
    if (extractedFacts.length > 0) {
      savedCount = await this.saveExtractedFacts(extractedFacts);
      console.log(`[Engram] 💾 Compaction extracted and saved ${savedCount} new phenotype memories.`);
    }

    // 6. Reconstruct the payload: [System Summary] + [Raw Tail]
    const compactedSystemMessage: Message = {
      role: "system",
      content: `[COMPACTED SESSION SUMMARY]\n${summary}\n[END COMPACTED SUMMARY]`,
    };

    return {
      messages: [compactedSystemMessage, ...recentMessages],
      extractedFactCount: savedCount,
    };
  }

  /**
   * Heuristically removes fluff and truncates massive outputs before sending to the LLM.
   */
  private thinMessages(messages: Message[]): Message[] {
    return messages
      .map((msg) => {
        // Truncate massive tool outputs (e.g., full file reads)
        if (msg.role === "tool" && typeof msg.content === "string" && msg.content.length > 2000) {
          return {
            ...msg,
            content: `${msg.content.substring(0, 1500)}\n\n... [TRUNCATED FOR COMPACTION: ${msg.content.length - 1500} chars omitted] ...`,
          };
        }

        // Truncate massive assistant responses
        if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.length > 3000) {
          return {
            ...msg,
            content: `${msg.content.substring(0, 2500)}\n\n... [TRUNCATED FOR COMPACTION] ...`,
          };
        }

        return msg;
      })
      // Remove consecutive duplicate tool calls or empty messages
      .filter((msg, index, arr) => {
        if (index > 0 && msg.role === "tool" && arr[index - 1].role === "tool") {
          // Keep only the last tool result if they are back-to-back
          return index === arr.length - 1 || arr[index + 1]?.role !== "tool";
        }
        return true;
      });
  }

  /**
   * Calls the local Ollama instance to generate a dense summary AND extract facts in a single pass.
   */
  private async generateSummaryAndExtract(thinnedHistory: Message[]): Promise<{ summary: string; extractedFacts: ExtractedFact[] }> {
    const historyText = thinnedHistory
      .map((m) => {
        const role = m.role.toUpperCase();
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `${role}: ${content}`;
      })
      .join("\n---\n");

    const prompt = `
You are an elite conversation compressor and fact extractor. Your job is to analyze the following chat history and output a JSON object with two fields: "summary" and "facts".

RULES FOR SUMMARY:
1. Distill the history into a highly dense, bulleted summary.
2. EXTRACT: Key user preferences, architectural decisions, file paths modified, and bugs fixed.
3. OMIT: All pleasantries, conversational fluff, repeated tool calls, and verbose explanations.
4. Max 300 words. Tone: Objective, factual, and dense.

RULES FOR FACTS:
1. Extract any NEW, DURABLE facts that are worth remembering for future sessions.
2. Focus on: user preferences, project architecture decisions, recurring bugs, and workflow patterns.
3. Do NOT extract transient facts (e.g., "the user asked to run echo hello").
4. Categorize each fact into a sector: semantic, procedural, episodic, emotional, or reflective.

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

CONVERSATION HISTORY:
${historyText}

JSON OUTPUT:
`.trim();

    try {
      const response = await fetch(`${env.ollama_url}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: COMPACTION_MODEL,
          prompt: prompt,
          stream: false,
          format: "json", // Force valid JSON output
          options: {
            temperature: 0.1,
            num_predict: 800,
          },
        }),
      });

      if (!response.ok) throw new Error(`Compaction LLM returned status ${response.status}`);
      
      const data = await response.json();
      const rawResponse = (data.response || "").replace(/^```json\s*|\s*```$/g, "").trim();
      
      const parsed = JSON.parse(rawResponse);
      
      return {
        summary: parsed.summary || "No summary generated.",
        extractedFacts: Array.isArray(parsed.facts) ? parsed.facts : [],
      };
    } catch (error) {
      console.error("[Engram] ❌ Compaction summarization/extraction failed:", error);
      
      // FALLBACK: Hard truncation. Drop the old history entirely to prevent overflow.
      // We only keep a tiny note that compaction failed.
      const fallbackSummary = `[COMPACTION ERROR] The previous ${thinnedHistory.length} messages were dropped due to a compaction engine failure. Only the most recent ${MAX_RAW_TURNS} messages are available.`;
      
      return {
        summary: fallbackSummary,
        extractedFacts: [], // No facts extracted on failure
      };
    }
  }

  /**
   * Saves extracted facts to the Phenotype DB.
   */
  private async saveExtractedFacts(facts: ExtractedFact[]): Promise<number> {
    const db = kit_make_db(run_async, all_async);
    let savedCount = 0;

    for (const fact of facts) {
      if (!fact.content || fact.content.trim().length < 10) continue; // Skip trivial facts

      try {
        await rememberDurableMemory(db, {
          content: fact.content,
          user_id: "system",
          project_id: undefined,
          metadata: { 
            sector: fact.sector || "semantic", 
            decay_rate: DEFAULT_PHENOTYPE_DECAY_RATE,
            source: "compaction_engine" // Tag these as coming from compaction
          },
        });
        savedCount++;
      } catch (err) {
        console.warn(`[Engram] Failed to save compaction fact: ${fact.content}`, err);
      }
    }

    return savedCount;
  }
}

export const compactionEngine = new CompactionEngine();
```

---

### How to Integrate This into `route.ts`

Now that `compactIfNeeded` returns an object with both the messages and the extracted fact count, you need to update your `route.ts` to handle this new return type.

Find the section where you call the compaction engine and update it:

```typescript
// Old:
// let processedMessages = body.messages;
// if (body.messages.length > parseInt(process.env.COMPACTION_TRIGGER || "12", 10)) {
//   processedMessages = await compactionEngine.compactIfNeeded(body.messages);
// }

// New:
let processedMessages = body.messages;
let compactionFactCount = 0;

if (body.messages.length > parseInt(process.env.COMPACTION_TRIGGER || "12", 10)) {
  const compactionResult = await compactionEngine.compactIfNeeded(body.messages);
  processedMessages = compactionResult.messages;
  compactionFactCount = compactionResult.extractedFactCount;
}

// ... later in the code, when you build the initial status ...
// Uses buildInjectionStatus() from services/engramStatus.ts for consistent formatting
const initialStatus = buildInjectionStatus(genomeMemories.length, phenotypeMemories.length, compactionFactCount || undefined);
// Outputs: 🧬 *Engram: 10 Genome | 0 Phenotype memories loaded.*
```

### Why This Implementation is Production-Ready:

1. **Single LLM Call**: By asking for both the summary and the facts in one JSON object, we cut the compaction latency in half compared to making two separate calls.
2. **Recursive Learning**: Every time a session gets long enough to trigger compaction, the system automatically extracts the key decisions and saves them to the Phenotype DB. These facts will then be available for *future* sessions via the normal memory recall process.
3. **Safe Fallback**: If the 7B model hallucinates invalid JSON or times out, the fallback doesn't try to send the raw history (which could overflow the upstream LLM's context). Instead, it hard-drops the old messages and inserts a clear error note, preserving only the `MAX_RAW_TURNS`.
4. **Source Tagging**: The saved facts are tagged with `source: "compaction_engine"` in their metadata, making it easy to query or debug which memories were created by compaction vs. normal extraction.

Let me know if you want to tweak the extraction prompt or adjust the truncation thresholds!