- To Do

# Engram
## Compaction
- Update the prompt, see what kilo uses and adapt, as the one it is using now is dirty popsicle sticks

# Web GUI
## Observability

### Tracing
- ~~Input and Output are showing up blank on the main traces tab~~ → FIXED: Added `input` to trace creation (user messages + model), added `trace.update({ output })` after response completes in both streaming and non-streaming paths. Langfuse traces tab will now show input/output data.

- ~~Name column is very vague~~ → FIXED: Trace name is now dynamic — computed from what happened during the request (e.g., "Upstream Request | Memory Recall | Compacted | Auto-Search"). Updated in route.ts after compaction/memory recall completes.

- ~~Session is blank~~ → FIXED: Added `session_id` extraction with multi-source fallback chain (HTTP header `x-session-id` → body `session_id` → query param `?session_id=` → auto-generated UUID). Passed to Langfuse trace via `sessionId` field. Sessions will populate in the UI once clients send session IDs.

## Sessions
- ~~Not working at all~~ → FIXED: Added `session_id?: string` to `ChatCompletionRequest` interface (route.ts:30). Session ID extraction implemented as priority chain: header → body → query → UUID. Any agent handler can pass session via `x-session-id` HTTP header or `session_id` in request body. No Kilo-specific coupling — fully generic for any client.

  **Client usage:**
  ```bash
  curl -H "x-session-id: my-conversation-123" \
    http://localhost:8080/v1/chat/completions \
    -d '{"messages":[...], "model":"qwen3.6"}'
  ```

## Evaluation

### All tabs
- None of these are set up, to be fair, that may be something the user needs to do not related to initial setup, just investigate this please

## Engram
### Engram
- This needs renamed to Dashboard
- Does not work at all, displays zero information
### Memories
- Not working at all
### Logs
- Not working at all
### Performance
- displaying as the raw json data, charts need to be made