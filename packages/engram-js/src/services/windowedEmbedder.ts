/*
 - filename: packages/engram-js/src/services/windowedEmbedder.ts
 - what is the file used for: windowed (sliding-window) embeddings for long memories
*/

import crypto from "node:crypto";
import { embed, isSyntheticEmbedding } from "../embeddings/embed";
import { logger } from "../utils/logger";

export const WINDOW_SIZE = 448; // tokens
export const STRIDE = 384; // tokens (64 token overlap)
export const MAX_WINDOWS = 64;

export interface MemoryWindow {
  window_index: number;
  start_pos: number;
  end_pos: number;
}

/** Minimal structural db type — avoids importing DurableExecutor (would cycle). */
export interface WindowDb {
  query(sql: string, params?: unknown[]): Promise<any>;
}

/** Simple whitespace tokenization (production would use tiktoken). */
export function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Build overlapping windows over a token array. Overlap ensures a fact that
 * straddles a window boundary is still fully covered by the adjacent window.
 */
export function createWindows(tokens: string[]): MemoryWindow[] {
  const numWindows = Math.min(
    Math.ceil(Math.max(0, tokens.length - WINDOW_SIZE) / STRIDE) + 1,
    MAX_WINDOWS,
  );
  const windows: MemoryWindow[] = [];
  for (let i = 0; i < numWindows; i++) {
    const start = i * STRIDE;
    const end = Math.min(start + WINDOW_SIZE, tokens.length);
    windows.push({ window_index: i, start_pos: start, end_pos: end });
  }
  return windows;
}

/**
 * Embeds long memories in overlapping windows so no fact is cut in half.
 * Window vectors land in `memory_windows`; the full-memory embedding in
 * `memories.embedding` is left untouched (the caller stores it at insert).
 */
export class WindowedEmbedder {
  private memoriesTable: string;
  private windowsTable: string;

  constructor(private db: WindowDb) {
    const schema = process.env.EG_PG_SCHEMA || "public";
    this.memoriesTable = `"${schema}"."memories"`;
    this.windowsTable = `"${schema}"."memory_windows"`;
  }

  async embedMemory(memoryId: string, content: string): Promise<void> {
    const tokens = tokenize(content);
    if (!tokens.length) return;
    const windows = createWindows(tokens);

    logger.debug(
      { memoryId, tokenCount: tokens.length, windowCount: windows.length },
      "Creating windowed embeddings",
    );

    for (const window of windows) {
      const windowText = tokens.slice(window.start_pos, window.end_pos).join(" ");
      const embedding = await embed(windowText);
      const synthetic = isSyntheticEmbedding(embedding, windowText);

      if (synthetic) {
        logger.warn(
          { module: "windowedEmbedder", memoryId, windowIndex: window.window_index },
          "Stored SYNTHETIC (hash) window embedding — recall on this window is unreliable",
        );
      }

      await this.db.query(
        `insert into ${this.windowsTable}
          (id, memory_id, window_index, start_pos, end_pos, embedding, embedding_synthetic)
         values ($1, $2, $3, $4, $5, $6::halfvec, $7)
         on conflict (memory_id, window_index) do update set
           start_pos = excluded.start_pos,
           end_pos = excluded.end_pos,
           embedding = excluded.embedding,
           embedding_synthetic = excluded.embedding_synthetic`,
        [
          crypto.randomUUID(),
          memoryId,
          window.window_index,
          window.start_pos,
          window.end_pos,
          `[${embedding.join(",")}]`,
          synthetic,
        ],
      );
    }

    // For short memories (single window), keep the full-memory embedding fresh.
    if (windows.length === 1) {
      const fullEmbedding = await embed(content);
      const synthetic = isSyntheticEmbedding(fullEmbedding, content);
      if (synthetic) {
        logger.warn(
          { module: "windowedEmbedder", memoryId },
          "Stored SYNTHETIC (hash) embedding — semantic recall for this row will be unreliable",
        );
      }
      await this.db.query(
        `update ${this.memoriesTable} set embedding = $1::halfvec, embedding_synthetic = $2 where id = $3`,
        [`[${fullEmbedding.join(",")}]`, synthetic, memoryId],
      );
    }
  }
}
