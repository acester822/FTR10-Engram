import { env } from "../configuration";
import { make_db as kit_make_db, run_async, all_async } from "../api/routes/_kit";
import { rememberDurableMemory } from "../durable/repository";
import { DEFAULT_PHENOTYPE_DECAY_RATE } from "./memoryInjector";
import { logger } from "../utils/logger";
import { getLangfuse } from "./langfuseClient";

const COMPACTION_TRIGGER     = parseInt(String(process.env.EG_COMPACT_TRIGGER), 10) || 25;
const MAX_RAW_TURNS          = parseInt(String(process.env.EG_MAX_RAW_TURNS), 10) || 8;
const COMPACTION_PROMPT_MAX_CHARS = parseInt(String(process.env.EG_COMPACT_PROMPT_MAX_CHARS), 10) || 800;
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

  public async compactIfNeeded(messages: Message[]): Promise<CompactionResult> {
    if (messages.length <= COMPACTION_TRIGGER) {
      return { messages, extractedFactCount: 0 };
    }

    const now = Date.now();
    const hash = `${messages.length}:${messages[messages.length - 1]?.content?.slice(0, 50)}`;
    if (hash === this.lastCompactedHash && now - this.lastCompactionTime < this.COMPACTION_COOLDOWN_MS) {
      logger.debug({ module: 'compactionEngine' }, 'Skipping compaction — cooldown + hash match');
      return { messages, extractedFactCount: 0 };
    }

    this.lastCompactedHash = hash;
    this.lastCompactionTime = now;

    try {
      return await this.performCompaction(messages);
    } catch (error) {
      logger.error({ module: 'compactionEngine', err: error }, 'Compaction failed — dropping old history');
      const recentMessages = messages.slice(-MAX_RAW_TURNS);
      return { messages: recentMessages, extractedFactCount: 0 };
    }
  }

  private async performCompaction(messages: Message[]): Promise<CompactionResult> {
    const oldMessages = messages.slice(0, messages.length - MAX_RAW_TURNS);
    const recentMessages = messages.slice(-MAX_RAW_TURNS);

    logger.info(
      { module: 'compactionEngine', oldCount: oldMessages.length, recentCount: recentMessages.length, model: env.generative_model },
      'Compacting session history'
    );

    const thinnedHistory = this.thinMessages(oldMessages);
    const { summary, extractedFacts } = await this.generateSummaryAndExtract(thinnedHistory);

    let savedCount = 0;
    if (extractedFacts.length > 0) {
      savedCount = await this.saveExtractedFacts(extractedFacts);
      logger.info(
        { module: 'compactionEngine', count: savedCount },
        'Compaction saved facts'
      );
    }

    if (!summary || summary.length < 10) {
      logger.warn({ module: 'compactionEngine' }, 'Compaction summary too short — dropping old history silently');
      return { messages: recentMessages, extractedFactCount: savedCount };
    }

    const compactedSystemMessage: Message = {
      role: "system",
      content: `[COMPACTED SESSION SUMMARY]\n${summary}\n[END COMPACTED SUMMARY]`,
    };

    logger.info(
      { module: 'compactionEngine', summaryLength: summary.length, resultCount: 1 + recentMessages.length },
      'Compaction complete'
    );

    return {
      messages: [compactedSystemMessage, ...recentMessages],
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

  private async generateSummaryAndExtract(thinnedHistory: Message[]): Promise<{ summary: string; extractedFacts: ExtractedFact[] }> {
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

    const prompt = `Summarize preceding messages in 60 words max. Extract key decisions, file paths, bugs, preferences.\n\n${compactLines}\n\nRespond JSON: {"summary":"...","facts":[{"content":"...","sector":"procedural"}]}`;

    const cappedPrompt = prompt.length > COMPACTION_PROMPT_MAX_CHARS
      ? prompt.substring(0, COMPACTION_PROMPT_MAX_CHARS) + "\n... [PROMPT TRUNCATED]"
      : prompt;

    let rawResponse: string;
    let generation: any;

    try {
      const chatUrl = `${env.generative_url}/chat/completions`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), COMPACTION_TIMEOUT_MS);

      const lf = getLangfuse();
      generation = lf?.generation({
        name: "compaction-summarize",
        model: env.generative_model,
        modelParameters: { temperature: 0.1 },
        input: cappedPrompt,
        metadata: { module: "compactionEngine" },
      });

      const response = await fetch(chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: env.generative_model,
          messages: [
            { role: "system", content: "You are a data extraction engine. Return only valid JSON." },
            { role: "user", content: `${cappedPrompt}\n\n/no_think` }
          ],
          stream: false,
          temperature: 0.1,
          max_tokens: 128,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) throw new Error(`Compaction LLM returned status ${response.status}`);
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
        return { summary: "", extractedFacts: [] };
      }

      let parsed = JSON.parse(rawResponse);
      return {
        summary: parsed.summary || "",
        extractedFacts: Array.isArray(parsed.facts) ? parsed.facts : [],
      };
    } catch (error: any) {
      generation?.end({ error });
      logger.error({ module: 'compactionEngine', err: error }, 'Compaction LLM call failed');
      return { summary: "", extractedFacts: [] };
    }
  }

  private async saveExtractedFacts(facts: ExtractedFact[]): Promise<number> {
    const db = kit_make_db(run_async, all_async);
    let savedCount = 0;

    await db.query("BEGIN");
    try {
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