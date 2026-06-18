/*
 - filename: packages/engram-js/src/configuration/telemetry.ts
 - what is the file used for: sends the optional one-shot startup telemetry payload
*/

import os from "node:os";
import { env } from "./index";

const off = (process.env.EG_TELEMETRY ?? "").toLowerCase() === "false";
const ver = (): string => {
  if (process.env.npm_package_version) return process.env.npm_package_version;
  try {
    const pkg = require("../../package.json");
    if (pkg?.version) return pkg.version;
  } catch {}
  return "unknown";
};

export const send_telemetry = async () => {
  if (off) return;
  try {
    const ram = Math.round(os.totalmem() / (1024 * 1024));
    const payload = {
      name: os.hostname(),
      os: os.platform(),
      embeddings: env.emb_kind || "ollama",
      metadata: "postgres",
      version: ver(),
      ram,
      storage: ram * 4,
      cpu: os.cpus()?.[0]?.model || "unknown",
    };
    const res = await fetch("https://telemetry.spotit.dev", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    });
    await res.arrayBuffer().catch(() => undefined);
  } catch {}
};
