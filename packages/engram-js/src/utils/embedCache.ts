/*
 * filename: packages/engram-js/src/utils/embedCache.ts
 * what is the file used for: simple LRU in-memory cache for embedding vectors
 *
 * Keyed by "facet:text". No TTL needed — embeddings are deterministic for a
 * given model+text pair. Cache evicts oldest entries when exceeding MAX_ENTRIES.
 */

export const EMBED_CACHE_MAX = 500;

export class EmbeddingCache {
  private cache = new Map<string, { result: number[] }>();

  /** Retrieve a cached embedding, promoting it to most-recently-used. */
  get(key: string): number[] | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    // LRU promotion: delete and re-insert so it moves to the end
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.result;
  }

  /** Store an embedding. Evicts the LRU entry if at capacity. */
  set(key: string, vec: number[]): void {
    if (this.cache.has(key)) {
      // Promote existing key
      this.cache.delete(key);
    } else if (this.cache.size >= EMBED_CACHE_MAX) {
      // Evict the oldest (first-inserted) entry
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { result: vec });
  }

  /** Number of entries currently cached. */
  get size(): number {
    return this.cache.size;
  }

  /** Clear all cached embeddings. */
  clear(): void {
    this.cache.clear();
  }
}

/** Singleton shared across the application. */
export const embedCache = new EmbeddingCache();
