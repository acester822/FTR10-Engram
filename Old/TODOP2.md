# Phase 2: Standalone Smart Proxy (MVP)

> Goal: Turn the Node.js server into an OpenAI-compatible API gateway that transparently injects memory.
> Prerequisite: Phase 1 complete (memoryInjector working).

---

## 1. Proxy Endpoint: `POST /v1/chat/completions`

### 1.1 Route setup
- [ ] Create new route in Express/Fastify router
- [ ] Path: `POST /v1/chat/completions`
- [ ] Content-Type: `application/json`
- [ ] Accepts standard OpenAI chat completion request format
- [ ] Returns standard OpenAI chat completion response format

### 1.2 Request parsing
- [ ] Extract `messages` array from request body
- [ ] Extract `stream` flag (default: true)
- [ ] Extract `model`, `temperature`, and other LLM params
- [ ] Validate that messages array is non-empty
- [ ] Validate that at least one message has role "user"

**Acceptance criteria:**
- Malformed requests return 400 with clear error
- Missing messages array returns 400
- Empty messages array returns 400

### 1.3 Prompt extraction
- [ ] Extract the last message from the messages array as the user prompt
- [ ] Handle the case where the last message is already a system message (edge case)
- [ ] Log the prompt length for debugging

**Acceptance criteria:**
- Correctly identifies the user's actual prompt even in multi-turn conversations

### 1.4 Cognitive context injection
- [ ] Call `memoryInjector.buildCognitiveContext(userPrompt)`
- [ ] Prepend the cognitive context as a new system message:
  ```typescript
  const enrichedMessages = [
    { role: 'system', content: cognitiveContext },
    ...messages
  ];
  ```
- [ ] Log the context injection (length, number of memories recalled)

**Acceptance criteria:**
- Context is injected before all original messages
- Original messages are preserved in order
- Context injection doesn't break existing system messages

### 1.5 Forwarding to LLM
- [ ] Construct the payload for the actual LLM:
  ```typescript
  const llmPayload = {
    ...llmParams,
    messages: enrichedMessages,
    stream: stream
  };
  ```
- [ ] Read LLM endpoint from `LLM_BASE_URL` env var (default: `http://localhost:11434` for Ollama)
- [ ] Forward the request to the LLM endpoint
- [ ] Handle LLM errors gracefully (502 Bad Gateway with message)

**Acceptance criteria:**
- Proxy forwards requests correctly to Ollama
- Proxy forwards requests correctly to OpenAI
- Errors from LLM are passed through to client

---

## 2. Streaming (SSE) Support

### 2.1 Streaming passthrough
- [ ] Detect if `stream: true` in the request
- [ ] If streaming:
  1. Set response headers for SSE (`Content-Type: text/event-stream`)
  2. Pipe the LLM's SSE response directly to the client
  3. Preserve the SSE format (data: {...}\n\n)
- [ ] If not streaming:
  1. Wait for full response
  2. Return JSON response

### 2.2 Streaming edge cases
- [ ] Handle LLM stream abort (client disconnect)
- [ ] Handle LLM stream errors mid-flight
- [ ] Ensure response is properly closed on error

**Acceptance criteria:**
- Streaming works with Ollama
- Streaming works with OpenAI
- Non-streaming mode works
- Client can cancel streaming request

---

## 3. Async Memory Logging

### 3.1 Background logger
- [ ] Create `logInteractionAsync(userPrompt: string, llmResponse: string): Promise<void>`
- [ ] Fire-and-forget: don't block the response
- [ ] Log the `(Prompt + Response)` pair to the memory system
- [ ] Use the existing `/memory/add` or `/ingest` endpoint
- [ ] Classify the interaction into the 5 sectors (episodic, semantic, procedural, emotional, reflective)

### 3.2 Error handling
- [ ] Wrap the entire logging in try/catch
- [ ] Log errors but don't fail the request
- [ ] Queue failed logs for retry (optional, defer to later)

**Acceptance criteria:**
- Logging doesn't affect response time
- Failed logs are logged but don't crash the server
- New interactions are stored in the memory system

---

## 4. Configuration

### 4.1 Environment variables
- [ ] `LLM_BASE_URL` — URL of the actual LLM (default: `http://localhost:11434`)
- [ ] `LLM_API_KEY` — API key for OpenAI-compatible endpoints (optional)
- [ ] `MEMORY_INJECTION_ENABLED` — toggle memory injection on/off (default: true)
- [ ] `MAX_CONTEXT_MEMORIES` — max phenotype memories to inject (default: 5)
- [ ] `MAX_GENOME_MEMORIES` — max genome memories to inject (default: 10)

### 4.2 Startup configuration
- [ ] Read env vars at startup
- [ ] Validate required env vars
- [ ] Log configuration on startup

---

## 5. Tests

### 5.1 Unit tests
- [ ] Test prompt extraction from various message formats
- [ ] Test cognitive context injection
- [ ] Test payload construction for forwarding
- [ ] Test streaming passthrough logic
- [ ] Test error handling for malformed requests

### 5.2 Integration tests
- [ ] Test full proxy flow with Ollama (streaming)
- [ ] Test full proxy flow with Ollama (non-streaming)
- [ ] Test full proxy flow with mock LLM
- [ ] Test memory injection is actually happening (verify context in logs)
- [ ] Test async logging works

### 5.3 Load tests
- [ ] Smoke test: 10 concurrent requests
- [ ] Verify memory injection doesn't slow down responses significantly
- [ ] Verify streaming works under load

---

## 6. Documentation

- [ ] Document the proxy endpoint in the API docs
- [ ] Document how to configure the proxy
- [ ] Document the environment variables
- [ ] Add usage examples (curl, Python, etc.)

---

## 7. Definition of Done

- [ ] `POST /v1/chat/completions` endpoint is implemented
- [ ] Cognitive context is injected before the LLM sees the prompt
- [ ] Streaming (SSE) passthrough works
- [ ] Async memory logging works
- [ ] All tests pass (unit + integration + load)
- [ ] You can point a standard OpenAI client (Open WebUI, Continue.dev) to the proxy and it works flawlessly with memory
