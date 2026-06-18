/*
 - filename: packages/engram-js/src/api/index.ts
 - what is the file used for: creates and starts the engram http server app
*/

import { env } from "../configuration/index";
import { routes } from "./routes";
import {
  authenticate_api_request,
  log_authenticated_request,
} from "./middleware/auth";
import { send_telemetry } from "../configuration/telemetry";
import { createHttpApp } from "./httpApp";
import { consolidationEngine } from "../services/consolidationEngine";
import { run_migrations } from "../database/migrate";
import { appendLogLine as rollingLog } from "../utils/rollingLog";

export function createApp() {
  const app = createHttpApp({ max_payload_size: env.max_payload_size });

  // Rolling log middleware — records every request/response to the log file
  app.use((req: any, res: any, next: any) => {
    rollingLog(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    
    const origEnd = res.end.bind(res);
    res.end = function (...args: any[]) {
      rollingLog(
        `[${new Date().toISOString()}] ${req.method} ${req.url} → ${res.statusCode}`,
      );
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

export async function startServer() {
  // Run database migrations before starting the server
  try {
    await run_migrations();
  } catch (err) {
    console.error("[SERVER] Migration failed, but continuing:", err);
  }

  const app = createApp();

  // 🧠 START THE HIPPOCAMPUS — background consolidation cron (deferred to avoid startup crash)
  setTimeout(() => { consolidationEngine.start?.(); }, 2000);

  console.log(`[SERVER] Starting on port ${env.port}`);
  app.listen(env.port, () => {
    console.log(`[SERVER] Running on http://localhost:${env.port}`);
    send_telemetry().catch(() => {});
  });

  return app;
}
