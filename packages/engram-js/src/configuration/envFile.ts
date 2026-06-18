/*
 - filename: packages/engram-js/src/configuration/envfile.ts
 - what is the file used for: loads local .env files and strips inline comments safely
*/

import fs from "node:fs";
import path from "node:path";
import { logger } from "../utils/logger";

const val = (raw: string) => {
  const txt = raw.trim();
  let q: string | null = null;
  let end = txt.length;

  for (let i = 0; i < txt.length; i++) {
    const ch = txt[i];
    if ((ch === "'" || ch === '"') && (i === 0 || txt[i - 1] !== "\\")) q = q === ch ? null : q || ch;
    if (ch === "#" && q === null && (i === 0 || /\s/.test(txt[i - 1]))) {
      end = i;
      break;
    }
  }

  return txt.slice(0, end).trim().replace(/^['"](.*)['"]$/, "$1");
};

const load = (file: string) => {
  try {
    for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = val(m[2] || "");
    }
  } catch {
    // .env is optional; only warn on actual read errors (permission, broken filesystem)
    const exists = fs.existsSync(file);
    if (exists) {
      logger.warn({ module: 'config', file }, `Failed to load .env file that exists at ${file}`);
    }
  }
};

export const load_env_files = (base = __dirname) => {
  [
    path.resolve(process.cwd(), ".env"),
    path.resolve(base, "../../.env"),
    path.resolve(base, "../../../.env"),
    path.resolve(base, "../../../../.env"),
  ].forEach(load);
};
