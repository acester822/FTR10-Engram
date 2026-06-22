/*
 - filename: packages/engram-js/src/services/engramStatus.ts
 - what is the file used for: Engram status message builder — generates SSE status messages for UI display, sanitization regexes for cleaning conversation history, and scramble characters for CLI decryption animation
 */

// ── Configuration ──────────────────────────────────────────────────────

/** Emoji prefix for all Engram status messages — DNA fits Genome/Phenotype taxonomy */
export const ENGRAM_EMOJI = "🧬";

/** Characters used for the "decryption scramble" animation effect in CLI clients */
export const SCRAMBLE_CHARS = '!<>-_\\/[]{}—=+*^?#________';

// ── Message Builders ───────────────────────────────────────────────────

/**
 * Initial status message — sent BEFORE the LLM starts generating.
 * Tells the user what memory was injected into context.
 */
export function buildInjectionStatus(
  genomeCount: number,
  phenotypeCount: number,
  compactionFactCount?: number,
): string {
  const compactionNote = compactionFactCount && compactionFactCount > 0
    ? `\n⚙️ *Compacted session — saved ${compactionFactCount} memories.*`
    : "";
  return `🧬 *Engram: ${genomeCount} Genome | ${phenotypeCount} Phenotype memories loaded.*${compactionNote}\n\n`;
}

/**
 * Final status message — sent AFTER extraction completes.
 * Tells the user what new memories were learned from the interaction.
 */
export function buildExtractionStatus(storedCount: number): string {
  if (storedCount > 0) {
    return `\n\n---\n🧬 *Engram: Extraction complete — stored ${storedCount} memories.*`;
  }
  return `\n\n---\n🧬 *Engram: Session saved.*`;
}

/**
 * Progress message — shown while querying the cognitive engine.
 */
export function buildProgressMessage(): string {
  return "🧬 Querying Engram cognitive engine...";
}

// ── Sanitization Regexes ──────────────────────────────────────────────

/**
 * Regex patterns to strip Engram status messages from conversation history
 * before forwarding to the upstream LLM. Prevents our UI artifacts from
 * polluting the conversation context on subsequent turns.
 *
 * These match ALL known message format variations for backward compatibility:
 * - New format: 🧬 *Engram: 10 Genome | 0 Phenotype memories loaded.*
 * - New format: 🧬 *Engram: Extraction complete — stored 3 memories.*
 * - Old format: 🧠 *Engram: Injected 10 Genome and 0 Phenotype memory(ies) into context.*
 */
export const ENGRAM_STATUS_REGEXES: RegExp[] = [
  // New injection format: 🧬 *Engram: 10 Genome | 0 Phenotype memories loaded.*
  /🧬 \*?Engram:\s*\d+ Genome \| \d+ Phenotype memories? loaded\.\*\n?/g,
  // New extraction format: 🧬 *Engram: Extraction complete — stored X memories.*
  /\n?---?\s*🧬 \*?Engram:\s*Extraction complete — stored \d+ memories?\.\*/g,
  // New session saved format: 🧬 *Engram: Session saved.*
  /\n?---?\s*🧬 \*?Engram:\s*Session saved\.\*/g,
  // Compaction note: ⚙️ *Compacted session — saved X memories.*
  /\n⚙️ \*?Compacted session — saved \d+ memories?\.\*/g,
  // Old injection format (backward compat): 🧠 *Engram: Injected X Genome and Y Phenotype memory(ies) into context.*
  /🧠 \*?Engram:\s*\*?Injected \d+ Genome and \d+ Phenotype memory\(ies\) into context\.\*\n?/g,
  // Old extraction format (backward compat): 🧠 *Engram: Extraction complete. Stored X memory(ies).*
  /\n?---?\s*🧠 \*?Engram:\s*\*?Extraction complete\. Stored \d+ new memory\(ies\)\.\*/g,
  // Generic catch-all for any Engram status line
  /🧬\s*\*?Engram:\s*(Loaded|Extraction complete)[^\n]*/g,
  /🧠\s*\*?Engram:\s*(Injected|Extraction complete)[^\n]*/g,
];

/**
 * Strip all Engram status messages from a string.
 */
export function stripEngramStatus(text: string): string {
  let cleaned = text;
  for (const re of ENGRAM_STATUS_REGEXES) {
    // Reset lastIndex for global regexes
    re.lastIndex = 0;
    cleaned = cleaned.replace(re, "");
  }
  return cleaned.trim();
}

/**
 * Check if a string contains an Engram status message.
 */
export function isEngramStatus(text: string): boolean {
  return text.includes(`${ENGRAM_EMOJI} *Engram:`) ||
         text.includes("🧠 *Engram:");
}
