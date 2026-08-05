/*
 - filename: packages/engram-js/src/database/modelRegistry.ts
 - what is the file used for: THE canonical model registry. Resolution order for every
   model: Settings (GUI, Postgres-backed) → env override → FAIL with a clear message.
   There are NO hardcoded model names as defaults anywhere in this chain.
*/

import {
  getSetting,
  SETTING_KEYS,
  GENERATIVE_TASK_KEYS,
  EMBEDDING_FACET_KEYS,
} from "../services/settingsService";

export type GenerativeTask = "default" | "extraction" | "compaction" | "consolidation";
export type EmbeddingFacet = "episodic" | "semantic" | "procedural" | "emotional" | "reflective";
export type ModelSection = "generative" | "embedding";

function firstNonEmpty(...vals: Array<string | undefined>): string {
  for (const v of vals) {
    if (v && v.trim()) return v.trim();
  }
  return "";
}

/** Resolve the generative model for a task (default = master model). Throws when unset. */
export function resolveGenerativeModel(task: GenerativeTask = "default"): string {
  const perTask = task === "default" ? "" : getSetting(GENERATIVE_TASK_KEYS[task]);
  const master = getSetting(SETTING_KEYS.generativeModel);
  const envOverride =
    task === "consolidation" ? process.env.EG_CONSOLIDATION_MODEL : "";
  const model = firstNonEmpty(perTask, master, envOverride, process.env.EG_MODEL_GENERATIVE);
  if (!model) {
    throw new Error(
      `No generative model configured for task "${task}" — set it in the Engram Settings tab` +
        (task === "consolidation" ? " (or EG_CONSOLIDATION_MODEL / EG_MODEL_GENERATIVE)" : " (or EG_MODEL_GENERATIVE)") +
        ".",
    );
  }
  return model;
}

/** Resolve the embedding model for a facet. Throws when unset. */
export function resolveEmbeddingModel(facet: EmbeddingFacet = "semantic"): string {
  const perFacet = getSetting(EMBEDDING_FACET_KEYS[facet]);
  const master = getSetting(SETTING_KEYS.embeddingModel);
  const envFacet = process.env[`EG_MODEL_EMBED_${facet.toUpperCase()}`];
  const model = firstNonEmpty(perFacet, master, envFacet, process.env.EG_MODEL_EMBEDDING);
  if (!model) {
    throw new Error(
      `No embedding model configured for facet "${facet}" — set it in the Engram Settings tab (or EG_MODEL_EMBEDDING).`,
    );
  }
  return model;
}

/** Resolve the provider base URL (http://host:port/v1) for a section. Throws when unset. */
export function resolveProviderUrl(section: ModelSection): string {
  const overrideHost = getSetting(section === "generative" ? SETTING_KEYS.generativeProviderHost : SETTING_KEYS.embeddingProviderHost);
  const host = firstNonEmpty(
    overrideHost,
    getSetting(SETTING_KEYS.providerHost),
    envUrlHost(process.env.EG_GENERATIVE_URL),
    envUrlHost(process.env.EG_OPENAI_BASE_URL),
  );
  if (!host) {
    throw new Error(
      `No provider configured for "${section}" — set it in the Engram Settings tab (or EG_GENERATIVE_URL / EG_OPENAI_BASE_URL).`,
    );
  }
  const overridePort = getSetting(section === "generative" ? SETTING_KEYS.generativeProviderPort : SETTING_KEYS.embeddingProviderPort);
  const port = firstNonEmpty(
    overridePort,
    getSetting(SETTING_KEYS.providerPort),
    envUrlPort(process.env.EG_GENERATIVE_URL),
    envUrlPort(process.env.EG_OPENAI_BASE_URL),
  );
  return `http://${host}${port ? `:${port}` : ""}/v1`;
}

function envUrlHost(url: string | undefined): string {
  const m = url?.match(/^https?:\/\/([^/:]+)/);
  return m ? m[1] : "";
}

function envUrlPort(url: string | undefined): string {
  const m = url?.match(/^https?:\/\/[^/:]+:(\d+)/);
  return m ? m[1] : "";
}

/** Non-throwing variant for logging/status display. */
export function tryResolveGenerativeModel(task: GenerativeTask = "default"): string {
  try {
    return resolveGenerativeModel(task);
  } catch {
    return "";
  }
}

export function tryResolveEmbeddingModel(facet: EmbeddingFacet = "semantic"): string {
  try {
    return resolveEmbeddingModel(facet);
  } catch {
    return "";
  }
}

export function tryResolveProviderUrl(section: ModelSection): string {
  try {
    return resolveProviderUrl(section);
  } catch {
    return "";
  }
}
