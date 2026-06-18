/*
 - filename: packages/engram-js/src/utils/rollingLog.ts
 - what is the file used for: Rolling log file writer — appends lines, keeps max N lines, truncates oldest on each write.
 */

import fs from "node:fs";
import path from "node:path";

const LOG_FILE = process.env.EG_LOG_FILE || path.resolve(process.cwd(), "engram.log");
const MAX_LINES = parseInt(process.env.EG_LOG_MAX_LINES, 10) || 3000;

let initialized = false;

/** Ensure the log file exists (touch). */
function ensureFile() {
  if (initialized) return;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "", "utf-8");
  } catch { /* silently ignore — will fail on first write */ }
  initialized = true;
}

/**
 * Append a single line to the rolling log file.
 * After writing, truncates from the top so the file never exceeds MAX_LINES.
 */
export function appendLogLine(line: string) {
  ensureFile();
  try {
    fs.appendFileSync(LOG_FILE, line + "\n", "utf-8");
    truncateIfNeeded();
  } catch (err) {
    // Best-effort — never throw from a logging helper
    console.error(`[rollingLog] failed to write: ${err}`);
  }
}

/** Truncate the file from the top if it exceeds MAX_LINES. */
function truncateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    // Quick heuristic: count newlines via size estimate is expensive, so just read line count.
    const content = fs.readFileSync(LOG_FILE, "utf-8");
    const lineCount = (content.match(/\n/g) || []).length;
    if (lineCount > MAX_LINES) {
      const lines = content.split("\n");
      // Keep the last MAX_LINES entries (lines has one extra empty element at end from trailing \n)
      const keep = lines.filter((l, i) => i < lines.length - 1).slice(-MAX_LINES);
      fs.writeFileSync(LOG_FILE, keep.join("\n") + "\n", "utf-8");
    }
  } catch { /* best-effort */ }
}

/** Read all lines currently in the log file. */
export function read(): string[] {
  try {
    const content = fs.readFileSync(LOG_FILE, "utf-8");
    if (!content.trim()) return [];
    return content.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Truncate the log file to empty. */
export function clear(): void {
  try {
    fs.writeFileSync(LOG_FILE, "", "utf-8");
  } catch { /* best-effort */ }
}

export { LOG_FILE, MAX_LINES };
