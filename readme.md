Layout:

```text
[ MACHINE A: LINUX SERVER ]                  [ MACHINE B: MSI RAIDER (10.10.10.41) ]
┌──────────────────────────────┐             ┌──────────────────────────────────────┐
│ • OpenMemory Proxy (Port 8080)│             │ • llama-swap (Port 8080)               │
│ • Internal Ollama (Port 11434)│             │ • RTX 4090 (16GB VRAM)                 │
│ • PostgreSQL / Vector DB      │             │ • Massive Chat Models (e.g., Qwopus3.6)│
│ • Tiny Embed/Extract Models   │             │ • Tiny Extract Models (Fallback)       │
└──────────────────────────────┘             └──────────────────────────────────────┘
        ▲                                                ▲
        │                                                │
        └────────────── [ MACHINE C: USER WORKSPACE ] ───┘
                        (IDE, Cline, Continue, CLI)
```

---

### 🔄 The Step-by-Step Data Flow

#### Phase 1: Initiation & Interception
**1. The User** types a prompt in their IDE (e.g., *"How do I fix this JWT auth error?"*).
**2. The IDE** sends the request to `http://<Linux-Server-IP>:8080/v1/chat/completions`.
   * *Payload:* `{ model: "Qwopus3.6-MTP-no-thinking", messages: [...] }`
**3. OpenMemory Proxy (Linux Server)** intercepts the request. It pauses the request to the LLM and extracts the `userPrompt` and the `requestedModel`.

#### Phase 2: Internal Memory Retrieval (Local Linux Server)
*Goal: Find relevant memories without touching the MSI Raider's VRAM.*
**4. OpenMemory** sends the `userPrompt` to **Internal Ollama (`localhost:11434`)** using the `bge-m3:latest` model to generate a vector embedding.
**5. OpenMemory** queries the local **PostgreSQL/Vector DB** for matching memories.
**6. OpenMemory** separates the results into:
   * **Genome:** Immutable facts (e.g., "User prefers async/await").
   * **Phenotype:** Decaying context (e.g., "User was debugging JWT yesterday").

#### Phase 3: Context Weaving & Initial Status
**7. OpenMemory** silently weaves these memories into the `system` message of the prompt with strict instructions: *"Use this knowledge naturally. Never mention 'memory' or 'context'."*
**8. OpenMemory** sends the first SSE (Server-Sent Event) chunk directly to the **User's IDE**:
   > `🧠 *CodeCortex: Injected 2 Genome and 1 Phenotype memory(ies).*`

#### Phase 4: Forwarding to Upstream LLM (Remote MSI Raider)
*Goal: Send the enriched prompt to the heavy-lifting GPU.*
**9. OpenMemory** forwards the fully enriched payload to **llama-swap (`http://10.10.10.41:8080/v1`)**.
   * *Crucial Detail:* It passes the exact model the user requested: `model: "Qwopus3.6-MTP-no-thinking"`.
**10. llama-swap (MSI Raider)** receives the request. It checks its VRAM, loads `Qwopus3.6` into the RTX 4090, and prepares to generate.

#### Phase 5: Generation & Streaming
**11. Qwopus3.6 (MSI Raider)** generates the response. Because the context was "baked in" invisibly, it naturally replies: *"Here is the async/await fix for your JWT refresh token issue..."*
**12. llama-swap** streams the response token-by-token back to **OpenMemory (Linux Server)**.
**13. OpenMemory** acts as a transparent pipe, instantly streaming those raw tokens directly to the **User's IDE**.
   * *Note: OpenMemory is simultaneously accumulating these tokens in memory for Phase 6.*

#### Phase 6: Background Extraction (Local Linux Server)
*Goal: Learn from the conversation without interrupting the user or thrashing VRAM.*
**14. Once the stream finishes**, OpenMemory takes the full transcript (User Prompt + LLM Response).
**15. OpenMemory** sends this transcript to **Internal Ollama (`localhost:11434`)** using a tiny, fast model (e.g., `qwen2.5:3b` or `qwen-cpu-minimal`).
   * *Prompt:* "You are a data extraction API. Output ONLY a JSON array of new facts..."
**16. Internal Ollama** outputs a clean JSON array of new facts (e.g., `{"content": "User fixed JWT refresh token bug", "sector": "episodic"}`).
**17. OpenMemory** saves these new facts into the local **PostgreSQL DB**.

#### Phase 7: Final Status & Closure
**18. OpenMemory** sends the final SSE chunk to the **User's IDE**:
   > `🧠 *CodeCortex: Extraction complete. Stored 1 new memory(ies).*`
   
**19. OpenMemory** sends the `[DONE]` signal, closing the stream. The IDE renders the final UI state.