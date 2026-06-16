# Phase 4: Traces & Polish

> Goal: Explainable traces and production polish.
> Prerequisite: Phase 3 complete (consolidation and standalone app working).

---

## 1. Explainable Traces

### 1.1 Trace payload design
- [ ] Design the trace payload format
  ```json
  {
    "trace": [
      {
        "sector": "genome",
        "content": "Prefers Python",
        "confidence": 1.0,
        "source": "direct",
        "timestamp": "2024-01-01T00:00:00Z"
      },
      {
        "sector": "episodic",
        "content": "Debugged JWT issue yesterday",
        "confidence": 0.85,
        "source": "vector_search",
        "timestamp": "2024-01-01T00:00:00Z"
      }
    ]
  }
  ```
- [ ] Define trace fields:
  - `sector`: which sector the memory came from
  - `content`: the memory content
  - `confidence`: how confident we are this is relevant (0-1)
  - `source`: how the memory was retrieved (genome, vector_search, keyword, etc.)
  - `timestamp`: when the memory was created/last accessed
  - `trace_id`: unique ID for this trace (for debugging)

### 1.2 Trace generation in proxy
- [ ] Modify the proxy to generate trace data alongside the cognitive context
- [ ] Include the trace in the response to the standalone app
  - Option A: Custom HTTP header (`X-Engram-Trace`)
  - Option B: Custom sidecar payload at end of stream
  - Option C: Separate endpoint to fetch trace after request
- [ ] Log the trace for debugging (without exposing to client)

**Acceptance criteria:**
- Trace is generated for every request
- Trace includes all recalled memories with metadata
- Trace is sent to the standalone app

### 1.3 Trace storage
- [ ] Store traces in a new `traces` table (or append to existing logs)
- [ ] Index traces by `trace_id`, `user_id`, `timestamp`
- [ ] Set retention policy (e.g., keep traces for 30 days)
- [ ] Add API to query traces:
  - `GET /traces/:id` — get a specific trace
  - `GET /traces` — list recent traces
  - `GET /traces?user_id=...` — filter by user

**Acceptance criteria:**
- Traces are stored reliably
- Traces can be queried efficiently
- Trace storage doesn't impact performance

---

## 2. Standalone App UI: Trace Display

### 2.1 Trace visualization
- [ ] Design the trace UI in the standalone app
  - Collapsible panel at the bottom of the response
  - Shows: "Recalled N memories. X Genome, Y Episodic, Z Semantic..."
  - Expandable to see exactly what was injected
- [ ] Implement the trace UI
  - Parse the trace payload from the proxy response
  - Render the trace in the UI
  - Handle missing or malformed traces gracefully

### 2.2 Trace details view
- [ ] When expanded, show:
  - Each recalled memory with its sector, content, confidence
  - Source of the memory (genome, vector search, etc.)
  - Timestamp of the memory
  - Link to the memory in the memory viewer
- [ ] Allow clicking on a memory to open it in the memory viewer

### 2.3 Trace history
- [ ] Show a history of recent traces in the app
- [ ] Allow filtering traces by:
  - Date range
  - Sector
  - Confidence level
- [ ] Allow searching traces by content

**Acceptance criteria:**
- Trace UI shows correct information
- Trace UI is collapsible and doesn't clutter the response
- Trace history is queryable and filterable
- Clicking a memory opens it in the memory viewer

---

## 3. Performance Optimization

### 3.1 Query optimization
- [ ] Profile the proxy's response time
- [ ] Identify bottlenecks:
  - Memory injection (vector search, decay scoring)
  - LLM forwarding (network latency)
  - Async logging
- [ ] Optimize the slowest operations
  - Add caching for genome memories (they don't change often)
  - Optimize pgvector queries
  - Reduce the number of memories queried (start with 5, not 20)

### 3.2 Memory optimization
- [ ] Monitor memory usage of the proxy and app
- [ ] Optimize memory usage:
  - Use connection pooling for Postgres
  - Limit the number of concurrent requests
  - Use streaming for large responses
- [ ] Set memory limits and alert on high usage

### 3.3 Error handling
- [ ] Add comprehensive error handling:
  - Proxy errors (network, LLM, memory)
  - App errors (UI, request forwarding)
  - Graceful degradation when memory is unavailable
- [ ] Add error logging and alerting

---

## 4. Security Hardening

### 4.1 Input validation
- [ ] Validate all inputs to the proxy
- [ ] Sanitize inputs to prevent injection attacks
- [ ] Limit request size (max message length, max number of messages)

### 4.2 Authentication
- [ ] Add optional authentication to the proxy
  - API key authentication
  - Token-based authentication
- [ ] Add authentication to the standalone app
  - Local authentication (user password)
  - Optional: integrate with system authentication

### 4.3 Data protection
- [ ] Encrypt sensitive data at rest (if applicable)
- [ ] Redact sensitive data in logs
- [ ] Add data retention policies

---

## 5. Documentation

### 5.1 README
- [ ] Write the README documenting the new "Implicit Proxy" architecture
  - Overview of the system
  - Architecture diagram
  - How to set up the proxy
  - How to set up the standalone app
  - How to configure memory injection
  - How to view traces
  - Troubleshooting guide

### 5.2 API documentation
- [ ] Document all proxy endpoints
- [ ] Document all standalone app endpoints
- [ ] Document the trace API

### 5.3 User documentation
- [ ] Write user guide for the standalone app
- [ ] Write admin guide for the proxy
- [ ] Write developer guide for extending the system

---

## 6. Definition of Done

- [ ] Explainable traces are generated and sent to the standalone app
- [ ] Trace UI shows correct information and is collapsible
- [ ] Trace history is queryable and filterable
- [ ] Performance is optimized (response time < 500ms for typical requests)
- [ ] Error handling is comprehensive
- [ ] Security is hardened (input validation, authentication, data protection)
- [ ] README documents the new "Implicit Proxy" architecture
- [ ] All documentation is complete
- [ ] All tests pass
- [ ] V2 Launch ready
