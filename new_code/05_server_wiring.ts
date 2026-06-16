import express from 'express';
import { memoryInjector } from './services/memoryInjector';
import { consolidationEngine } from './services/consolidationEngine';
// ... other imports

const app = express();
app.use(express.json());

// ... your routes (including the new /v1/chat/completions proxy) ...

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`🚀 Engram Proxy running on http://localhost:${PORT}`);
  
  // 🧠 START THE HIPPOCAMPUS
  consolidationEngine.start();
  
  console.log('🧠 Cognitive Consolidation Engine initialized.');
});
