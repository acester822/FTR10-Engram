/*
 - filename: packages/engram-js/src/api/routes/chat/completions/route.ts
 - what is the file used for: POST /v1/chat/completions — OpenAI-compatible smart proxy endpoint that intercepts requests, builds cognitive context via MemoryInjector (genome + phenotype), injects into system prompt, forwards to LLM, streams SSE back, and logs interactions for memory extraction.
*/

import { env } from "../../../../configuration";
import { consolidationEngine } from "../../../../services/consolidationEngine";
import { compactionEngine } from "../../../../services/compactionEngine";
import { classifyMemory, DEFAULT_GENOME_DECAY_RATE, DEFAULT_PHENOTYPE_DECAY_RATE, computeDecaySalience, MemoryInjector } from "../../../../services/memoryInjector";
import { buildInjectionStatus, buildExtractionStatus, stripEngramStatus, isEngramStatus } from "../../../../services/engramStatus";
import { genomeCache } from "../../../../services/genomeCache";
import { logger } from "../../../../utils/logger";
import { retryFetch } from "../../../../utils/retry";
import { recallDurableMemories, rememberDurableMemory } from "../../../../durable/repository";
import { make_db as kit_make_db, run_async, all_async } from "../../_kit";
import { logInteractionAsync } from "../../../../services/memoryLogger";

// ── Types ─────────────────────────────────────────────────────────────

interface ChatCompletionRequest {
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  user_id?: string;
  project_id?: string;
}

interface GenomeMemory {
  id: string;
  content: string;
}

interface PhenotypeMemory {
  id: string;
  content: string;
  sector: string;
  score: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Sanitize memory content to prevent prompt injection via delimiter break-out.
 * Strips any occurrences of the ENGRAM delimiter markers from recall content.
 */
function sanitizeMemoryContent(content: string): string {
  return content.replace(/\[END?\s*ENGRAM[^\]]*\]/gi, '[ENGRAM CONTENT — REDACTED]');
}

/** Build cognitive context from genome + phenotype memories */
function buildCognitiveContext(genome: GenomeMemory[], phenotype: PhenotypeMemory[]): string {
  let ctx = "[ENGRAM COGNITIVE CONTEXT]\n";

  if (genome.length > 0) {
    ctx += "--- CORE DIRECTIVES (GENOME) ---\n";
    for (const m of genome) {
      ctx += `- ${sanitizeMemoryContent(m.content)}\n`;
    }
    ctx += "\n";
  }

  if (phenotype.length > 0) {
    ctx += "--- RECALLED CONTEXT (PHENOTYPE) ---\n";
    const grouped: Record<string, string[]> = {};
    for (const m of phenotype) {
      if (!grouped[m.sector]) grouped[m.sector] = [];
      grouped[m.sector].push(sanitizeMemoryContent(m.content));
    }
    for (const [sector, contents] of Object.entries(grouped)) {
      ctx += `[${sector.toUpperCase()}]\n`;
      for (const c of contents) {
        ctx += `- ${c}\n`;
      }
      ctx += "\n";
    }
  }

  ctx += "[END ENGRAM CONTEXT]\n";
  ctx += "Use the above context silently to inform your response. Do not explicitly mention \"Engram\" or the context blocks unless directly asked about your memory.\n";
  return ctx;
}

/** Extract clean text from accumulated SSE chunks */
function extractTextFromSSE(sseString: string): string {
  let text = "";
  const lines = sseString.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const dataStr = line.slice(6).trim();
    if (dataStr === "[DONE]" || !dataStr) continue;
    try {
      const json = JSON.parse(dataStr);
      text += json.choices?.[0]?.delta?.content || "";
    } catch { /* ignore partial JSON */ }
  }
  return text;
}

/**
 * Helper to create valid OpenAI-compatible SSE chunks.
 * This allows any client (Cline, CLI, etc.) to render our status messages natively.
 */
function createSSEChunk(content: string, model: string = 'engram-proxy') {
  const chunk = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: null
      }
    ]
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// Dedup guard: prevent multiple in-flight extractions for the same prompt
const _logInFlight = new Set<string>();

// ── llama-swap lock (serialize requests per model group) ───────────────

let _swapLock = Promise.resolve();
const swapQueue = new Map<string, Promise<void>>();

function acquireSwap(modelKey?: string): () => void {
  const key = modelKey || "default";
  if (!swapQueue.has(key)) {
    swapQueue.set(key, Promise.resolve());
  }
  let release: () => void;
  swapQueue.set(
    key,
    swapQueue.get(key)!.then(() => new Promise<void>((r) => (release = r))),
  );
  return () => release!();
}

// ── Route ───────────────────────────────────────────────────────────────

export const chat_completions_route = (app: any) => {
  app.post("/v1/chat/completions", async (req: any, res: any) => {
    let reqModel = "";
    try {
      const body: ChatCompletionRequest = req.body;
      reqModel = String(body.model || "");
      if (!body.messages?.length) {
        return res.status(400).json({ err: "messages is required" });
      }

      // P0 #1: Override client-supplied user_id with authenticated identity
      // to prevent user impersonation across API keys
      if (req.auth_user_id) {
        if (body.user_id && body.user_id !== req.auth_user_id) {
          logger.warn({
            module: 'chatRoute',
            claimedUser: body.user_id,
            authUser: req.auth_user_id,
            keyHash: req.auth_key_hash,
          }, `Client claimed user_id="${body.user_id}" but key is bound to "${req.auth_user_id}" — overriding`);
        }
        body.user_id = req.auth_user_id;
      }

      // Extract user's last message first
      const userMessage = body.messages[body.messages.length - 1];
      const userPrompt = typeof userMessage.content === "string" ? userMessage.content : JSON.stringify(userMessage.content);

      // 1. Build Cognitive Context (Genome + Phenotype) via MemoryInjector
      const injector = new MemoryInjector();

      // Use proper db executor (matches what all other routes use)
      const db = kit_make_db(run_async, all_async);

      // Fetch genome memories from durable store (with cache — genomes are near-immutable)
      let genomeMemories: GenomeMemory[] = [];
      const cachedGenomes = genomeCache.get();
      if (cachedGenomes) {
        genomeMemories = cachedGenomes;
      } else {
        try {
          const result = await db.query(
            `select id, content from "public"."memories" where is_genome = true and memory_tier != 'archived' order by recorded_at desc limit 10`,
            [],
          );
          genomeMemories = (result.rows || []).map((r: any) => ({ id: r.id, content: r.content }));
          genomeCache.set(genomeMemories);
        } catch { /* schema may not exist yet */ }
      }
      // Fetch phenotype memories via vector search on user prompt
      let phenotypeMemories: PhenotypeMemory[] = [];
      try {
        const recallResult = await recallDurableMemories(db, { query: userPrompt, limit: 5 });
        phenotypeMemories = recallResult.results.slice(0, 5).map((r: any) => ({
          id: r.id,
          content: r.content,
          sector: r.sector || (r.metadata as any)?.sector || "semantic",
          score: r.score,
        }));
      } catch (err: any) { logger.warn({ module: 'chatRoute', err: err.message }, 'Phenotype recall failed'); }

      logger.debug({ module: 'chatRoute', model: body.model || "default", action: 'memory_recall', genomeCount: genomeMemories.length, phenotypeCount: phenotypeMemories.length }, 'Memory recall completed');

      const cognitiveContext = buildCognitiveContext(genomeMemories, phenotypeMemories);

      // 1.5 Sanitize previous messages to remove Engram status artifacts
      const sanitizedMessages = body.messages
        .map((msg: any) => {
          if (msg.role === 'assistant' && typeof msg.content === 'string') {
            const cleanContent = stripEngramStatus(msg.content);

            // Drop messages that are now empty
            if (!cleanContent) return null;

            return { ...msg, content: cleanContent };
          }

          // Strip reasoning_content from assistant messages
          if (msg.role === 'assistant' && (msg.reasoning_content || msg.reasoning)) {
            const cleaned = { ...msg };
            delete cleaned.reasoning_content;
            delete cleaned.reasoning;
            return cleaned;
          }

          return msg;
        })
        .filter((msg: any): msg is NonNullable<typeof msg> => msg !== null);

      // 2. COMPACT: Async fire-and-forget compaction (trigger at 50+ messages)
      let processedMessages = sanitizedMessages;
      let compactionFactCount = 0;

      if (sanitizedMessages.length > parseInt(process.env.EG_COMPACT_TRIGGER || "50", 10)) {
        // Fire compaction in background - don't wait for it
        compactionEngine.compactIfNeededAsync(sanitizedMessages).catch((err: any) => {
          logger.error({ module: 'chatRoute', model: body.model || "default", err }, 'Background compaction failed');
        });
      }

      // 3. Inject into System Prompt (check for duplicates to avoid Jinja template errors)
      const enrichedMessages = [...processedMessages];
      const hasCognitiveContext = enrichedMessages.some(m =>
        m.role === 'system' && typeof m.content === 'string' && (m.content.includes('[ENGRAM COGNITIVE CONTEXT]') || m.content.includes('[COMPACTED SESSION SUMMARY]'))
      );

      if (!hasCognitiveContext) {
        const cognitiveContextBlock = `[ENGRAM COGNITIVE CONTEXT]\n${cognitiveContext}\n[END ENGRAM CONTEXT]\nUse the above context silently to inform your response. Do not explicitly mention "Engram" or the context blocks unless directly asked about your memory.\n\n`;

        if (enrichedMessages.length > 0 && enrichedMessages[0].role === "system") {
          // Prepend to the existing system message so it stays at index 0
          enrichedMessages[0].content = cognitiveContextBlock + enrichedMessages[0].content;
        } else {
          // No existing system message, create one at the beginning
          enrichedMessages.unshift({ role: "system", content: cognitiveContextBlock });
        }
      }

      // 3. Forward to actual LLM (Preserving ALL original fields like tools, tool_choice, etc.)
      const llmUrl = env.llm_url || (env.openai_key ? env.openai_base_url : `${env.ollama_url}/v1`);
    logger.info({ module: 'chatRoute', llmUrl, model: body.model || "default" }, 'Forwarding enriched request to upstream LLM');
      
      const llmPayload = {
        ...body, // Pass through ALL fields from original request (tools, temperature, etc.)
        model: body.model || process.env.EG_CHAT_MODEL || env.openai_model,
        messages: enrichedMessages, // Override with our enriched, sanitized messages
      };

      // Serialize requests through llama-swap (exclusive model group — one at a time)
      const isSwap = llmUrl.includes("8080/v1") && !llmUrl.includes("localhost");
      let release: (() => void) | null = null;
      if (isSwap) {
        const modelKey = body.model || "default";
        logger.debug({ module: 'chatRoute', model: modelKey, modelKey }, 'Acquiring llama-swap lock');
        release = acquireSwap();
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (env.openai_key) headers["Authorization"] = `Bearer ${env.openai_key}`;

      let llmResponse: Response;
      try {
        llmResponse = await retryFetch(`${llmUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(llmPayload),
        }, {
          retries: 2,
          baseDelayMs: 1000,
          circuitBreakerHost: llmUrl,
          retryOnStatus: (status) => status === 408 || status === 429 || status === 502 || status === 503 || status === 504,
        });
      } finally {
        if (release) release();
      }

      if (!llmResponse.ok) {
        return res.status(llmResponse.status).json({ err: `LLM returned ${llmResponse.status}` });
      }

// 4. Stream response back to client as SSE (with transparent proxy)
      if (body.stream ?? true) {
        // Set headers FIRST before any writes
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        (res as any)._streaming = true;

        // INITIAL STATUS: Tell the user what memory was injected BEFORE the LLM starts
        const initialStatus = buildInjectionStatus(genomeMemories.length, phenotypeMemories.length, compactionFactCount || undefined);
        res.write(createSSEChunk(initialStatus, body.model));

        const reader = llmResponse.body?.getReader();
        if (!reader) {
          return res.status(500).json({ err: "No response body from LLM" });
        }

        const decoder = new TextDecoder();
        let fullLlmResponseText = ""; // Accumulate for async logging

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // ✅ Decode FIRST, then write the string (not raw bytes)
          const chunkText = decoder.decode(value, { stream: true });
          res.write(chunkText);
          for (const line of chunkText.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const dataStr = line.slice(6).trim();
            if (dataStr === "[DONE]") continue;

            try {
              const json = JSON.parse(dataStr);
              const delta = json.choices?.[0]?.delta || {};

              // Extract both reasoning and content for logging
              const reasoningContent = delta.reasoning_content || delta.reasoning || '';
              const regularContent = delta.content || '';

              // 🛑 FILTER: Skip our own status chunks so they never enter the accumulated transcript
              if (!isEngramStatus(regularContent) && !isEngramStatus(reasoningContent)) {
                fullLlmResponseText += reasoningContent + regularContent;
              }
            } catch { /* ignore partial JSON */ }
          }
        }

        // 5. LOG & EXTRACT: Wait for the background process to finish 
        // (Awaiting it here ensures we can send the final status before closing the stream)
        const logResult = await logInteractionAsync(userPrompt, fullLlmResponseText);

        // 6. FINAL STATUS: Tell the user what was learned AFTER the LLM finishes
        const finalStatus = buildExtractionStatus(logResult.storedCount);
        res.write(createSSEChunk(finalStatus, body.model));

        // 7. CLOSE STREAM
        res.write('data: [DONE]\n\n');

        // Send trace after [DONE] so client Zod validation doesn't choke on non-OpenAI fields
        const tracePayload = JSON.stringify({
          genome: genomeMemories.map((m) => m.content),
          phenotype: phenotypeMemories.map((m) => ({ sector: m.sector, content: m.content, score: Number(m.score.toFixed(2)) })),
        });
        res.write(`event: engram_trace\ndata: ${tracePayload}\n\n`);

        res.end();
      } else {
        // Non-streaming: collect full response then send as JSON
        let parsedResponse: any;
        const contentType = llmResponse.headers.get("content-type") || "";

        if (contentType.includes("text/event-stream")) {
          // LLM returned SSE even though we asked for non-stream — parse it
          const reader = llmResponse.body?.getReader();
          if (!reader) return res.status(500).json({ err: "No response body from LLM" });

          const decoder = new TextDecoder();
          let fullBody = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullBody += decoder.decode(value, { stream: true });
          }
          const lastDataLine = fullBody.split("\n").reverse().find((l) => l.startsWith("data: "));
          if (lastDataLine) {
            try { parsedResponse = JSON.parse(lastDataLine.slice(6).trim()); } catch { parsedResponse = {}; }
          }
        } else {
          // LLM returned raw JSON — parse directly
          const text = await llmResponse.text();
          try { parsedResponse = JSON.parse(text); } catch { parsedResponse = { error: "Failed to parse LLM response" }; }
        }

        // Send trace as HTTP header for non-streaming mode (avoids Zod validation issues on client side)
        const tracePayload = JSON.stringify({
          genome: genomeMemories.map((m) => m.content),
          phenotype: phenotypeMemories.map((m) => ({ sector: m.sector, content: m.content, score: Number(m.score.toFixed(2)) })),
        });

        if (!parsedResponse || typeof parsedResponse !== "object") {
          return res.status(502).json({ err: "Invalid LLM response" });
        }

        // Embed _trace in the response body so SDK streaming parser can extract it
        if (parsedResponse.choices && Array.isArray(parsedResponse.choices) && parsedResponse.choices[0]) {
          parsedResponse.choices[0]._trace = JSON.parse(tracePayload);
        }

        res.json(parsedResponse);

        // ASYNC log
        const cleanResponse = parsedResponse?.choices?.[0]?.message?.content || "";
        logInteractionAsync(userPrompt, cleanResponse).catch(() => {});
      }

   } catch (error: unknown) {
      logger.error({ module: 'chatRoute', err: error, model: reqModel }, 'Proxy request failed');
      if (!res.headersSent) {
        res.status(500).json({ err: "Internal Engram Proxy Error", msg: error instanceof Error ? error.message : String(error) });
      } else {
        // Headers already sent — end the stream with an error event (for SSE) or close connection
        if ((res as any)._streaming) {
          res.write(`data: ${JSON.stringify({ err: "Internal Engram Proxy Error", msg: error instanceof Error ? error.message : String(error) })}\n\n`);
          res.end();
        }
      }
    }
  });
};
