Here is the step-by-step guide to implementing production-ready, Grafana-optimized logging in Engram.

---

### Step 1: Install a High-Performance JSON Logger
We will use **`pino`**. It is the industry standard for Node.js because it has near-zero overhead and outputs perfect NDJSON by default.

Run this in your `packages/engram-js` directory:
```bash
npm install pino
npm install -D pino-pretty # Only for local development readability
```

---

### Step 2: Create a Centralized Logger Utility
Create a new file: `packages/engram-js/src/utils/logger.ts`

This logger will automatically detect if it's running in Docker (production) and output pure JSON, or if it's running locally and output beautiful, colorized text.

```typescript
import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino({
  // Default to 'info', but allow override via .env (e.g., LOG_LEVEL=debug)
  level: process.env.LOG_LEVEL || 'info',
  
  // Format the level as a string (e.g., "info", "error") instead of a number for easier Loki querying
  formatters: {
    level: (label) => {
      return { level: label };
      },
  },
  
  // In production (Docker), output raw JSON to stdout.
  // In development, use pino-pretty for readable terminal output.
  transport: isProduction
    ? undefined 
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
});
```

---

### Step 3: Define a Consistent Log Schema
Whenever you log something, pass an **object** as the first argument (for structured metadata) and a **string** as the second argument (the human-readable message). 

**Good Log Schema:**
```json
{
  "level": "info",
  "time": 1718472000000,
  "msg": "Triggering context compaction",
  "module": "compactionEngine",
  "model": "qwen2.5:7b",
  "oldMessageCount": 15,
  "newMessageCount": 6
}
```

---

### Step 4: Update Your Existing Code
Replace all `console.log`, `console.warn`, and `console.error` statements with the new logger. 

**Example 1: In `compactionEngine.ts`**
```typescript
import { logger } from '../utils/logger';

// OLD:
// console.log(`[Engram] ⚙️ Triggering context compaction. Thinning ${oldMessages.length} old messages...`);

// NEW:
logger.info(
  { module: 'compactionEngine', oldMessageCount: oldMessages.length, model: COMPACTION_MODEL },
  'Triggering context compaction'
);

// OLD:
// console.error("[Engram] ❌ Compaction summarization/extraction failed:", error);

// NEW:
logger.error(
  { module: 'compactionEngine', err: error }, // 'err' is a special pino key that formats stack traces perfectly
  'Compaction summarization/extraction failed'
);
```

**Example 2: In `route.ts`**
```typescript
import { logger } from '../../utils/logger';

// OLD:
// console.log(`[Engram] 🧠 Recall: genome=${genomeMemories.length} phenotype=${phenotypeMemories.length}`);

// NEW:
logger.debug(
  { module: 'chatRoute', action: 'memory_recall', genomeCount: genomeMemories.length, phenotypeCount: phenotypeMemories.length },
  'Memory recall completed'
);

// OLD:
// console.error("[Engram] Proxy Error:", error);

// NEW:
logger.error(
  { module: 'chatRoute', err: error, model: body.model },
  'Proxy request failed'
);
```

---

### Step 5: Grafana Loki Configuration (The Magic)
Because your logs are now structured JSON, Grafana Loki can parse them automatically without you writing complex regex. 

In your Grafana LogQL queries, you can now do incredibly powerful, instant filtering:

**1. Find all compaction errors:**
```logql
{container="engram-proxy"} | json | level="error" and module="compactionEngine"
```

**2. See how long extraction takes (if you add a `durationMs` field to your logs):**
```logql
{container="engram-proxy"} | json | module="memoryLogger" | line_format "{{.msg}} took {{.durationMs}}ms"
```

**3. Count memories saved per model:**
```logql
sum by (model) (count_over_time({container="engram-proxy"} | json | msg="Compaction extracted and saved new phenotype memories" [24h]))
```

---

### Step 6: Add `.env` Control
Add this to your `.env` file so you can dynamically change log verbosity without rebuilding the container:

```env
# Log levels: fatal, error, warn, info, debug, trace
LOG_LEVEL=info
NODE_ENV=production
```

### Summary of Benefits
1. **Zero Regex in Grafana**: Loki natively understands the JSON, making queries instant.
2. **Perfect Stack Traces**: Pino's `err` object formatting ensures multi-line Node.js stack traces don't break the JSON structure (a common pain point with `console.error`).
3. **Local Dev Friendliness**: You still get beautiful, colorized, readable logs in your local terminal thanks to `pino-pretty`.
4. **Easy Dashboarding**: You can instantly build Grafana panels that count errors by `module` or track `model` usage over time.