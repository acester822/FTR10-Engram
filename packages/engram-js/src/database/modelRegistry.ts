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

// ── Judge (trace scoring) — a FULLY INDEPENDENT model/provider, deliberately
//    NOT part of the generative chain (Aug 2026 user decision): the judge often
//    lives on a separate llama-swap box so scoring never contends with the
//    active chat's generative model. Resolution: Settings "Judge" section →
//    EG_JUDGE_* env → fail with a clear message. No generative fallbacks. ──

export function resolveJudgeModel(): string {
  const model = firstNonEmpty(getSetting(SETTING_KEYS.judgeModel), process.env.EG_JUDGE_MODEL);
  if (!model) {
    throw new Error(
      'No judge model configured — set it in the Engram Settings tab (Judge section) or EG_JUDGE_MODEL.',
    );
  }
  return model;
}

export function resolveJudgeProviderUrl(): string {
  const host = firstNonEmpty(
    getSetting(SETTING_KEYS.judgeProviderHost),
    envUrlHost(process.env.EG_JUDGE_URL),
  );
  if (!host) {
    throw new Error(
      'No judge provider configured — set it in the Engram Settings tab (Judge section) or EG_JUDGE_URL.',
    );
  }
  const port = firstNonEmpty(
    getSetting(SETTING_KEYS.judgeProviderPort),
    envUrlPort(process.env.EG_JUDGE_URL),
  );
  return `http://${host}${port ? `:${port}` : ""}/v1`;
}

export function resolveJudgeApiKey(): string {
  return getSetting(SETTING_KEYS.judgeApiKey) || process.env.EG_JUDGE_API_KEY || "";
}

export function tryResolveJudgeModel(): string {
  try {
    return resolveJudgeModel();
  } catch {
    return "";
  }
}

export function tryResolveJudgeProviderUrl(): string {
  try {
    return resolveJudgeProviderUrl();
  } catch {
    return "";
  }
}
