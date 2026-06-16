# Issues Tracker

## Important Files:
- /home/ftr/Documents/openWeb.searxng/Engram - Directory for the entire project
- /home/ftr/Documents/openWeb.searxng/Engram/apps/web - Web Interface
- /home/ftr/Documents/openWeb.searxng/Engram/apps/vscode-extension - Openmemory helper extension, not currently being used
- /home/ftr/Documents/openWeb.searxng/Engram/plan.md - The Plan, this is what the project is trying to do
- /home/ftr/Documents/openWeb.searxng/Engram/tracker.md - This was the update checklist based off of the plan.md doc
- /home/ftr/Documents/openWeb.searxng/Engram/Vision.md - This was a brainstorming session to conceptualize and begin programming the revisions to the project

## Data Flow
```text
[User] 
  ↓ (Types prompt in Kilo)
[VS Code Extension / Client] 
  ↓ (Sends POST to http://localhost:8080/v1/chat/completions)
[CODECORTEX SMART PROXY] (The Brain)
  ├─ 1. INTERCEPT: Grabs user prompt & active workspace context.
  ├─ 2. RETRIEVE: 
  │     ├─ Fetches "Genome" (Immutable facts, zero latency).
  │     └─ Queries "Phenotype" (Vector search across 5 HMD sectors).
  ├─ 3. INJECT: Rewrites the System Prompt with cognitive context.
  ├─ 4. FORWARD: Streams request to actual LLM (Ollama/OpenAI).
  ├─ 5. STREAM: Passes SSE tokens back to VS Code instantly.
  └─ 6. LOG (Async): Fires background job to store the new interaction.
```

## Intended Operation
1. **Start your Backend**: `cd /home/ftr/Documents/openWeb.searxng/Engram/packages/engram-js && EG_PORT=8080 npx nodemon src/server.ts`
   Ensure your Node.js proxy is running & Verify it's listening on `http://localhost:8080`.
2. **Open the Chat Panel**: 
   In the new VS Code window, open Kilo's Chat view (`Ctrl+Alt+I` or `Cmd+Option+I`).
3. **Invoke Engram**: 
   Type `@cortex How should I structure my auth middleware?`
4. **Observe the Magic**:
   * You will see "🧠 Querying Engram memory engine..."
   * The response will stream in naturally.
   * At the bottom, you will see a collapsible **"🧠 Engram Memory Trace"** section showing exactly *why* the AI answered the way it did, citing your postgres database.


## Current Status:
- The plan was executed, and is in a debugging phase, Engram is currently running using this command:
  `cd /home/ftr/Documents/openWeb.searxng/Engram/packages/engram-js && EG_PORT=8080 npx nodemon src/server.ts`

## Issues:

### Naming conventions are a bit scattered, in the end the project will be named FTR10 Engram. The server will be named Engram. The modified Kilo extension will be named EngramVS.

