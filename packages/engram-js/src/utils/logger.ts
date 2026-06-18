/*
 - filename: packages/engram-js/src/utils/logger.ts
 - what is the file used for: Centralized Pino logger — pretty stdout + NDJSON file.
    Exports readLog() / clearLog() for the dashboard API.
 */

import pino from 'pino';
import fs from "node:fs";
import path from "node:path";

// ── Log file path ──────────────────────────────────────────────────────────────

const LOG_DIR = process.env.EG_LOG_DIR || path.resolve(process.cwd(), "..", "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "engram.log");
const MAX_LINES = parseInt(process.env.EG_LOG_MAX_LINES || "3000", 10);

// ── Pino logger with multi-stream (stdout pretty + file NDJSON) ────────────────

const prettyStream = pino.transport({
  target: 'pino-pretty',
  options: {
    colorize: true,
    translateTime: 'SYS:standard',
    ignore: 'pid,hostname',
  },
});

// Ensure directory exists BEFORE opening file stream
const fileStreamAvailable = (() => {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const stream = pino.destination({ dest: LOG_FILE, sync: true });
    return stream;
  } catch {
    console.warn(`[logger] Cannot write to ${LOG_FILE} — file logging disabled`);
    return null;
  }
})();

const streams = [
  { stream: prettyStream, level: 'info' },
];
if (fileStreamAvailable) {
  streams.push({ stream: fileStreamAvailable, level: 'info' });
}

const multi = pino.multistream(streams);

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',

  formatters: {
    level: (label: string) => ({ level: label }),
  },
}, multi);

// ── File helpers for dashboard API ─────────────────────────────────────────────

/** Read all lines from the log file, keeping only the last MAX_LINES. */
export function readLog(): string[] {
  try {
    const content = fs.readFileSync(LOG_FILE, "utf-8");
    if (!content.trim()) return [];
    const lines = content.split("\n").filter(Boolean);
    // Truncate to MAX_LINES on disk if it grew too large
    if (lines.length > MAX_LINES) {
      fs.writeFileSync(LOG_FILE, lines.slice(-MAX_LINES).join("\n") + "\n", "utf-8");
      return lines.slice(-MAX_LINES);
    }
    return lines;
  } catch {
    return [];
  }
}

/** Truncate the log file to empty. */
export function clearLog(): void {
  try {
    fs.writeFileSync(LOG_FILE, "", "utf-8");
  } catch { /* best-effort */ }
}

/** Parse a single NDJSON log line into a structured object. */
export function parseLogLine(line: string): {
  level: string;
  time: string;
  msg: string;
  module?: string;
  [key: string]: any;
} | null {
  try {
    const parsed = JSON.parse(line);
    return {
      level: parsed.level ? getLevelLabel(parsed.level) : "unknown",
      time: parsed.time || new Date().toISOString(),
      msg: parsed.msg || "",
      module: parsed.module,
      raw: parsed,
    };
  } catch {
    // Not JSON — return as plain message
    return { level: "info", time: "", msg: line };
  }
}

function getLevelLabel(code: number): string {
  const map: Record<number, string> = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };
  return map[code] || "unknown";
}
