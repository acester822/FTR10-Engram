Here is the final piece of the puzzle: the **`logInteractionAsync`** function. This closes the "vice versa" loop by automatically analyzing the conversation *after* it finishes, extracting new facts, and saving them to your cognitive database.

We will use a fast, local LLM (like `phi3` or `llama3:8b` via Ollama) with **structured JSON output** to ensure the extraction is reliable and doesn't break your database schema.

---

### Step 1: The Memory Logger Service

Create this file at: `packages/openmemory-js/src/services/memoryLogger.ts`

```typescript
import { v4 as uuidv4 } from 'uuid';
import { db } from '../database'; // Replace with your actual DB import
import { MemorySector } from './memoryInjector';

const LOCAL_LLM_MODEL = process.env.EXTRACTION_MODEL || 'phi3'; // Fast, cheap local model
const LOCAL_LLM_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

/**
 * Asynchronously analyzes a conversation and extracts new cognitive memories.
 * This is a "fire-and-forget" function called after the LLM response streams to the user.
 */
export async function logInteractionAsync(userPrompt: string, llmResponseText: string): Promise<void> {
  // Wrap in try/catch so it never crashes the main proxy request
  try {
    console.log('[CodeCortex] 🧠 Analyzing conversation for new memories...');

    const extractionPrompt = `
You are a cognitive memory extraction engine. 
Analyze the following conversation between a User and an AI.
Extract ONLY new, significant, or actionable facts, preferences, or events.
Ignore generic pleasantries, repeated information, or trivial details.

Classify each extracted fact into exactly one of these sectors:
- "semantic": General facts, preferences, or architectural rules (e.g., "User prefers Python").
- "procedural": How-to steps or workflows (e.g., "Deploy requires running make build first").
- "episodic": Specific events or recent actions (e.g., "User debugged a JWT error today").
- "emotional": User sentiment or frustrations (e.g., "User is frustrated with TypeScript strict mode").
- "reflective": High-level summaries or lessons learned.

If a fact is a core, immutable rule that should NEVER be forgotten, set is_genome to true. Otherwise, false.

Conversation:
User: ${userPrompt}
AI: ${llmResponseText}

Output ONLY a valid JSON array of objects with this exact schema. Do not include markdown formatting or any other text:
[
  {
    "content": "The extracted fact",
    "sector": "semantic",
    "is_genome": false
  }
]
If no significant memories are found, output an empty array: []
`.trim();

    // Call local LLM with structured JSON output (Ollama feature)
    const response = await fetch(`${LOCAL_LLM_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LOCAL_LLM_MODEL,
        prompt: extractionPrompt,
        stream: false,
        format: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              sector: { type: "string", enum: ["semantic", "procedural", "episodic", "emotional", "reflective"] },
              is_genome: { type: "boolean" }
            },
            required: ["content", "sector", "is_genome"]
          }
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Extraction LLM returned ${response.status}`);
    }

    const data = await response.json();
    let extractedMemories: any[] = [];
    
    try {
      // Ollama sometimes still wraps JSON in markdown code blocks despite the format flag. Clean it.
      const cleanJson = data.response.replace(/^```json\s*|\s*```$/g, '').trim();
      extractedMemories = JSON.parse(cleanJson);
    } catch (e) {
      console.error('[CodeCortex] Failed to parse LLM extraction JSON. Raw output:', data.response);
      return; // Exit gracefully
    }

    if (!Array.isArray(extractedMemories) || extractedMemories.length === 0) {
      console.log('[CodeCortex] No new significant memories extracted.');
      return;
    }

    // Insert extracted memories into the database
    for (const mem of extractedMemories) {
      const id = uuidv4();
      
      // Set decay rate based on sector and genome status
      let decayRate = 0.1; // Default
      if (mem.is_genome) decayRate = 0.0;
      else if (mem.sector === 'episodic') decayRate = 0.15; // Episodic fades fastest
      else if (mem.sector === 'semantic' || mem.sector === 'procedural') decayRate = 0.05; // Long-term fades slow

      await db.execute(`
        INSERT INTO memories (id, content, sector, is_genome, decay_rate, access_count, created_at, last_accessed)
        VALUES (?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        id, 
        mem.content, 
        mem.sector, 
        mem.is_genome ? 1 : 0, 
        decayRate
      ]);
      
      console.log(`[CodeCortex] 💾 Saved new [${mem.sector}] memory: "${mem.content.substring(0, 60)}${mem.content.length > 60 ? '...' : ''}"`);
    }

  } catch (error) {
    console.error('[CodeCortex] ❌ Async memory logging failed:', error);
  }
}
```

---

### Step 2: Update the Proxy to Accumulate the Response

In your previous proxy code, we streamed the response directly to the client. To log the interaction, we need to **accumulate the text** while streaming, and then pass it to `logInteractionAsync` at the very end.

Update your `/v1/chat/completions` route in `src/server/index.ts` (or wherever your routes live) to look like this:

```typescript
import { memoryInjector } from '../services/memoryInjector';
import { logInteractionAsync } from '../services/memoryLogger';
// ... other imports

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { messages, stream = true, ...llmParams } = req.body;
    const userPrompt = messages[messages.length - 1].content;

    // 1. Build Cognitive Context
    const { cognitiveContext, genomeMemories, phenotypeMemories } = await memoryInjector.buildCognitiveContextWithTrace(userPrompt);
    // Note: You'll need to slightly update memoryInjector.ts to return the arrays alongside the string (shown below)

    const enrichedMessages = [
      { role: 'system', content: cognitiveContext },
      ...messages
    ];

    const llmPayload = { ...llmParams, messages: enrichedMessages, stream: true };
    const llmUrl = process.env.LLM_BASE_URL || 'http://localhost:11434';
    
    const llmResponse = await fetch(`${llmUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.LLM_API_KEY || 'ollama'}`
      },
      body: JSON.stringify(llmPayload)
    });

    if (!llmResponse.ok) throw new Error(`LLM returned ${llmResponse.status}`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = llmResponse.body.getReader();
    const decoder = new TextDecoder();
    
    // ACCUMULATOR: Capture the full text for the background logger
    let fullLlmResponseText = ''; 

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunkText = decoder.decode(value, { stream: true });
      res.write(chunkText); // Stream to client immediately

      // Naive accumulation for logging (ignores JSON parsing overhead during stream)
      // We will clean this up after the stream ends
      fullLlmResponseText += chunkText;
    }
    
    // 2. Send the Custom Trace Event (from previous step)
    const tracePayload = JSON.stringify({
      genome: genomeMemories.map(m => m.content),
      phenotype: phenotypeMemories.map(m => ({ sector: m.sector, content: m.content, score: m.finalScore }))
    });
    res.write(`event: codecortex_trace\ndata: ${tracePayload}\n\n`);
    res.end();

    // 3. CLEANUP & LOG: Parse the accumulated text to get the clean string, then log
    const cleanResponse = extractTextFromSSE(fullLlmResponseText);
    
    // Fire and forget
    logInteractionAsync(userPrompt, cleanResponse).catch(err => 
      console.error('[CodeCortex] Background logging failed:', err)
    );

  } catch (error) {
    console.error('[CodeCortex] Proxy Error:', error);
    res.status(500).json({ error: 'Internal CodeCortex Proxy Error' });
  }
});

/**
 * Helper to strip SSE formatting and extract just the AI's text content
 */
function extractTextFromSSE(sseString: string): string {
  let text = '';
  const lines = sseString.split('\n');
  for (const line of linesBitterbot) {
    if (line.startsWith('data: ')) {
      const dataStr = line.slice(6).trim();
      if (dataStr === '[DONE]') continue;
      try {
        const json = JSON.parse(dataStr);
        const content = json.choices?.[0]?.delta?.content || '';
        text += content;
      } catch (e) { /* ignore partial JSON */ }
    }
  }
  return text;
}
```

*(Minor fix needed in `memoryInjector.ts`)*: Update the `buildCognitiveContext` method signature to return the arrays so the proxy can send the trace:
```typescript
// Change the return type in memoryInjector.ts:
async buildCognitiveContextWithTrace(userPrompt: string): Promise<{ cognitiveContext: string, genomeMemories: Memory[], phenotypeMemories: Memory[] }> {
   // ... existing logic ...
   return { cognitiveContext: this.formatPromptInjection(genome, phenotype), genomeMemories: genome, phenotypeMemories: phenotype };
}
```