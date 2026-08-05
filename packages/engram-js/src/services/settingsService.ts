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

/** Upsert a patch of settings into the DB + in-memory cache. */
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
