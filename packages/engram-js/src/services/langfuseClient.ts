import { Langfuse } from "langfuse";
import { env } from "../configuration";

let client: Langfuse | null = null;
let lastEnvSecretKey = "";
let lastEnvPublicKey = "";
let lastEnvHost = "";
let lastEnvEnabled = false;

export function getLangfuse(): Langfuse | null {
  if (!env.langfuse_enabled) return null;
  if (!env.langfuse_secret_key || !env.langfuse_host) return null;

  const envChanged =
    lastEnvSecretKey !== env.langfuse_secret_key ||
    lastEnvPublicKey !== env.langfuse_public_key ||
    lastEnvHost !== env.langfuse_host ||
    lastEnvEnabled !== env.langfuse_enabled;

  if (envChanged || !client) {
    client = new Langfuse({
      secretKey: env.langfuse_secret_key,
      publicKey: env.langfuse_public_key,
      baseUrl: env.langfuse_host,
    });
    lastEnvSecretKey = env.langfuse_secret_key;
    lastEnvPublicKey = env.langfuse_public_key;
    lastEnvHost = env.langfuse_host;
    lastEnvEnabled = env.langfuse_enabled;
  }
  return client;
}

export function createTrace(name: string, metadata?: Record<string, unknown>) {
  const lf = getLangfuse();
  if (!lf) return null;
  return lf.trace({ name, metadata });
}

export function resetLangfuse(): void {
  client = null;
}