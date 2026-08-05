/*
 - filename: packages/engram-js/src/services/settingsService.ts
 - what is the file used for: runtime settings store (Postgres-backed). The web GUI
   Settings tab is the single source of truth for providers/models. Env vars remain
   ONLY as first-boot bootstrap (seeded once into the table) and as low-priority
   overrides — there are NO hardcoded defaults anywhere.
*/

import { run_async as pg_run, all_async as pg_all } from "../database/connection";
import { logger } from "../utils/logger";

const SETTINGS_TABLE = "app_settings";
const SETTINGS_SCHEMA = "public";

let cache: Map<string, string> = new Map();

// ── Canonical setting keys ─────────────────────────────────────────────
export const SETTING_KEYS = {
  providerType: "provider.type",
  providerHost: "provider.host",
  providerPort: "provider.port",
  generativeProviderHost: "generative.provider.host",
  generativeProviderPort: "generative.provider.port",
  generativeModel: "generative.model",
  extractionModel: "generative.extraction",
  compactionModel: "generative.compaction",
  consolidationModel: "generative.consolidation",
  embeddingProviderHost: "embedding.provider.host",
  embeddingProviderPort: "embedding.provider.port",
  embeddingModel: "embedding.model",
  facetEpisodic: "embedding.episodic",
  facetSemantic: "embedding.semantic",
  facetProcedural: "embedding.procedural",
  facetEmotional: "embedding.emotional",
  facetReflective: "embedding.reflective",
} as const;

export const GENERATIVE_TASK_KEYS = {
  extraction: SETTING_KEYS.extractionModel,
  compaction: SETTING_KEYS.compactionModel,
  consolidation: SETTING_KEYS.consolidationModel,
} as const;

export const EMBEDDING_FACET_KEYS = {
  episodic: SETTING_KEYS.facetEpisodic,
  semantic: SETTING_KEYS.facetSemantic,
  procedural: SETTING_KEYS.facetProcedural,
  emotional: SETTING_KEYS.facetEmotional,
  reflective: SETTING_KEYS.facetReflective,
} as const;

// ── General (non-model) settings — the GUI Settings tab manages these too, so
//    .env stops being required. Each maps to the env var legacy readers use;
//    values are mirrored into process.env at boot (BEFORE the config module
//    reads it) and live on save. Empty value = engine default. ──
export interface GeneralSettingDef {
  key: string;      // settings key (prefix "general.")
  env: string;      // legacy env var name
  type: "string" | "number" | "bool";
  label: string;
  section: string;  // GUI group
}

export const GENERAL_SETTINGS: GeneralSettingDef[] = [
  // Server
  { key: "general.vec_dim", env: "EG_VEC_DIM", type: "number", label: "Embedding Dimensions", section: "server" },
  { key: "general.max_payload_size", env: "EG_MAX_PAYLOAD_SIZE", type: "number", label: "Max Payload Size (bytes)", section: "server" },
  { key: "general.require_api_key", env: "EG_REQUIRE_API_KEY", type: "bool", label: "Require API Key", section: "server" },
  { key: "general.api_key", env: "EG_API_KEY", type: "string", label: "API Key", section: "server" },
  // Embedding
  { key: "general.embed_timeout_ms", env: "EG_EMBED_TIMEOUT_MS", type: "number", label: "Embedding Timeout (ms)", section: "embedding" },
  // Rate limits
  { key: "general.rate_limit_enabled", env: "EG_RATE_LIMIT_ENABLED", type: "bool", label: "Rate Limit Enabled", section: "rate_limit" },
  { key: "general.rate_limit_window_ms", env: "EG_RATE_LIMIT_WINDOW_MS", type: "number", label: "Rate Limit Window (ms)", section: "rate_limit" },
  { key: "general.rate_limit_max_requests", env: "EG_RATE_LIMIT_MAX_REQUESTS", type: "number", label: "Max Requests / Window", section: "rate_limit" },
  // Compaction
  { key: "general.compact_trigger", env: "EG_COMPACT_TRIGGER", type: "number", label: "Compaction Trigger (messages)", section: "compaction" },
  { key: "general.max_raw_turns", env: "EG_MAX_RAW_TURNS", type: "number", label: "Max Raw Turns", section: "compaction" },
  { key: "general.compact_max_messages", env: "EG_COMPACT_MAX_MESSAGES", type: "number", label: "Compaction Max Messages", section: "compaction" },
  { key: "general.compact_timeout_sec", env: "EG_COMPACT_TIMEOUT_SEC", type: "number", label: "Compaction Timeout (s)", section: "compaction" },
  { key: "general.compact_prompt_max_chars", env: "EG_COMPACT_PROMPT_MAX_CHARS", type: "number", label: "Compaction Prompt Max Chars", section: "compaction" },
  { key: "general.compaction_cooldown_ms", env: "EG_COMPACTION_COOLDOWN_MS", type: "number", label: "Compaction Cooldown (ms)", section: "compaction" },
  // Auto-search
  { key: "general.auto_search_enabled", env: "EG_AUTO_SEARCH_ENABLED", type: "bool", label: "Auto-Search Enabled", section: "auto_search" },
  { key: "general.auto_search_max_results", env: "EG_AUTO_SEARCH_MAX_RESULTS", type: "number", label: "Auto-Search Max Results", section: "auto_search" },
  { key: "general.auto_search_min_confidence", env: "EG_AUTO_SEARCH_MIN_CONFIDENCE", type: "number", label: "Auto-Search Min Confidence", section: "auto_search" },
  { key: "general.auto_search_max_chars", env: "EG_AUTO_SEARCH_MAX_CHARS", type: "number", label: "Auto-Search Max Chars", section: "auto_search" },
  // Consolidation tiers
  { key: "general.consol_recent_interval_ms", env: "EG_CONSOLIDATION_RECENT_INTERVAL_MS", type: "number", label: "Recent Tier Interval (ms)", section: "consolidation" },
  { key: "general.consol_deep_interval_ms", env: "EG_CONSOLIDATION_DEEP_INTERVAL_MS", type: "number", label: "Deep Tier Interval (ms)", section: "consolidation" },
  { key: "general.consol_recent_max_age_days", env: "EG_CONSOLIDATION_RECENT_MAX_AGE_DAYS", type: "number", label: "Recent Tier Window (days)", section: "consolidation" },
  { key: "general.consol_deep_max_age_days", env: "EG_CONSOLIDATION_DEEP_MAX_AGE_DAYS", type: "number", label: "Deep Tier Window (days)", section: "consolidation" },
  { key: "general.consol_recent_min_group", env: "EG_CONSOLIDATION_RECENT_MIN_GROUP", type: "number", label: "Recent Tier Min Group", section: "consolidation" },
  { key: "general.consol_deep_min_group", env: "EG_CONSOLIDATION_DEEP_MIN_GROUP", type: "number", label: "Deep Tier Min Group", section: "consolidation" },
];

// ── Advanced (infra / secrets / misc) settings — shown in a warning-labeled table.
//    Most apply at boot; DB/Redis connection vars are read at startup BEFORE the
//    settings store is available (the pool needs the DB to load settings), so those
//    require a docker-compose/.env change + container recreate. ──
export const ADVANCED_SETTINGS: GeneralSettingDef[] = [
  // Database (compose-level — read at startup, before settings load)
  { key: "advanced.pg_host", env: "EG_PG_HOST", type: "string", label: "Postgres Host", section: "Database" },
  { key: "advanced.pg_port", env: "EG_PG_PORT", type: "number", label: "Postgres Port", section: "Database" },
  { key: "advanced.pg_db", env: "EG_PG_DB", type: "string", label: "Postgres Database", section: "Database" },
  { key: "advanced.pg_user", env: "EG_PG_USER", type: "string", label: "Postgres User", section: "Database" },
  { key: "advanced.pg_password", env: "EG_PG_PASSWORD", type: "string", label: "Postgres Password", section: "Database" },
  { key: "advanced.pg_schema", env: "EG_PG_SCHEMA", type: "string", label: "Postgres Schema", section: "Database" },
  { key: "advanced.pg_ssl", env: "EG_PG_SSL", type: "string", label: "Postgres SSL (require/disable)", section: "Database" },
  { key: "advanced.redis_url", env: "EG_REDIS_URL", type: "string", label: "Redis URL", section: "Database" },
  // Provider keys (dormant providers / integrations)
  { key: "advanced.openai_api_key", env: "EG_OPENAI_API_KEY", type: "string", label: "OpenAI API Key", section: "Provider Keys" },
  { key: "advanced.gemini_key", env: "EG_GEMINI_API_KEY", type: "string", label: "Gemini API Key", section: "Provider Keys" },
  { key: "advanced.aws_region", env: "EG_AWS_REGION", type: "string", label: "AWS Region", section: "Provider Keys" },
  { key: "advanced.aws_access_key_id", env: "EG_AWS_ACCESS_KEY_ID", type: "string", label: "AWS Access Key ID", section: "Provider Keys" },
  { key: "advanced.aws_secret_access_key", env: "EG_AWS_SECRET_ACCESS_KEY", type: "string", label: "AWS Secret Access Key", section: "Provider Keys" },
  { key: "advanced.siray_key", env: "EG_SIRAY_API_KEY", type: "string", label: "Siray API Key", section: "Provider Keys" },
  { key: "advanced.siray_token", env: "EG_SIRAY_API_TOKEN", type: "string", label: "Siray API Token", section: "Provider Keys" },
  { key: "advanced.siray_base_url", env: "EG_SIRAY_BASE_URL", type: "string", label: "Siray Base URL", section: "Provider Keys" },
  { key: "advanced.google_credentials_json", env: "EG_GOOGLE_CREDENTIALS_JSON", type: "string", label: "Google Credentials JSON", section: "Provider Keys" },
  { key: "advanced.google_service_account_file", env: "EG_GOOGLE_SERVICE_ACCOUNT_FILE", type: "string", label: "Google Service Account File", section: "Provider Keys" },
  { key: "advanced.notion_key", env: "EG_NOTION_API_KEY", type: "string", label: "Notion API Key", section: "Provider Keys" },
  { key: "advanced.onedrive_token", env: "EG_ONEDRIVE_ACCESS_TOKEN", type: "string", label: "OneDrive Access Token", section: "Provider Keys" },
  { key: "advanced.openmemory_key", env: "EG_OPENMEMORY_API_KEY", type: "string", label: "OpenMemory API Key", section: "Provider Keys" },
  { key: "advanced.openmemory_url", env: "EG_OPENMEMORY_URL", type: "string", label: "OpenMemory URL", section: "Provider Keys" },
  // Vector store
  { key: "advanced.vector_store", env: "EG_VECTOR_STORE", type: "string", label: "Vector Store", section: "Vector Store" },
  { key: "advanced.vector_url", env: "EG_VECTOR_URL", type: "string", label: "Vector Store URL", section: "Vector Store" },
  { key: "advanced.vector_api_key", env: "EG_VECTOR_API_KEY", type: "string", label: "Vector Store API Key", section: "Vector Store" },
  { key: "advanced.vector_collection", env: "EG_VECTOR_COLLECTION", type: "string", label: "Vector Collection", section: "Vector Store" },
  { key: "advanced.vector_timeout_ms", env: "EG_VECTOR_TIMEOUT_MS", type: "number", label: "Vector Timeout (ms)", section: "Vector Store" },
  // Misc
  { key: "advanced.mode", env: "EG_MODE", type: "string", label: "Mode (standard/production)", section: "Misc" },
  { key: "advanced.storage", env: "EG_STORAGE", type: "string", label: "Storage Backend", section: "Misc" },
  { key: "advanced.sqlite_path", env: "EG_SQLITE_PATH", type: "string", label: "SQLite Path", section: "Misc" },
  { key: "advanced.http_timeout_ms", env: "EG_HTTP_TIMEOUT_MS", type: "number", label: "HTTP Timeout (ms)", section: "Misc" },
  { key: "advanced.log_auth", env: "EG_LOG_AUTH", type: "bool", label: "Log Auth", section: "Misc" },
  { key: "advanced.log_dir", env: "EG_LOG_DIR", type: "string", label: "Log Directory", section: "Misc" },
  { key: "advanced.log_max_lines", env: "EG_LOG_MAX_LINES", type: "number", label: "Log Max Lines", section: "Misc" },
  { key: "advanced.telemetry", env: "EG_TELEMETRY", type: "bool", label: "Telemetry", section: "Misc" },
  { key: "advanced.internal_api_key", env: "EG_INTERNAL_API_KEY", type: "string", label: "Internal API Key", section: "Misc" },
];

const ADVANCED_BY_KEY = new Map(ADVANCED_SETTINGS.map((d) => [d.key, d]));

// Provider Type → embedding provider kind (EG_EMBEDDINGS). The Provider Settings
// section is the single place for provider type; the embedding backend kind is
// derived from it (openai-compatible → openai).
const PROVIDER_KIND_MAP: Record<string, string> = {
  "openai-compatible": "openai",
};

export function applyProviderDerived(): void {
  const t = cache.get(SETTING_KEYS.providerType) || "openai-compatible";
  const kind = PROVIDER_KIND_MAP[t] || t;
  if (kind) process.env.EG_EMBEDDINGS = kind;
}

/** Effective advanced values for the GUI (process.env after apply). */
export function advancedSettingsView(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of ADVANCED_SETTINGS) {
    const short = def.key.replace(/^advanced\./, "");
    out[short] = process.env[def.env] || "";
  }
  return out;
}

const GENERAL_BY_KEY = new Map(GENERAL_SETTINGS.map((d) => [d.key, d]));

/** Mirror cached general settings into process.env (settings win over .env). */
export function applySettingsToEnv(): void {
  for (const def of GENERAL_SETTINGS) {
    const v = cache.get(def.key);
    if (v !== undefined && v !== "") process.env[def.env] = v;
  }
  for (const def of ADVANCED_SETTINGS) {
    const v = cache.get(def.key);
    if (v !== undefined && v !== "") process.env[def.env] = v;
  }
  applyProviderDerived();
}

/** Effective values for the GUI: process.env after apply (reflects .env defaults too). */
export function generalSettingsView(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of GENERAL_SETTINGS) {
    const short = def.key.replace(/^general\./, "");
    out[short] = process.env[def.env] || "";
  }
  return out;
}

/** Load settings, mirror to env, and seed once from env if the table is empty. */
export async function runSettingsBootstrap(): Promise<void> {
  await loadSettings();
  applySettingsToEnv();
  await seedSettingsFromEnv();
  applySettingsToEnv();
}

/** Load all settings into the in-memory cache. Call once at boot (after migrations). */
export async function loadSettings(): Promise<void> {
  try {
    const rows = await pg_all(`SELECT key, value FROM "${SETTINGS_SCHEMA}"."${SETTINGS_TABLE}"`, []);
    cache = new Map((rows || []).map((r: any) => [r.key, r.value]));
    logger.info({ module: "settings", count: cache.size }, `Loaded ${cache.size} settings from ${SETTINGS_TABLE}`);
  } catch (err) {
    logger.error({ module: "settings", err }, `Failed to load settings from ${SETTINGS_TABLE} — using env bootstrap`);
    cache = new Map();
  }
}

export function getSetting(key: string): string {
  const v = cache.get(key);
  return v !== undefined && v !== "" ? v : "";
}

export function getSettings(): Record<string, string> {
  return Object.fromEntries(cache.entries());
}

export function settingsLoaded(): boolean {
  return cache.size > 0;
}

/** Upsert a patch of settings into the DB + in-memory cache (+ live process.env mirror for general keys). */
export async function saveSettings(patch: Record<string, string | undefined>): Promise<void> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  for (const [key, value] of entries) {
    const v = String(value ?? "").trim();
    await pg_run(
      `INSERT INTO "${SETTINGS_SCHEMA}"."${SETTINGS_TABLE}" (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, v],
    );
    cache.set(key, v);
    const def = GENERAL_BY_KEY.get(key) || ADVANCED_BY_KEY.get(key);
    if (def) process.env[def.env] = v; // live-apply (runtime readers see it immediately)
    if (key === SETTING_KEYS.providerType) applyProviderDerived();
  }
}

/**
 * First-boot bootstrap: when the settings table is empty (fresh upgrade), seed it
 * from the current env values so the GUI takes over seamlessly. Only runs once.
 */
export async function seedSettingsFromEnv(): Promise<void> {
  if (cache.size > 0) return;
  const seed: Record<string, string> = {};

  const genUrl = process.env.EG_GENERATIVE_URL || process.env.EG_OPENAI_BASE_URL || "";
  const m = genUrl.match(/^https?:\/\/([^/:]+)(?::(\d+))?/);
  if (m) {
    seed[SETTING_KEYS.providerHost] = m[1];
    if (m[2]) seed[SETTING_KEYS.providerPort] = m[2];
  }
  if (process.env.EG_MODEL_GENERATIVE) seed[SETTING_KEYS.generativeModel] = process.env.EG_MODEL_GENERATIVE;
  if (process.env.EG_MODEL_EMBEDDING) seed[SETTING_KEYS.embeddingModel] = process.env.EG_MODEL_EMBEDDING;
  for (const f of ["episodic", "semantic", "procedural", "emotional", "reflective"]) {
    const envV = process.env[`EG_MODEL_EMBED_${f.toUpperCase()}`];
    if (envV) seed[`embedding.${f}`] = envV;
  }
  if (Object.keys(seed).length > 0) {
    await saveSettings(seed);
    logger.info({ module: "settings", keys: Object.keys(seed) }, "Seeded settings table from env bootstrap");
  }
}
