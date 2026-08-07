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
import { integrityEngine } from "../services/integrityEngine";
import { enrichmentEngine } from "../services/enrichmentEngine";
import { candidateProcessor } from "../services/candidateProcessor";
import { loadSettings, seedSettingsFromEnv } from "../services/settingsService";
import { run_migrations } from "../database/migrate";
import { logger } from "../utils/logger";
import { classifyActivity, recordActivity, deriveBreakdown } from "./activity";
import { persistTrace, isTraceableRoute } from "../services/traceStore";
import { maybeAutoScore } from "../services/traceScorer";
import * as crypto from "crypto";

export function createApp() {
  const app = createHttpApp({ max_payload_size: env.max_payload_size });

  // Request logging middleware — structured via Pino (debug level to avoid flooding logs)
   app.use((req: any, res: any, next: any) => {
     const startedAt = Date.now();
     logger.debug({ method: req.method, url: req.url, module: 'http' }, `${req.method} ${req.url}`);

     // Collect the response body so we can show the actual memory that was
     // saved (write) or the memories that were retrieved (read).
     let responseChunks: Buffer[] = [];
     const origWrite = res.write.bind(res);
     const origEnd = res.end.bind(res);
     res.write = function (...args: any[]) {
       const chunk = args[0];
       if (chunk && typeof chunk !== 'function') {
         try { responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); } catch { /* ignore */ }
       }
       return origWrite(...args);
     };
     res.end = function (...args: any[]) {
       const status = res.statusCode;
       const ms = Date.now() - startedAt;
       // Capture the response body (json() sends it via res.end, not res.write)
       const endChunk = args[0];
       if (endChunk != null && typeof endChunk !== "function") {
         try {
           responseChunks.push(
             Buffer.isBuffer(endChunk) ? endChunk : Buffer.from(String(endChunk)),
           );
         } catch { /* ignore */ }
       }
       logger.debug({ method: req.method, url: req.url, status, module: 'http' }, `${req.method} ${req.url} → ${status}`);

       // Capture memory traffic for the Activity view (writes in / reads out)
       const cls = classifyActivity(req.method, req.url);
       if (cls) {
         const body = req.body || {};
         let payload: string | undefined;
         let respJson: any = null;
         try {
           const respText = Buffer.concat(responseChunks).toString("utf8");
           respJson = respText ? JSON.parse(respText) : null;
         } catch {
           respJson = null;
         }
         if (cls.kind === "write") {
           // Saved memory: prefer explicit content, else summarize the body.
           if (typeof body.content === "string") payload = body.content;
           else if (typeof body.text === "string") payload = body.text;
           else if (Array.isArray(body.memories) && body.memories.length)
             payload = body.memories.map((m: any) => m?.content ?? m?.text ?? "").filter(Boolean).join("\n");
           else payload = JSON.stringify(body).slice(0, 400);
         } else {
           // Retrieved memory: parse the response for the returned results.
           const results = respJson?.results || respJson?.memories || [];
           if (Array.isArray(results) && results.length) {
             payload = results
               .map((r: any) => (typeof r === "string" ? r : r?.content ?? r?.text ?? ""))
               .filter(Boolean)
               .join("\n");
           } else {
             // fall back to the query so the row isn't empty
             payload = typeof body.query === "string" ? `query: ${body.query}` : undefined;
           }
         }
         recordActivity({
           ts: Date.now(),
           direction: cls.direction,
           kind: cls.kind,
           label: cls.label,
           route: req.url.split("?")[0],
           method: req.method,
           status,
           ms,
           summary: (typeof payload === "string" ? payload : "").slice(0, 200),
           payload:
             typeof payload === "string" && payload.length > 200
               ? payload.slice(0, 4000)
               : payload,
           count:
             cls.kind === "write"
               ? undefined
               : (() => {
                   // Shaped cognitive-context response: count = genome + phenotype.
                   if (
                     typeof respJson?.genome_count === "number" ||
                     typeof respJson?.phenotype_count === "number"
                   )
                     return (
                       (Number(respJson?.genome_count) || 0) +
                       (Number(respJson?.phenotype_count) || 0)
                     );
                   const results =
                     respJson?.results || respJson?.memories || [];
                   return Array.isArray(results) ? results.length : undefined;
                 })(),
           breakdown: deriveBreakdown(cls, body, respJson),
           user_id: typeof body.user_id === "string" ? body.user_id : undefined,
           });
       }

       // ── Persistent trace store (v4.2.0-traces) ──
       // Fire-and-forget capture of the memory/agent loop with full bodies
       // (regex-redacted), breakdown, and injection stats. Never blocks the
       // response; failures only log. Runs regardless of auth — the auth
       // middleware sits AFTER this one.
       if (isTraceableRoute(req.method, req.url)) {
         const body = req.body || {};
         let respText: string | undefined;
         let respJson: any = null;
         try {
           respText = Buffer.concat(responseChunks).toString("utf8");
           if (respText) respJson = JSON.parse(respText);
         } catch {
           respJson = null;
         }
         const clsT = classifyActivity(req.method, req.url);
         const isChat = req.url.startsWith("/v1/chat/completions");
         const direction = clsT?.direction || (isChat ? "chat" : "system");
         const kind = clsT?.kind || (isChat ? "chat" : "action");
         const label = clsT?.label || (isChat ? "chat" : "action");
         const injection =
           respJson &&
           (typeof respJson.genome_count === "number" || typeof respJson.phenotype_count === "number")
             ? {
                 genome: Number(respJson.genome_count) || 0,
                 phenotype: Number(respJson.phenotype_count) || 0,
                 web_used: !!respJson.web_used,
               }
             : undefined;
         const traceRec = {
           id: crypto.randomUUID(),
           ts: Date.now(),
           route: req.url.split("?")[0],
           method: req.method,
           status,
           ms,
           direction,
           kind,
           label,
           sessionId: typeof body.session_id === "string" ? body.session_id : undefined,
           projectId: typeof body.project_id === "string" ? body.project_id : undefined,
           userId: typeof body.user_id === "string" ? body.user_id : undefined,
           model: typeof body.model === "string" ? body.model : undefined,
           requestBody: body,
           responseBody: respJson || respText,
           breakdown: clsT ? deriveBreakdown(clsT, body, respJson) : undefined,
           injection,
           error: status >= 400 ? (respText || "").slice(0, 500) : undefined,
         };
         persistTrace(traceRec);
         maybeAutoScore(traceRec);
       }

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
  // Validate configuration before starting
  validateEnv();

  // Run database migrations before starting the server
  try {
    await run_migrations();
  } catch (err) {
    logger.error({ module: 'server' }, `Migration failed, but continuing: ${err}`);
  }

  // Load runtime settings (Settings tab = single source of truth for providers/models)
  try {
    await loadSettings();
    await seedSettingsFromEnv();
  } catch (err) {
    logger.error({ module: 'server' }, `Settings load failed, but continuing: ${err}`);
  }

  const app = createApp();

  // 🧠 START THE HIPPOCAMPUS — background consolidation cron (deferred to avoid startup crash)
  setTimeout(() => { consolidationEngine.start?.(); }, 2000);
  // 🛡️ START THE INTEGRITY ENGINE — memory auto-heal (respects EG_INTEGRITY_ENABLED)
  setTimeout(() => { integrityEngine.start?.(); }, 4000);
  // ✨ START THE ENRICHMENT ENGINE — memory optimization (respects EG_ENRICHMENT_ENABLED)
  setTimeout(() => { enrichmentEngine.start?.(); }, 6000);
  // 🧹 START THE CANDIDATE PROCESSOR — drains the extraction-candidates queue
  setTimeout(() => { candidateProcessor.start?.(); }, 45000);

  logger.info({ module: 'server', port: env.port }, `Starting on port ${env.port}`);
  app.listen(env.port, () => {
    logger.info({ module: 'server' }, `Running on http://localhost:${env.port}`);
    send_telemetry().catch(() => {});
  });

  return app;
}
