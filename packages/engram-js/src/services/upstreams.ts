/*
 - filename: packages/engram-js/src/services/upstreams.ts
 - what is the file used for: shared upstream resolution for the
   /v1/chat/completions smart proxy + /v1/models listing. Reads the same
   env vars the GUI "Proxy / Upstreams" settings mirror into process.env:
   EG_PROXY_ROUTES (JSON {model-prefix → provider}), EG_UPSTREAM_LLM_URL /
   EG_UPSTREAM_LLM_API_KEY (default), EG_OPENROUTER_BASE_URL / _API_KEY,
   EG_NOUS_BASE_URL / _API_KEY, or custom provider N → EG_N_BASE_URL / _API_KEY.
*/

import { env } from "../configuration";

export interface Upstream {
  url: string;
  key: string;
}

/** Resolve a named provider ("local" | "openrouter" | "nous" | custom N). */
export function providerCfg(name: string): Upstream | null {
  const p = (name || "").trim();
  if (!p || p.toLowerCase() === "local") {
    return {
      url: process.env.EG_UPSTREAM_LLM_URL || env.openai_base_url || "",
      key: process.env.EG_UPSTREAM_LLM_API_KEY || env.openai_key || "",
    };
  }
  if (p.toLowerCase() === "openrouter") {
    return {
      url: process.env.EG_OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      key: process.env.EG_OPENROUTER_API_KEY || "",
    };
  }
  if (p.toLowerCase() === "nous") {
    return {
      url: process.env.EG_NOUS_BASE_URL || "https://inference-api.nousresearch.com/v1",
      key: process.env.EG_NOUS_API_KEY || "",
    };
  }
  // Custom provider: name N → env EG_N_BASE_URL / EG_N_API_KEY (case-insensitive).
  const up = p.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const url = process.env[`EG_${up}_BASE_URL`] || "";
  const key = process.env[`EG_${up}_API_KEY`] || "";
  return url ? { url, key } : null;
}

/** Resolve the upstream for a requested model id (longest prefix wins). */
export function resolveUpstream(model: string): Upstream & { provider: string } {
  const local = providerCfg("local")!;
  const routesRaw = process.env.EG_PROXY_ROUTES || "";
  if (!routesRaw) return { ...local, provider: "local" };
  let routes: Record<string, string>;
  try {
    routes = JSON.parse(routesRaw);
  } catch {
    return { ...local, provider: "local" };
  }
  const prefix =
    Object.keys(routes)
      .filter((p) => p && model.startsWith(p))
      .sort((a, b) => b.length - a.length)[0] || "";
  const provider = (routes[prefix] || routes[""] || "").trim() || "local";
  const cfg = providerCfg(provider);
  return cfg ? { ...cfg, provider } : { ...local, provider: "local" };
}

/** Unique provider names referenced by the routes map (plus "local"). */
export function configuredProviders(): string[] {
  const names = new Set<string>(["local"]);
  const routesRaw = process.env.EG_PROXY_ROUTES || "";
  if (routesRaw) {
    try {
      const routes = JSON.parse(routesRaw);
      for (const v of Object.values(routes)) {
        if (typeof v === "string" && v.trim()) names.add(v.trim());
      }
    } catch {
      /* ignore malformed routes */
    }
  }
  return [...names];
}

// ── Upstream model catalogs (shared by /v1/models and id resolution) ────

let _modelCache: { at: number; byProvider: Map<string, string[]> } = {
  at: 0,
  byProvider: new Map(),
};
const MODEL_TTL_MS = 60_000;

/** Fetch (and cache) the model id list a provider actually serves. */
export async function upstreamModelIds(provider: string): Promise<string[]> {
  const now = Date.now();
  if (now - _modelCache.at > MODEL_TTL_MS) {
    _modelCache = { at: now, byProvider: new Map() };
  }
  if (_modelCache.byProvider.has(provider)) return _modelCache.byProvider.get(provider)!;
  const cfg = providerCfg(provider);
  let ids: string[] = [];
  if (cfg && cfg.url) {
    const headers: Record<string, string> = { "User-Agent": "engram-proxy" };
    if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(`${cfg.url.replace(/\/+$/, "")}/models`, { headers, signal: ctrl.signal });
      if (r.ok) {
        const d = (await r.json()) as { data?: Array<{ id?: string }> };
        ids = (d.data || []).map((m) => (m.id || "").trim()).filter(Boolean);
      }
    } catch {
      /* provider unreachable — treat as empty */
    } finally {
      clearTimeout(t);
    }
  }
  _modelCache.byProvider.set(provider, ids);
  return ids;
}

/**
 * Resolve the exact id to forward for a requested model: pass through when
 * the id exists on the target provider; otherwise unique suffix match
 * ("deepseek-v4-flash-0731" → "deepseek/deepseek-v4-flash-0731"). This is
 * what lets clients that send short/friendly ids work through the proxy.
 * Ambiguous or unknown ids pass through unchanged (upstream answers).
 */
export async function resolveUpstreamModel(model: string, provider: string): Promise<string> {
  const exact = await upstreamModelIds(provider);
  if (exact.includes(model)) return model;
  const suffix = `/${model}`;
  const matches = exact.filter((id) => id.endsWith(suffix));
  if (matches.length === 1) return matches[0];
  return model;
}
