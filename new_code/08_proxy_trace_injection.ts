// Proxy-side trace injection (goes at end of /v1/chat/completions route, before res.end())

// 1. Fetch the trace data that was used for this specific request
// (You can store this in a variable during the memoryInjector.buildCognitiveContext step)
const traceData = {
  genome: genomeMemories.map(m => m.content),
  phenotype: phenotypeMemories.map(m => ({ sector: m.sector, content: m.content, score: m.finalScore }))
};

// 2. Send a custom SSE event that the VS Code extension can parse
const tracePayload = JSON.stringify(traceData);
res.write(`event: engram_trace\ndata: ${tracePayload}\n\n`);

res.end();
