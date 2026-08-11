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
export function resolveUpstream(model: string): Upstream {
  const local = providerCfg("local")!;
  const routesRaw = process.env.EG_PROXY_ROUTES || "";
  if (!routesRaw) return local;
  let routes: Record<string, string>;
  try {
    routes = JSON.parse(routesRaw);
  } catch {
    return local;
  }
  const prefix =
    Object.keys(routes)
      .filter((p) => p && model.startsWith(p))
      .sort((a, b) => b.length - a.length)[0] || "";
  const provider = (routes[prefix] || routes[""] || "").trim() || "local";
  return providerCfg(provider) || local;
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
