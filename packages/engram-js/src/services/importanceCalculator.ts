/*
 - filename: packages/engram-js/src/services/importanceCalculator.ts
 - what is the file used for: importance tier classification (critical/high/medium/low)
*/

import { logger } from "../utils/logger";

export type ImportanceTier = "critical" | "high" | "medium" | "low";

export interface ImportanceConfig {
  tier: ImportanceTier;
  score: number;
  decay_rate: number;
}

export const TIER_CONFIG: Record<ImportanceTier, ImportanceConfig> = {
  critical: { tier: "critical", score: 0.9, decay_rate: 0.01 },
  high: { tier: "high", score: 0.75, decay_rate: 0.05 },
  medium: { tier: "medium", score: 0.5, decay_rate: 0.15 },
  low: { tier: "low", score: 0.25, decay_rate: 0.3 },
};

export const IMPORTANCE_TIERS = Object.keys(TIER_CONFIG) as ImportanceTier[];

/**
 * Heuristic importance classifier. Assigns a tier based on content phrasing and
 * metadata sector hints. The tier is stored on the memory row and used as a
 * ranking multiplier during hybrid recall (see `importanceMultiplier`).
 *
 * NOTE: the per-tier `decay_rate` is informational only — Engram's temporal
 * decay engine keeps its own genome/phenotype decay rates. Importance does NOT
 * override `memories.decay_rate`.
 */
export class ImportanceCalculator {
  calculate(content: string, metadata?: any): ImportanceConfig {
    let tier: ImportanceTier = "medium";

    // Critical: explicit user requests to remember
    if (this.hasExplicitRememberRequest(content)) {
      tier = "critical";
    }
    // High: decisions, preferences, architectural choices
    else if (this.isDecisionOrPreference(content, metadata)) {
      tier = "high";
    }
    // Low: transient facts, temporary information
    else if (this.isTransient(content, metadata)) {
      tier = "low";
    }

    logger.debug(
      { tier, content: content.substring(0, 50) },
      "Calculated importance tier",
    );
    return TIER_CONFIG[tier];
  }

  private hasExplicitRememberRequest(content: string): boolean {
    const patterns = [
      /remember this/i,
      /save this/i,
      /always remember/i,
      /don't forget/i,
      /important:/i,
    ];
    return patterns.some((p) => p.test(content));
  }

  private isDecisionOrPreference(content: string, metadata?: any): boolean {
    const patterns = [
      /i prefer/i,
      /i like/i,
      /always use/i,
      /never use/i,
      /decision:/i,
      /architecture:/i,
      /we decided/i,
    ];

    if (patterns.some((p) => p.test(content))) return true;

    // Check metadata for sector hints
    if (metadata?.sector === "procedural" || metadata?.sector === "semantic") {
      return true;
    }

    return false;
  }

  private isTransient(content: string, metadata?: any): boolean {
    const patterns = [
      /today/i,
      /this week/i,
      /temporary/i,
      /just for now/i,
    ];

    if (patterns.some((p) => p.test(content))) return true;

    if (metadata?.sector === "episodic") {
      return true;
    }

    return false;
  }
}
