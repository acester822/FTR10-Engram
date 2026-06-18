/*
 - filename: packages/engram-js/src/api/index.ts
 - what is the file used for: creates and starts the engram http server app
*/

import { env, validateEnv } from "../configuration/index";
import { routes } from "./routes";
import {
  authenticate_api_request,
  log_authenticated_request,
} from "./middleware/auth";
import { send_telemetry } from "../configuration/telemetry";
import { createHttpApp } from "./httpApp";
import { consolidationEngine } from "../services/consolidationEngine";
import { run_migrations } from "../database/migrate";
import { logger } from "../utils/logger";
import { embed } from "../embeddings/embed";

export function createApp() {
  const app = createHttpApp({ max_payload_size: env.max_payload_size });

  // Request logging middleware — structured via Pino (debug level to avoid flooding logs)
   app.use((req: any, res: any, next: any) => {
     logger.debug({ method: req.method, url: req.url, module: 'http' }, `${req.method} ${req.url}`);

     const origEnd = res.end.bind(res);
     res.end = function (...args: any[]) {
       logger.debug({ method: req.method, url: req.url, status: res.statusCode, module: 'http' }, `${req.method} ${req.url} → ${res.statusCode}`);
       return origEnd(...args);
     };

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type,Authorization,x-api-key",
    );
    if (req.method === "OPTIONS") {
      res.status(200).end();
      return;
    }
    next();
  });

  app.use(authenticate_api_request);

  if (process.env.EG_LOG_AUTH === "true") {
    app.use(log_authenticated_request);
  }

  routes(app);

  return app;
}

/**
 * Pre-load the embedding model on boot so the first user request isn't subject
 * to Ollama's cold-start model-load latency. Non-fatal — if Ollama is down,
 * embeddings will fall back through the provider chain at runtime.
 */
async function warmupEmbedding(): Promise<void> {
  if (env.emb_kind !== "ollama") {
    logger.debug({ module: 'warmup', provider: env.emb_kind }, 'Skipping embedding warmup (non-Ollama provider)');
    return;
  }

  const model = env.embed_model_primary;
  try {
    // First check if Ollama is reachable and has the model
    const tagsRes = await fetch(`${env.ollama_url}/api/tags`);
    if (!tagsRes.ok) {
      logger.warn({ module: 'warmup', status: tagsRes.status }, `Ollama returned ${tagsRes.status} — skipping warmup`);
      return;
    }

    const body: any = await tagsRes.json();
    const available = body.models?.some(
      (m: any) => m.name === model || m.name.startsWith(model),
    );

    if (!available) {
      logger.warn({ module: 'warmup', model }, `Embedding model "${model}" not found in Ollama — will load lazily on first request`);
      return;
    }

    // Send a tiny dummy embedding to force model load
    const start = Date.now();
    await embed("_warmup_");
    const elapsed = Date.now() - start;
    logger.info({ module: 'warmup', model, elapsedMs: elapsed }, `Embedding model "${model}" warmed up in ${elapsed}ms`);
  } catch (err) {
    logger.warn({ module: 'warmup' }, `Ollama unreachable at ${env.ollama_url} — embeddings will fall back at runtime`);
  }
}

export async function startServer() {
  // Validate configuration before starting
  validateEnv();

  // Run database migrations before starting the server
  try {
    await run_migrations();
  } catch (err) {
    logger.error({ module: 'server' }, `Migration failed, but continuing: ${err}`);
  }

  // Warm up the embedding model so the first user request isn't cold
  await warmupEmbedding();

  const app = createApp();

  // 🧠 START THE HIPPOCAMPUS — background consolidation cron (deferred to avoid startup crash)
  setTimeout(() => { consolidationEngine.start?.(); }, 2000);

  logger.info({ module: 'server', port: env.port }, `Starting on port ${env.port}`);
  app.listen(env.port, () => {
    logger.info({ module: 'server' }, `Running on http://localhost:${env.port}`);
    send_telemetry().catch(() => {});
  });

  return app;
}
