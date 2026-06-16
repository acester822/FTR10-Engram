/*
    ____                   __  __                                 
   / __ \                 |  \/  |                                
  | |  | |_ __   ___ _ __ | \  / | ___ _ __ ___   ___  _ __ _   _ 
  | |  | | '_ \ / _ \ '_ \| |\/| |/ _ \ '_ ` _ \ / _ \| '__| | | |
  | |__| | |_) |  __/ | | | |  | | |__| | | | (_) | |  | |_| |
   \____/| .__/ \___|_| |_|_|  |_|\___|_| |_| |_|\___/|_|   \__, |
         | |                                                 __/ |
         |_|                                                |___/ 
  CaviraOSS @ 2026

 - filename: packages/engram-js/src/api/routes/chat/completions/route.ts
 - what is the file used for: POST /v1/chat/completions — OpenAI-compatible smart proxy endpoint that intercepts requests, builds cognitive context via MemoryInjector (genome + phenotype), injects into system prompt, forwards to LLM, streams SSE back, and logs interactions for memory extraction.
*/

import { env } from "../../../../configuration";
import { consolidationEngine } from "../../../../services/consolidationEngine";
import { classifyMemory, DEFAULT_GENOME_DECAY_RATE, DEFAULT_PHENOTYPE_DECAY_RATE, computeDecaySalience, MemoryInjector } from "../../../../services/memoryInjector";
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

/** Build cognitive context from genome + phenotype memories */
function buildCognitiveContext(genome: GenomeMemory[], phenotype: PhenotypeMemory[]): string {
  let ctx = "[CODECORTEX COGNITIVE CONTEXT]\n";

  if (genome.length > 0) {
    ctx += "--- CORE DIRECTIVES (GENOME) ---\n";
    for (const m of genome) {
      ctx += `- ${m.content}\n`;
    }
    ctx += "\n";
  }

  if (phenotype.length > 0) {
    ctx += "--- RECALLED CONTEXT (PHENOTYPE) ---\n";
    const grouped: Record<string, string[]> = {};
    for (const m of phenotype) {
      if (!grouped[m.sector]) grouped[m.sector] = [];
      grouped[m.sector].push(m.content);
    }
    for (const [sector, contents] of Object.entries(grouped)) {
      ctx += `[${sector.toUpperCase()}]\n`;
      for (const c of contents) {
        ctx += `- ${c}\n`;
      }
      ctx += "\n";
    }
  }

  ctx += "[END CODECORTEX CONTEXT]\n";
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
    try {
      const body: ChatCompletionRequest = req.body;
      if (!body.messages?.length) {
        return res.status(400).json({ err: "messages is required" });
      }

      // Extract user's last message first
      const userMessage = body.messages[body.messages.length - 1];
      const userPrompt = typeof userMessage.content === "string" ? userMessage.content : JSON.stringify(userMessage.content);

      // 1. Build Cognitive Context (Genome + Phenotype) via MemoryInjector
      const injector = new MemoryInjector();

      // Use proper db executor (matches what all other routes use)
      const db = kit_make_db(run_async, all_async);

      // Fetch genome memories from durable store
      let genomeMemories: GenomeMemory[] = [];
      try {
        const result = await db.query(
          `select id, content from "public"."memories" where is_genome = true and memory_tier != 'archived' order by recorded_at desc limit 10`,
          [],
        );
        genomeMemories = (result.rows || []).map((r: any) => ({ id: r.id, content: r.content }));
      } catch { /* schema may not exist yet */ }
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
      } catch (err: any) { console.warn("[Engram] Phenotype recall failed:", err.message); }

      console.log(`[Engram] 🧠 Recall: genome=${genomeMemories.length} phenotype=${phenotypeMemories.length}`);

      const cognitiveContext = buildCognitiveContext(genomeMemories, phenotypeMemories);

      // 1.5 Sanitize previous messages to remove Engram status artifacts
      const sanitizedMessages = body.messages
        .map((msg: any) => {
          if (msg.role === 'assistant' && typeof msg.content === 'string') {
            let cleanContent = msg.content;
            
            // Create fresh regex instances for each message (no shared state!)
            const injectedRe = /🧠 \*?Engram:\s*\*?Injected \d+ Genome and \d+ Phenotype memory\(ies\) into context\.\*\n?/g;
            const extractionRe = /\n?---?\s*🧠 \*?Engram:\s*\*?Extraction complete\. Stored \d+ new memory\(ies\)\.\*/g;
            const statusRe = /🧠\s*\*?Engram:\s*(Injected|Extraction complete)[^\n]*/g;
            
            // Remove all status messages
            cleanContent = cleanContent.replace(injectedRe, '');
            cleanContent = cleanContent.replace(extractionRe, '');
            cleanContent = cleanContent.replace(statusRe, '');
            
            const trimmed = cleanContent.trim();
            
            // Drop messages that are now empty
            if (!trimmed) return null;
            
            return { ...msg, content: trimmed };
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

      // 2. Inject into System Prompt (Merge to avoid Jinja template errors)
      const enrichedMessages = [...sanitizedMessages];

      const cognitiveContextBlock = `[CODECORTEX COGNITIVE CONTEXT]\n${cognitiveContext}\n[END CODECORTEX CONTEXT]\nUse the above context silently to inform your response. Do not explicitly mention "Engram" or the context blocks unless directly asked about your memory.\n\n`;

      if (enrichedMessages.length > 0 && enrichedMessages[0].role === "system") {
        // Prepend to the existing system message so it stays at index 0
        enrichedMessages[0].content = cognitiveContextBlock + enrichedMessages[0].content;
      } else {
        // No existing system message, create one at the beginning
        enrichedMessages.unshift({ role: "system", content: cognitiveContextBlock });
      }

      // 3. Forward to actual LLM (Preserving ALL original fields like tools, tool_choice, etc.)
      const llmUrl = env.llm_url || (env.openai_key ? env.openai_base_url : `${env.ollama_url}/v1`);
      console.log(`[Engram] → Forwarding to: ${llmUrl} (model: ${body.model || "default"})`);
      
      const llmPayload = {
        ...body, // Pass through ALL fields from original request (tools, temperature, etc.)
        model: body.model || process.env.CHAT_MODEL || env.openai_model,
        messages: enrichedMessages, // Override with our enriched, sanitized messages
      };

      // Serialize requests through llama-swap (exclusive model group — one at a time)
      const isSwap = llmUrl.includes("8080/v1") && !llmUrl.includes("localhost");
      let release: (() => void) | null = null;
      if (isSwap) {
        console.log("[Engram] → Acquiring llama-swap lock...");
        release = acquireSwap();
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (env.openai_key) headers["Authorization"] = `Bearer ${env.openai_key}`;

      let llmResponse: Response;
      try {
        llmResponse = await fetch(`${llmUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(llmPayload),
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

        const tracePayload = JSON.stringify({
          genome: genomeMemories.map((m) => m.content),
          phenotype: phenotypeMemories.map((m) => ({ sector: m.sector, content: m.content, score: Number(m.score.toFixed(2)) })),
        });

        // INITIAL STATUS: Tell the user what memory was injected BEFORE the LLM starts
        const initialStatus = `🧠 *Engram: Injected ${genomeMemories.length} Genome and ${phenotypeMemories.length} Phenotype memory(ies) into context.*\n\n`;
        res.write(createSSEChunk(initialStatus, body.model));

        const reader = llmResponse.body?.getReader();
        if (!reader) {
          return res.status(500).json({ err: "No response body from LLM" });
        }

        // Inject _trace into each SSE chunk so the SDK streaming parser can extract it
        const traceInjected = (dataStr: string): string => {
          try {
            const json = JSON.parse(dataStr);
            if (json.choices && Array.isArray(json.choices) && json.choices[0]) {
              json.choices[0]._trace = JSON.parse(tracePayload);
              return JSON.stringify(json);
            }
          } catch { /* not valid JSON, pass through */ }
          return dataStr;
        };

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
              if (!regularContent.includes('🧠 *Engram:') && !reasoningContent.includes('🧠 *Engram:')) {
                fullLlmResponseText += reasoningContent + regularContent;
              }
            } catch { /* ignore partial JSON */ }
          }
        }

        // 5. LOG & EXTRACT: Wait for the background process to finish 
        // (Awaiting it here ensures we can send the final status before closing the stream)
        const logResult = await logInteractionAsync(userPrompt, fullLlmResponseText);

        // 6. FINAL STATUS: Tell the user what was learned AFTER the LLM finishes
        const finalStatus = `\n\n---\n🧠 *Engram: Extraction complete. Stored ${logResult.storedCount} new memory(ies).*`;
        res.write(createSSEChunk(finalStatus, body.model));

        // 7. CLOSE STREAM
        res.write('data: [DONE]\n\n');
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

    } catch (error) {
      console.error("[Engram] Proxy Error:", error);
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
