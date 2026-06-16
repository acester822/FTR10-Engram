/*
 - filename: packages/engram-js/src/configuration/index.ts
 - what is the file used for: central runtime environment parsing for the node server
*/

import { load_env_files } from "./envFile";

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
  emb_kind: str(process.env.EG_EMBEDDINGS, "synthetic"),
  embedding_fallback: str(process.env.EG_EMBEDDING_FALLBACK, "synthetic")
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
  llm_url: str(process.env.EG_UPSTREAM_LLM_URL, ""),
  local_model_path: str(process.env.EG_LOCAL_MODEL_PATH),
  vec_dim: num(process.env.EG_VEC_DIM, 1536),
  max_payload_size: num(process.env.EG_MAX_PAYLOAD_SIZE, 1_000_000),
};
