/*
 - filename: packages/engram-js/src/database/models.ts
 - what is the file used for: resolves embedding model names from .env vars with config-driven defaults as fallback — no hardcoded models
*/

import { env } from "../configuration/index";
import { resolveEmbeddingModel as registryResolveEmbeddingModel } from "./modelRegistry";

interface model_cfg {
  [facet: string]: Record<string, string>;
}
let cfg: model_cfg | null = null;

export const load_models = (): model_cfg => {
  if (cfg) return cfg;

  // Build config from .env vars — starts with env-driven defaults, then env overrides apply
  const facets = ["episodic", "semantic", "procedural", "emotional", "reflective"];
  const providers = ["openai", "gemini", "aws", "siray", "local"];

  cfg = {};
  for (const facet of facets) {
    cfg[facet] = {};
    for (const provider of providers) {
      // Per-facet, per-provider override: EG_<PROVIDER>_<FACET>_MODEL
      const facetKey = `EG_${provider.toUpperCase()}_${facet.toUpperCase()}_MODEL`;
      if (process.env[facetKey]) {
        cfg[facet][provider] = process.env[facetKey];
        continue;
      }
      // Per-provider override: EG_<PROVIDER>_MODEL
      const providerKey = `EG_${provider.toUpperCase()}_MODEL`;
      if (process.env[providerKey]) {
        cfg[facet][provider] = process.env[providerKey];
        continue;
      }
      // Env-driven per-facet default: EG_MODEL_EMBED_<FACET>
      const facetEnvVar = `EG_MODEL_EMBED_${facet.toUpperCase()}`;
      if (process.env[facetEnvVar]) {
        cfg[facet][provider] = process.env[facetEnvVar];
        continue;
      }
      // Provider-level default (config-driven)
      cfg[facet][provider] = registryResolveEmbeddingModel(facet as any);
    }
  }

  console.error("[MODELS] Using env-based model configuration");
  return cfg;
};

export function resolveEmbeddingModel(
  facet: string,
  provider: string,
  options: {
    env?: Record<string, string | undefined>;
    models?: model_cfg;
  } = {},
): string {
  const env_ = options.env || process.env;
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedFacet = facet.trim().toLowerCase();
  const facetOverride =
    env_[
      `EG_${normalizedProvider.toUpperCase()}_${normalizedFacet.toUpperCase()}_MODEL`
    ];
  if (facetOverride) return facetOverride;

  const providerOverride =
    env_[`EG_${normalizedProvider.toUpperCase()}_MODEL`];
  if (providerOverride) return providerOverride;

  const cfg_ = options.models || load_models();
  // Fallback chain: facet → semantic → openai → universal default
  return (
    cfg_[normalizedFacet]?.[normalizedProvider] ||
    cfg_.semantic?.[normalizedProvider] ||
    cfg_.semantic?.openai ||
    registryResolveEmbeddingModel(normalizedFacet as any)   // registry: Settings → env → fail
  );
}

export const get_model = (facet: string, provider: string): string =>
  resolveEmbeddingModel(facet, provider);
