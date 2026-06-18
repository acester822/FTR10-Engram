/*
 - filename: packages/engram-js/src/services/genomeCache.ts
 - what is the file used for: In-memory cache for genome (near-immutable) memories, with TTL and invalidation
*/

/**
 * Simple single-entry cache for genome memories.
 * Genome memories change infrequently so we cache the query results
 * with a configurable TTL. Invalidated on any memory write operation.
 */
export class GenomeCache {
  private cached: { id: string; content: string }[] | null = null;
  private cachedAt = 0;
  private ttlMs: number;

  constructor(ttlMs = 30_000) {
    this.ttlMs = ttlMs;
  }

  get(): { id: string; content: string }[] | null {
    if (this.cached && Date.now() - this.cachedAt < this.ttlMs) {
      return this.cached;
    }
    return null;
  }

  set(genomes: { id: string; content: string }[]): void {
    this.cached = genomes;
    this.cachedAt = Date.now();
  }

  invalidate(): void {
    this.cached = null;
    this.cachedAt = 0;
  }
}

export const genomeCache = new GenomeCache();
