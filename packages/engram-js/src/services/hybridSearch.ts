/*
 - filename: packages/engram-js/src/services/hybridSearch.ts
 - what is the file used for: hybrid search (vector + keyword with evidence fusion)
*/

import { embed } from "../embeddings/embed";
import { fuseEvidence, importanceMultiplier } from "../durable/scoring";
import { logger } from "../utils/logger";

export interface SearchResult {
  id: string;
  content: string;
  sector: string;
  score: number;
  vector_score: number;
  keyword_score: number;
  importance_score: number;
  importance_tier: string;
  embedding_synthetic?: boolean;
}

/** Minimal structural db type — avoids importing DurableExecutor (would cycle). */
export interface HybridDb {
  query(sql: string, params?: unknown[]): Promise<any>;
}

/**
 * Standalone hybrid search: vector similarity (memory-level embedding, plus
 * max-pooled `memory_windows` vectors when present) fused with pg_trgm
 * keyword similarity.
 *
 * Evidence fusion: P(relevant) = 1 - (1 - p_vec)(1 - p_lex), i.e. either
 * signal alone is enough, both together compound. The fused probability is
 * then scaled by the importance multiplier and combined with the same
 * contradiction/contract penalties the main recall path applies.
 *
 * NOTE: `recallDurableMemories` (durable/repository.ts) applies the same
 * fusion inline on its richer pipeline (provenance, contracts, modes,
 * candidate_ids). This class is the standalone equivalent for direct use.
 */
export class HybridSearch {
  private memoriesTable: string;
  private windowsTable: string;

  constructor(private db: HybridDb) {
    const schema = process.env.EG_PG_SCHEMA || "public";
    this.memoriesTable = `"${schema}"."memories"`;
    this.windowsTable = `"${schema}"."memory_windows"`;
  }

  async search(
    query: string,
    limit: number = 10,
    options: { excludeSynthetic?: boolean } = {},
  ): Promise<SearchResult[]> {
    const queryEmbedding = await embed(query);
    const embeddingStr = `[${queryEmbedding.join(",")}]`;
    const candidateLimit = Math.max(1, Math.min(limit * 3, 300));
    const excludeSynthetic = options.excludeSynthetic === true;

    // ── Vector search (max-pool windowed embeddings, fall back to full-memory embedding) ──
    const vectorResults = await this.db.query(
      `with vec as (
         select id, content, sector, importance_score, importance_tier, embedding_synthetic,
                max(vector_score) as vector_score
         from (
           select m.id, m.content, m.sector, m.importance_score, m.importance_tier, m.embedding_synthetic,
                  1 - (mw.embedding <=> $1::halfvec) as vector_score
           from ${this.memoriesTable} m
           join ${this.windowsTable} mw on mw.memory_id = m.id
           where m.memory_tier != 'archived' and m.superseded_at is null
           union all
           select m.id, m.content, m.sector, m.importance_score, m.importance_tier, m.embedding_synthetic,
                  1 - (m.embedding <=> $1::halfvec) as vector_score
           from ${this.memoriesTable} m
           where m.memory_tier != 'archived' and m.superseded_at is null
             and m.embedding is not null
         ) v
         group by id, content, sector, importance_score, importance_tier, embedding_synthetic
       )
       select * from vec
       where vector_score is not null${excludeSynthetic ? "\n         and not coalesce(embedding_synthetic, false)" : ""}
       order by vector_score desc
       limit $2`,
      [embeddingStr, candidateLimit],
    );

    // ── Keyword search using trigram similarity ──
    const keywordResults = await this.db.query(
      `select id, content, sector, importance_score, importance_tier, embedding_synthetic,
              similarity(content, $1) as keyword_score
       from ${this.memoriesTable}
       where memory_tier != 'archived'
         and superseded_at is null
         ${excludeSynthetic ? "and not coalesce(embedding_synthetic, false)" : ""}
         and similarity(content, $1) > 0.1
       order by keyword_score desc
       limit $2`,
      [query, candidateLimit],
    );

    // ── Evidence fusion ──
    const fused = this.fuseEvidence(
      (vectorResults.rows || []) as any[],
      (keywordResults.rows || []) as any[],
      limit,
    );

    logger.debug(
      { query, vectorCandidates: (vectorResults.rows || []).length, keywordCandidates: (keywordResults.rows || []).length, fused: fused.length },
      "Hybrid search complete",
    );

    return fused;
  }

  private fuseEvidence(
    vectorResults: any[],
    keywordResults: any[],
    limit: number,
  ): SearchResult[] {
    const resultMap = new Map<string, SearchResult>();

    // Index vector results
    for (const r of vectorResults) {
      resultMap.set(r.id, {
        id: r.id,
        content: r.content,
        sector: r.sector || "semantic",
        vector_score: r.vector_score ?? 0,
        keyword_score: 0,
        importance_score: Number(r.importance_score ?? 0.5),
        importance_tier: r.importance_tier || "medium",
        embedding_synthetic: Boolean(r.embedding_synthetic),
        score: 0,
      });
    }

    // Merge keyword results
    for (const r of keywordResults) {
      const existing = resultMap.get(r.id);
      if (existing) {
        existing.keyword_score = Math.min(Number(r.keyword_score ?? 0) * 2, 0.95);
      } else {
        resultMap.set(r.id, {
          id: r.id,
          content: r.content,
          sector: r.sector || "semantic",
          vector_score: 0,
          keyword_score: Math.min(Number(r.keyword_score ?? 0) * 2, 0.95),
          importance_score: Number(r.importance_score ?? 0.5),
          importance_tier: r.importance_tier || "medium",
          embedding_synthetic: Boolean(r.embedding_synthetic),
          score: 0,
        });
      }
    }

    // Fuse + importance multiplier
    for (const result of resultMap.values()) {
      const pFused = fuseEvidence(result.vector_score, result.keyword_score);
      result.score = pFused * importanceMultiplier(result.importance_score);
    }

    return Array.from(resultMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
