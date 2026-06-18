/*
 - filename: packages/engram-js/src/configuration/index.ts
 - what is the file used for: central runtime environment parsing for the node server
*/

import { load_env_files } from "./envFile";
import { logger } from "../utils/logger";

load_env_files(__dirname);

const str = (v: string | undefined, d = "") => {
  const out = v?.trim();
  return out ? out : d;
};
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const bool = (v: string | undefined) => ["1", "true", "yes", "on"].includes(str(v).toLowerCase());

// ── Default model names — all models are configurable via EG_MODEL_* env vars ──

const DEFAULT_GENERATIVE_MODEL   = str(process.env.EG_MODEL_GENERATIVE,  "qwen3.5:2b");
const DEFAULT_GENERATIVE_FALLBACK = str(process.env.EG_MODEL_GENERATIVE_FALLBACK, "qwen2.5:3b");
const DEFAULT_EMBEDDING_MODEL    = str(process.env.EG_MODEL_EMBEDDING,   "qwen3-embedding:0.6b");
const DEFAULT_EMBEDDING_FACET    = (facet: string) => {
  const key = `EG_MODEL_EMBED_${facet.toUpperCase()}`;
  return str(process.env[key], DEFAULT_EMBEDDING_MODEL);
};
const DEFAULT_EMBEDDING_FALLBACK = str(process.env.EG_MODEL_EMBEDDING_FALLBACK, "bge-m3")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Validate required env vars at startup. Call before starting the server.
 * Throws on missing or invalid values so the process fails loud and early.
 */
export function validateEnv(): void {
  const errors: string[] = [];

  // Required for production-safe operation
  if (!process.env.EG_API_KEY && (bool(process.env.EG_REQUIRE_API_KEY) || process.env.NODE_ENV === "production")) {
    errors.push("EG_API_KEY is required when EG_REQUIRE_API_KEY is set or NODE_ENV=production");
  }

  // PostgreSQL
  if (!process.env.EG_PG_PASSWORD) {
    errors.push("EG_PG_PASSWORD is required for database connection");
  }
  if (!process.env.EG_PG_DB) {
    errors.push("EG_PG_DB is recommended — defaulting to 'engram'");
  }

  // Embedding dimension compatibility warning
  const vecDim = num(process.env.EG_VEC_DIM, 1536);
  if (vecDim < 128 || vecDim > 4096) {
    errors.push(`EG_VEC_DIM=${vecDim} is out of typical range (128-4096)`);
  }

  // Payload size limits
  const maxPayload = num(process.env.EG_MAX_PAYLOAD_SIZE, 1_000_000);
  if (maxPayload < 10_000 || maxPayload > 100_000_000) {
    errors.push(`EG_MAX_PAYLOAD_SIZE=${maxPayload} is suspiciously small or large`);
  }

  if (errors.length > 0) {
    for (const err of errors) {
      logger.warn({ module: 'config' }, `Config validation: ${err}`);
    }
  }
}

export const env = {
  port: num(process.env.EG_PORT, 8080),
  api_key: process.env.EG_API_KEY,
  require_api_key:
    bool(process.env.EG_REQUIRE_API_KEY) ||
    process.env.NODE_ENV === "production" ||
    str(process.env.EG_MODE, "standard").toLowerCase() === "production",
  rate_limit_enabled: bool(process.env.EG_RATE_LIMIT_ENABLED),
  rate_limit_window_ms: num(process.env.EG_RATE_LIMIT_WINDOW_MS, 60000),
  rate_limit_max_requests: num(process.env.EG_RATE_LIMIT_MAX_REQUESTS, 100),
  storage_backend: str(process.env.EG_STORAGE, "postgres").toLowerCase(),
  sqlite_path: str(process.env.EG_SQLITE_PATH, "./engram.sqlite"),
  valkey_url: str(process.env.EG_REDIS_URL, "redis://localhost:6379"),
  emb_kind: str(process.env.EG_EMBEDDINGS, "ollama"),
   embedding_fallback: str(process.env.EG_MODEL_EMBEDDING_FALLBACK, "bge-m3")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  openai_key: process.env.EG_OPENAI_API_KEY || "",
  openai_base_url: str(process.env.EG_OPENAI_BASE_URL, "https://api.openai.com/v1"),
  openai_model: process.env.EG_OPENAI_MODEL,
  ollama_model: str(process.env.EG_OLLAMA_MODEL),
  gemini_key: process.env.EG_GEMINI_API_KEY || "",
  aws_region: str(process.env.EG_AWS_REGION),
  aws_access_key_id: str(process.env.EG_AWS_ACCESS_KEY_ID),
  aws_secret_access_key: str(process.env.EG_AWS_SECRET_ACCESS_KEY),
  siray_key: process.env.EG_SIRAY_API_KEY || process.env.EG_SIRAY_API_TOKEN || "",
  siray_base_url: str(process.env.EG_SIRAY_BASE_URL, "https://api.siray.ai/v1"),
  ollama_url: str(process.env.EG_OLLAMA_URL, "http://localhost:11434"),
  // ── Generative models ──
   generative_model: DEFAULT_GENERATIVE_MODEL,
   fallback_model: DEFAULT_GENERATIVE_FALLBACK,

   // ── Embedding model (primary) ──
   embed_model_primary: DEFAULT_EMBEDDING_MODEL,

   // Per-facet embedding overrides — EG_MODEL_EPOCHISODIC / EG_MODEL_SEMANTIC etc.
   get embed_model_episodic(): string { return DEFAULT_EMBEDDING_FACET("episodic"); },
   get embed_model_semantic(): string { return DEFAULT_EMBEDDING_FACET("semantic"); },
   get embed_model_procedural(): string { return DEFAULT_EMBEDDING_FACET("procedural"); },
   get embed_model_emotional(): string { return DEFAULT_EMBEDDING_FACET("emotional"); },
   get embed_model_reflective(): string { return DEFAULT_EMBEDDING_FACET("reflective"); },

   llm_url: str(process.env.EG_UPSTREAM_LLM_URL, ""),
  local_model_path: str(process.env.EG_LOCAL_MODEL_PATH),
  vec_dim: num(process.env.EG_VEC_DIM, 1536),
  max_payload_size: num(process.env.EG_MAX_PAYLOAD_SIZE, 1_000_000),
  ingest_chunk_target_chars: num(process.env.EG_INGEST_CHUNK_TARGET_CHARS, 3000),
};
