/*
 - filename: packages/engram-js/src/database/models.ts
 - what is the file used for: resolves embedding model names from .env vars with hardcoded defaults as fallback
*/

interface model_cfg {
  [facet: string]: Record<string, string>;
}
let cfg: model_cfg | null = null;

export const load_models = (): model_cfg => {
  if (cfg) return cfg;

  // Build config from .env vars — starts with hardcoded defaults, then env overrides apply
  const facets = ["episodic", "semantic", "procedural", "emotional", "reflective"];
  const providers = ["ollama", "openai", "gemini", "aws", "siray", "local"];

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
      // Fallback to hardcoded defaults
      cfg[facet][provider] = get_defaults()[facet]?.[provider] || "bge-m3";
    }
  }

  console.error("[MODELS] Using env-based model configuration");
  return cfg;
};

const get_defaults = (): model_cfg => ({
  episodic: {
    ollama: "bge-m3",
    openai: "text-embedding-3-small",
    gemini: "models/gemini-embedding-001",
    aws: "amazon.titan-embed-text-v2:0",
    siray: "text-embedding-3-small",
    local: "bge-m3",
  },
  semantic: {
    ollama: "bge-m3",
    openai: "text-embedding-3-small",
    gemini: "models/gemini-embedding-001",
    aws: "amazon.titan-embed-text-v2:0",
    siray: "text-embedding-3-small",
    local: "bge-m3",
  },
  procedural: {
    ollama: "nomic-embed-text",
    openai: "text-embedding-3-small",
    gemini: "models/gemini-embedding-001",
    aws: "amazon.titan-embed-text-v2:0",
    local: "bge-m3",
  },
  emotional: {
    ollama: "all-MiniLM-L6-v2",
    openai: "text-embedding-3-small",
    gemini: "models/gemini-embedding-001",
    aws: "amazon.titan-embed-text-v2:0",
    local: "bge-m3",
  },
  reflective: {
    ollama: "bge-m3",
    openai: "text-embedding-3-small",
    gemini: "models/gemini-embedding-001",
    aws: "amazon.titan-embed-text-v2:0",
    local: "bge-m3",
  },
});

const env_key = (provider: string, facet?: string) =>
  ["OM", provider, facet, "MODEL"]
    .filter(Boolean)
    .join("_")
    .replace(/[^A-Z0-9_]/gi, "_")
    .toUpperCase();

export function resolveEmbeddingModel(
  facet: string,
  provider: string,
  options: {
    env?: Record<string, string | undefined>;
    models?: model_cfg;
  } = {},
): string {
  const env = options.env || process.env;
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedFacet = facet.trim().toLowerCase();
  const facetOverride =
    env[env_key(normalizedProvider, normalizedFacet)] ||
    env[
      `EG_${normalizedProvider.toUpperCase()}_${normalizedFacet.toUpperCase()}_MODEL`
    ];
  if (facetOverride) return facetOverride;

  const providerOverride =
    env[env_key(normalizedProvider)] ||
    env[`EG_${normalizedProvider.toUpperCase()}_MODEL`];
  if (providerOverride) return providerOverride;

  if (env.EG_EMBED_MODEL) return env.EG_EMBED_MODEL;

  const cfg = options.models || load_models();
  return (
    cfg[normalizedFacet]?.[normalizedProvider] ||
    cfg.semantic?.[normalizedProvider] ||
    cfg.semantic?.openai ||
    "bge-m3"
  );
}

export const get_model = (facet: string, provider: string): string =>
  resolveEmbeddingModel(facet, provider);
