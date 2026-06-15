// Proxy-side trace payload (refined version - goes at end of /v1/chat/completions route, before res.end())

// 1. Gather the trace data that was used for THIS specific request
// (Assuming you saved these during the memoryInjector.buildCognitiveContext step)
const tracePayload = {
  genome: genomeMemories.map(m => m.content),
  phenotype: phenotypeMemories.map(m => ({ 
    sector: m.sector, 
    content: m.content, 
    score: Number(m.finalScore.toFixed(2)) 
  }))
};

// 2. Send the custom SSE event. Note the \n\n at the end!
const traceDataString = JSON.stringify(tracePayload);
res.write(`event: codecortex_trace\ndata: ${traceDataString}\n\n`);

// 3. Close the stream
res.end();
