/*
 - filename: packages/engram-js/src/utils/logger.ts
 - what is the file used for: Centralized high-performance JSON logger using Pino. Outputs structured NDJSON in production (Docker) and colorized pretty output locally. Optimized for Grafana Loki ingestion.
 */

import pino from 'pino';
import fs from "node:fs";
import path from "node:path";

const isProduction = process.env.EG_NODE_ENV === 'production' || process.env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  
  formatters: {
    level: (label: string) => ({ level: label }),
  },
  
  // Always use pretty transport for readable output.
  // Set EG_PINO_PRETTY=false to disable and get raw JSON instead.
  transport: process.env.EG_PINO_PRETTY === 'false'
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

// ── Rolling log file (EG_LOG_FILE + EG_LOG_MAX_LINES) ────────────────────────

const LOG_FILE = process.env.EG_LOG_FILE || "";
const MAX_LINES = parseInt(process.env.EG_LOG_MAX_LINES || "3000", 10);

if (LOG_FILE) {
  const logDir = path.dirname(LOG_FILE);
  if (logDir && logDir !== ".") fs.mkdirSync(logDir, { recursive: true });

  let buffer: string[] = [];
  let dirty = false;

  function flush() {
    if (!dirty || buffer.length === 0) return;
    try {
      const tail = buffer.slice(-MAX_LINES).join("\n") + "\n";
      fs.writeFileSync(LOG_FILE, tail);
    } catch {}
    buffer = [];
    dirty = false;
  }

  // Write every line to disk (debounced via flush on idle)
  function append(line: string) {
    buffer.push(line);
    if (!dirty) {
      dirty = true;
      setImmediate(flush);
    }
  }

  // Hook into pino's built-in sink so we capture everything Pino emits.
  // Pino calls `logger.write()` for each log record — intercept it.
  const originalWrite = logger.write.bind(logger);
  logger.write = (record: any) => {
    try {
      append(JSON.stringify(record));
    } catch {}
    return originalWrite(record);
  };

  // Graceful shutdown: flush remaining buffer
  process.on("exit", () => flush());
}
