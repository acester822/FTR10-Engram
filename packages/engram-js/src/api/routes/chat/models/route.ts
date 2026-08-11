/*
 - filename: packages/engram-js/src/api/routes/chat/models/route.ts
 - what is the file used for: GET /v1/models — OpenAI-compatible model list
   for the smart proxy. Merges the model lists of every configured upstream
   (local llama-swap, openrouter, nous, custom) so clients (Hermes, the
   VSCode ACP extension, Cline…) see what they can actually request through
   the proxy instead of a hardcoded default list. Cached 60s; resilient to
   upstream failures (a dead upstream is skipped, never fatal).
*/

import { providerCfg, configuredProviders } from "../../../../services/upstreams";
import { logger } from "../../../../utils/logger";

let _cache: { at: number; ids: string[] } | null = null;
const TTL_MS = 60_000;

async function fetchModels(url: string, key: string, timeoutMs = 8000): Promise<string[]> {
  const headers: Record<string, string> = { "User-Agent": "engram-proxy" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/models`, { headers, signal: ctrl.signal });
    if (!r.ok) return [];
    const d = (await r.json()) as { data?: Array<{ id?: string }> };
    return (d.data || []).map((m) => (m.id || "").trim()).filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

function toPayload(ids: string[]) {
  return {
    object: "list",
    data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: "engram-proxy" })),
  };
}

export const chat_models_route = (app: any) => {
  app.get("/v1/models", async (_req: any, res: any) => {
    try {
      if (_cache && Date.now() - _cache.at < TTL_MS) {
        return res.json(toPayload(_cache.ids));
      }
      const providers = configuredProviders();
      const results = await Promise.all(
        providers.map(async (p) => {
          const cfg = providerCfg(p);
          if (!cfg || !cfg.url) return [] as string[];
          const ids = await fetchModels(cfg.url, cfg.key);
          logger.info({ module: "chatModels", provider: p, count: ids.length }, "Fetched upstream models");
          return ids;
        }),
      );
      let ids = [...new Set(results.flat())].sort();
      if (!ids.length) {
        // Honest fallback: known models per route prefix + the local entries.
        ids = ["deepseek/deepseek-v4-flash-0731", "Qwen3-8B", "Qwen3.6-28B-REAP20"];
      }
      _cache = { at: Date.now(), ids };
      res.json(toPayload(ids));
    } catch (e: any) {
      res.status(500).json({ err: "models_failed", msg: e?.message || String(e) });
    }
  });
};
