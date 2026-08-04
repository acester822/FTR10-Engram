# Implementation Plan: Advanced Memory Features

## Overview

Implementing four advanced features from Compartment and Engraphis to enhance Engram's memory system:

1. **Hybrid Search** (vector + keyword with evidence fusion)
2. **Windowed Embeddings** for long memories
3. **Importance Tiers** for ranking
4. **Bitemporal Tracking** (`recorded_at vs observed_at`)

---

## Phase 1: Database Schema Updates

### 1.1 Create Migration File

**File:** `packages/engram-js/src/database/migrations/4.0.0-advanced-features.ts`

```typescript
import { Pool } from 'pg';

export async function up(db: Pool): Promise<void> {
  // Add bitemporal fields
  await db.query(`
    ALTER TABLE memories 
    ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS importance_tier TEXT DEFAULT 'medium',
    ADD COLUMN IF NOT EXISTS importance_score REAL DEFAULT 0.5;
  `);

  // Add keyword search support with pg_trgm
  await db.query(`
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE INDEX IF NOT EXISTS idx_memories_content_trgm 
    ON memories USING gin (content gin_trgm_ops);
  `);

  // Add windowed embedding support
  await db.query(`
    CREATE TABLE IF NOT EXISTS memory_windows (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      memory_id UUID REFERENCES memories(id) ON DELETE CASCADE,
      window_index INTEGER NOT NULL,
      start_pos INTEGER NOT NULL,
      end_pos INTEGER NOT NULL,
      embedding vector(768),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_memory_windows_memory_id 
    ON memory_windows(memory_id);
    CREATE INDEX IF NOT EXISTS idx_memory_windows_embedding 
    ON memory_windows USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  `);

  // Update existing memories with defaults
  await db.query(`
    UPDATE memories 
    SET observed_at = COALESCE(observed_at, recorded_at),
        importance_tier = 'medium',
        importance_score = 0.5
    WHERE observed_at IS NULL;
  `);
}

export async function down(db: Pool): Promise<void> {
  await db.query(`DROP TABLE IF EXISTS memory_windows;`);
  await db.query(`
    ALTER TABLE memories 
    DROP COLUMN IF EXISTS observed_at,
    DROP COLUMN IF EXISTS valid_from,
    DROP COLUMN IF EXISTS valid_to,
    DROP COLUMN IF EXISTS importance_tier,
    DROP COLUMN IF EXISTS importance_score;
  `);
}
```

---

## Phase 2: Windowed Embeddings

### 2.1 Windowed Embedding Service

**File:** `packages/engram-js/src/services/windowedEmbedder.ts`

```typescript
import { Pool } from 'pg';
import { embed } from './embedder';
import { logger } from '../utils/logger';

const WINDOW_SIZE = 448; // tokens
const STRIDE = 384; // tokens (64 token overlap)
const MAX_WINDOWS = 64;

interface MemoryWindow {
  window_index: number;
  start_pos: number;
  end_pos: number;
  embedding: number[];
}

export class WindowedEmbedder {
  constructor(private db: Pool) {}

  /**
   * Create windowed embeddings for long memories
   * Uses overlapping windows to ensure no fact is cut in half
   */
  async embedMemory(memoryId: string, content: string): Promise<void> {
    const tokens = this.tokenize(content);
    const windows = this.createWindows(tokens);
    
    logger.debug({ 
      memoryId, 
      tokenCount: tokens.length, 
      windowCount: windows.length 
    }, 'Creating windowed embeddings');

    for (const window of windows) {
      const windowText = this.detokenize(tokens.slice(window.start_pos, window.end_pos));
      const embedding = await embed(windowText);

      await this.db.query(`
        INSERT INTO memory_windows (memory_id, window_index, start_pos, end_pos, embedding)
        VALUES ($1, $2, $3, $4, $5::vector)
        ON CONFLICT (memory_id, window_index) 
        DO UPDATE SET embedding = EXCLUDED.embedding, start_pos = EXCLUDED.start_pos, end_pos = EXCLUDED.end_pos
      `, [memoryId, window.window_index, window.start_pos, window.end_pos, `[${embedding.join(',')}]`]);
    }

    // Also store the full memory embedding for short memories
    if (windows.length === 1) {
      const fullEmbedding = await embed(content);
      await this.db.query(`
        UPDATE memories SET embedding = $1::vector WHERE id = $2
      `, [`[${fullEmbedding.join(',')}]`, memoryId]);
    }
  }

  private createWindows(tokens: string[]): MemoryWindow[] {
    const windows: MemoryWindow[] = [];
    const numWindows = Math.min(
      Math.ceil(Math.max(0, tokens.length - WINDOW_SIZE) / STRIDE) + 1,
      MAX_WINDOWS
    );

    for (let i = 0; i < numWindows; i++) {
      const start = i * STRIDE;
      const end = Math.min(start + WINDOW_SIZE, tokens.length);
      
      windows.push({
        window_index: i,
        start_pos: start,
        end_pos: end,
        embedding: [] // Will be filled later
      });
    }

    return windows;
  }

  private tokenize(text: string): string[] {
    // Simple tokenization - split on whitespace and punctuation
    // In production, use a proper tokenizer like tiktoken
    return text.split(/\s+/).filter(t => t.length > 0);
  }

  private detokenize(tokens: string[]): string {
    return tokens.join(' ');
  }
}
```

### 2.2 Update Memory Storage

**File:** `packages/engram-js/src/durable/repository.ts`

```typescript
import { WindowedEmbedder } from '../services/windowedEmbedder';

export async function rememberDurableMemory(
  db: any,
  input: { content: string; user_id: string; project_id?: string; metadata?: any }
): Promise<void> {
  const windowedEmbedder = new WindowedEmbedder(db);
  
  // ... existing insertion logic ...
  
  const result = await db.query(`
    INSERT INTO memories (content, user_id, project_id, metadata, recorded_at, observed_at, importance_tier)
    VALUES ($1, $2, $3, $4, NOW(), NOW(), $5)
    RETURNING id
  `, [input.content, input.user_id, input.project_id, input.metadata, 'medium']);

  const memoryId = result.rows[0].id;

  // Create windowed embeddings
  await windowedEmbedder.embedMemory(memoryId, input.content);
}
```

---

## Phase 3: Hybrid Search with Evidence Fusion

### 3.1 Hybrid Search Service

**File:** `packages/engram-js/src/services/hybridSearch.ts`

```typescript
import { Pool } from 'pg';
import { embed } from './embedder';
import { logger } from '../utils/logger';

interface SearchResult {
  id: string;
  content: string;
  sector: string;
  score: number;
  vector_score: number;
  keyword_score: number;
  importance_score: number;
}

export class HybridSearch {
  constructor(private db: Pool) {}

  /**
   * Hybrid search combining vector similarity and keyword matching
   * Uses evidence fusion: P(relevant) = 1 - (1 - p_vec)(1 - p_lex)
   */
  async search(query: string, limit: number = 10): Promise<SearchResult[]> {
    const queryEmbedding = await embed(query);
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    // Vector search with windowed embeddings (max-pooling)
    const vectorResults = await this.db.query(`
      SELECT DISTINCT ON (m.id) 
        m.id, m.content, m.sector, m.importance_score,
        1 - (mw.embedding <=> $1::vector) as vector_score
      FROM memories m
      LEFT JOIN memory_windows mw ON m.id = mw.memory_id
      WHERE m.memory_tier != 'archived'
        AND (mw.embedding <=> $1::vector) IS NOT NULL
      ORDER BY m.id, vector_score DESC
      LIMIT $2
    `, [embeddingStr, limit * 3]); // Get more candidates for fusion

    // Keyword search using trigram similarity
    const keywordResults = await this.db.query(`
      SELECT 
        id, content, sector, importance_score,
        similarity(content, $1) as keyword_score
      FROM memories
      WHERE memory_tier != 'archived'
        AND content % $1  -- trigram similarity threshold
      ORDER BY keyword_score DESC
      LIMIT $2
    `, [query, limit * 3]);

    // Evidence fusion
    const fusedResults = this.fuseEvidence(
      vectorResults.rows,
      keywordResults.rows,
      limit
    );

    return fusedResults;
  }

  private fuseEvidence(
    vectorResults: any[],
    keywordResults: any[],
    limit: number
  ): SearchResult[] {
    const resultMap = new Map<string, SearchResult>();

    // Index vector results
    for (const r of vectorResults) {
      const p_vec = this.clamp((r.vector_score - 0.25) / (0.85 - 0.25), 0, 0.88);
      resultMap.set(r.id, {
        id: r.id,
        content: r.content,
        sector: r.sector,
        vector_score: p_vec,
        keyword_score: 0,
        importance_score: r.importance_score || 0.5,
        score: 0
      });
    }

    // Merge keyword results
    for (const r of keywordResults) {
      const p_lex = this.calculateLexicalProbability(r.keyword_score, keywordResults.length);
      
      if (resultMap.has(r.id)) {
        const existing = resultMap.get(r.id)!;
        existing.keyword_score = p_lex;
      } else {
        resultMap.set(r.id, {
          id: r.id,
          content: r.content,
          sector: r.sector,
          vector_score: 0,
          keyword_score: p_lex,
          importance_score: r.importance_score || 0.5,
          score: 0
        });
      }
    }

    // Calculate fused scores
    for (const result of resultMap.values()) {
      // Evidence fusion: P(relevant) = 1 - (1 - p_vec)(1 - p_lex)
      const p_fused = 1 - (1 - result.vector_score) * (1 - result.keyword_score);
      
      // Apply importance multiplier
      const importance_multiplier = 1 + 0.15 * (2 * result.importance_score - 1);
      result.score = p_fused * importance_multiplier;
    }

    // Sort and limit
    return Array.from(resultMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private calculateLexicalProbability(similarity: number, totalResults: number): number {
    // Convert trigram similarity to probability
    // Higher similarity = higher probability
    return Math.min(similarity * 2, 0.95);
  }
}
```

### 3.2 Update Memory Injector

**File:** `packages/engram-js/src/services/memoryInjector.ts`

```typescript
import { HybridSearch } from './hybridSearch';

export class MemoryInjector {
  private hybridSearch: HybridSearch;

  constructor(private db: any) {
    this.hybridSearch = new HybridSearch(db);
  }

  async recallMemories(query: string, limit: number = 5): Promise<PhenotypeMemory[]> {
    // Use hybrid search instead of pure vector search
    const results = await this.hybridSearch.search(query, limit);

    return results.map(r => ({
      id: r.id,
      content: r.content,
      sector: r.sector,
      score: r.score
    }));
  }
}
```

---

## Phase 4: Importance Tiers

### 4.1 Importance Calculator

**File:** `packages/engram-js/src/services/importanceCalculator.ts`

```typescript
import { logger } from '../utils/logger';

export type ImportanceTier = 'critical' | 'high' | 'medium' | 'low';

interface ImportanceConfig {
  tier: ImportanceTier;
  score: number;
  decay_rate: number;
}

const TIER_CONFIG: Record<ImportanceTier, ImportanceConfig> = {
  critical: { tier: 'critical', score: 0.90, decay_rate: 0.01 },
  high: { tier: 'high', score: 0.75, decay_rate: 0.05 },
  medium: { tier: 'medium', score: 0.50, decay_rate: 0.15 },
  low: { tier: 'low', score: 0.25, decay_rate: 0.30 }
};

export class ImportanceCalculator {
  /**
   * Calculate importance tier based on memory content and metadata
   */
  calculate(content: string, metadata?: any): ImportanceConfig {
    let tier: ImportanceTier = 'medium';

    // Critical: Explicit user requests to remember
    if (this.hasExplicitRememberRequest(content)) {
      tier = 'critical';
    }
    // High: Decisions, preferences, architectural choices
    else if (this.isDecisionOrPreference(content, metadata)) {
      tier = 'high';
    }
    // Low: Transient facts, temporary information
    else if (this.isTransient(content, metadata)) {
      tier = 'low';
    }

    logger.debug({ tier, content: content.substring(0, 50) }, 'Calculated importance tier');
    return TIER_CONFIG[tier];
  }

  private hasExplicitRememberRequest(content: string): boolean {
    const patterns = [
      /remember this/i,
      /save this/i,
      /always remember/i,
      /don't forget/i,
      /important:/i
    ];
    return patterns.some(p => p.test(content));
  }

  private isDecisionOrPreference(content: string, metadata?: any): boolean {
    const patterns = [
      /i prefer/i,
      /i like/i,
      /always use/i,
      /never use/i,
      /decision:/i,
      /architecture:/i,
      /we decided/i
    ];
    
    if (patterns.some(p => p.test(content))) return true;
    
    // Check metadata for sector hints
    if (metadata?.sector === 'procedural' || metadata?.sector === 'semantic') {
      return true;
    }

    return false;
  }

  private isTransient(content: string, metadata?: any): boolean {
    const patterns = [
      /today/i,
      /this week/i,
      /temporary/i,
      /just for now/i
    ];
    
    if (patterns.some(p => p.test(content))) return true;
    
    if (metadata?.sector === 'episodic') {
      return true;
    }

    return false;
  }
}
```

### 4.2 Update Memory Storage

**File:** `packages/engram-js/src/durable/repository.ts`

```typescript
import { ImportanceCalculator } from '../services/importanceCalculator';

export async function rememberDurableMemory(
  db: any,
  input: { content: string; user_id: string; project_id?: string; metadata?: any }
): Promise<void> {
  const importanceCalc = new ImportanceCalculator();
  const importance = importanceCalc.calculate(input.content, input.metadata);

  const result = await db.query(`
    INSERT INTO memories (
      content, user_id, project_id, metadata, 
      recorded_at, observed_at, 
      importance_tier, importance_score, decay_rate
    )
    VALUES ($1, $2, $3, $4, NOW(), NOW(), $5, $6, $7)
    RETURNING id
  `, [
    input.content, 
    input.user_id, 
    input.project_id, 
    input.metadata,
    importance.tier,
    importance.score,
    importance.decay_rate
  ]);

  // ... rest of the function
}
```

---

## Phase 5: Bitemporal Tracking

### 5.1 Bitemporal Memory Service

**File:** `packages/engram-js/src/services/bitemporalMemory.ts`

```typescript
import { Pool } from 'pg';
import { logger } from '../utils/logger';

interface BitemporalQuery {
  as_of?: Date; // Query as of this time (observed_at)
  valid_at?: Date; // Query for facts valid at this time
}

export class BitemporalMemory {
  constructor(private db: Pool) {}

  /**
   * Store a memory with bitemporal metadata
   */
  async storeWithTemporal(
    memoryId: string,
    observedAt: Date,
    validFrom?: Date,
    validTo?: Date
  ): Promise<void> {
    await this.db.query(`
      UPDATE memories
      SET observed_at = $2,
          valid_from = $3,
          valid_to = $4
      WHERE id = $1
    `, [memoryId, observedAt, validFrom || observedAt, validTo]);

    logger.debug({ 
      memoryId, 
      observedAt, 
      validFrom: validFrom || observedAt, 
      validTo 
    }, 'Stored bitemporal metadata');
  }

  /**
   * Query memories as of a specific time
   */
  async queryAsOf(asOf: Date, limit: number = 10): Promise<any[]> {
    const result = await this.db.query(`
      SELECT * FROM memories
      WHERE observed_at <= $1
        AND (valid_to IS NULL OR valid_to > $1)
        AND memory_tier != 'archived'
      ORDER BY observed_at DESC
      LIMIT $2
    `, [asOf, limit]);

    return result.rows;
  }

  /**
   * Query memories valid at a specific time
   */
  async queryValidAt(validAt: Date, limit: number = 10): Promise<any[]> {
    const result = await this.db.query(`
      SELECT * FROM memories
      WHERE valid_from <= $1
        AND (valid_to IS NULL OR valid_to > $1)
        AND memory_tier != 'archived'
      ORDER BY valid_from DESC
      LIMIT $2
    `, [validAt, limit]);

    return result.rows;
  }

  /**
   * Update a memory's validity period
   */
  async updateValidity(
    memoryId: string,
    validFrom: Date,
    validTo?: Date
  ): Promise<void> {
    await this.db.query(`
      UPDATE memories
      SET valid_from = $2, valid_to = $3
      WHERE id = $1
    `, [memoryId, validFrom, validTo]);
  }

  /**
   * Supersede a memory (mark it as no longer valid)
   */
  async supersede(memoryId: string, supersededAt: Date): Promise<void> {
    await this.db.query(`
      UPDATE memories
      SET valid_to = $2,
          memory_tier = 'archived'
      WHERE id = $1
    `, [memoryId, supersededAt]);

    logger.info({ memoryId, supersededAt }, 'Memory superseded');
  }
}
```

### 5.2 Update Memory Extraction

**File:** `packages/engram-js/src/services/memoryLogger.ts`

```typescript
import { BitemporalMemory } from './bitemporalMemory';

export async function logInteractionAsync(
  userPrompt: string,
  llmResponseText: string
): Promise<{ storedCount: number }> {
  const bitemporal = new BitemporalMemory(db);
  
  // ... existing extraction logic ...

  for (const mem of extractedMemories) {
    const result = await db.query(`
      INSERT INTO memories (...)
      VALUES (...)
      RETURNING id, recorded_at
    `, [...]);

    const memoryId = result.rows[0].id;
    const recordedAt = result.rows[0].recorded_at;

    // Store bitemporal metadata
    // observed_at = when we learned it (recorded_at)
    // valid_from = when the fact became true (could be earlier)
    await bitemporal.storeWithTemporal(
      memoryId,
      recordedAt,
      mem.valid_from || recordedAt,
      mem.valid_to
    );
  }
}
```

---

## Phase 6: Testing & Validation

### 6.1 Test Suite

**File:** `packages/engram-js/tests/advanced-features.test.ts`

```typescript
import { HybridSearch } from '../src/services/hybridSearch';
import { WindowedEmbedder } from '../src/services/windowedEmbedder';
import { ImportanceCalculator } from '../src/services/importanceCalculator';

describe('Advanced Memory Features', () => {
  describe('HybridSearch', () => {
    it('should fuse vector and keyword evidence correctly', async () => {
      const search = new HybridSearch(db);
      const results = await search.search('JWT authentication');
      
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].vector_score).toBeGreaterThanOrEqual(0);
      expect(results[0].keyword_score).toBeGreaterThanOrEqual(0);
      expect(results[0].score).toBeGreaterThan(0);
    });
  });

  describe('WindowedEmbedder', () => {
    it('should create multiple windows for long content', async () => {
      const embedder = new WindowedEmbedder(db);
      const longContent = 'word '.repeat(1000); // 1000 words
      
      await embedder.embedMemory('test-id', longContent);
      
      const windows = await db.query(
        'SELECT * FROM memory_windows WHERE memory_id = $1',
        ['test-id']
      );
      
      expect(windows.rows.length).toBeGreaterThan(1);
    });
  });

  describe('ImportanceCalculator', () => {
    it('should assign critical tier to explicit remember requests', () => {
      const calc = new ImportanceCalculator();
      const result = calc.calculate('Remember this: always use TypeScript');
      
      expect(result.tier).toBe('critical');
      expect(result.score).toBe(0.90);
    });
  });
});
```

---


---

## ✅ Implementation Summary (2026-08-04)

All four features from this plan were implemented into the Engram codebase, **adapted to the actual architecture** — the plan's assumptions diverged from reality in several places (noted below). Build (`tsc`) is clean, all 63 vitest tests pass, and the Docker image was rebuilt so the live API (`:8098`) runs the new code.

### What changed (files)

| Area | File | Change |
|---|---|---|
| Schema (Phase 1) | `packages/engram-js/src/durable/schema.ts` | Added `memories.importance_tier` (`text NOT NULL DEFAULT 'medium'`) + `memories.importance_score` (`real NOT NULL DEFAULT 0.5`); `pg_trgm` extension + GIN trigram index on `memories.content`; new `memory_windows` table (halfvec embedding, `UNIQUE(memory_id, window_index)`, HNSW index). Bumped `DURABLE_SCHEMA_VERSION` → `4.0.0-advanced-features`. |
| Windowed embeddings (Phase 2) | `src/services/windowedEmbedder.ts` (new) + `src/durable/repository.ts` | `WindowedEmbedder` class + exported pure `tokenize()`/`createWindows()` (448-token windows, 384 stride, 64 max). `rememberDurableMemory` now writes window embeddings **inside the transaction** for content >448 tokens (or `metadata.windowed === true`). Short memories keep the caller-stored full embedding — zero extra cost for the common case. |
| Hybrid search (Phase 3) | `src/services/hybridSearch.ts` (new), `src/durable/scoring.ts`, `src/durable/repository.ts`, `src/services/memoryInjector.ts`, `src/api/routes/memories/create/route.ts` | `HybridSearch` standalone service (vector via max-pooled windows + fallback to `memories.embedding`, keyword via pg_trgm `similarity`, evidence fusion `P = 1-(1-p_vec)(1-p_lex)`, importance multiplier). Pure fusion math lives in `scoring.ts` (`vectorProbability`, `lexicalProbability`, `fuseEvidence`, `importanceMultiplier`, `hybridRecallScore`) — unit-tested. `recallDurableMemories` applies the same fusion **on by default** in vector-recall mode: pulls 3× candidates, unions a trigram keyword candidate query, re-ranks by fused score (contradiction/contract penalties preserved). Escape hatches: `hybrid: false` per call, or `EG_HYBRID_SEARCH=false` globally. Text-only recall (e.g. per-turn chat injection) is untouched. `MemoryInjector.recallMemories()` added per plan §3.2. |
| Importance tiers (Phase 4) | `src/services/importanceCalculator.ts` (new) + `src/durable/repository.ts` | `ImportanceCalculator` exactly per plan (critical/high/medium/low, explicit-request → decision/preference → transient heuristics + sector hints). `rememberDurableMemory` computes it at the ingest chokepoint (metadata `importance_tier`/`importance_score` override wins) and returns it in the result. **Deviation:** per-tier `decay_rate` is informational only — Engram's temporal-decay engine keeps its own genome/phenotype rates, so importance does NOT clobber `memories.decay_rate`. |
| Bitemporal (Phase 5) | `src/services/bitemporalMemory.ts` (new) + `src/durable/repository.ts` | `BitemporalMemory` service (storeWithTemporal, queryAsOf, queryValidAt, updateValidity, supersede). The `memories` table already had `observed_at`/`valid_from`/`valid_to`/`recorded_at`/`superseded_at` — `rememberDurableMemory` now writes them properly on every insert: `observed_at` = when learned, `valid_from` defaults to `observed_at`, `valid_to` optional (input fields or metadata). Extraction-path wiring (plan §5.2) was unnecessary because the defaults happen at the repository chokepoint. |
| Tests (Phase 6) | `tests/advanced-features.test.ts` (new), `tests/schema.test.ts` (snapshots updated) | 17 new tests: ImportanceCalculator tiers, fusion math, importance multiplier, hybrid penalties, windowing (overlap, cap, single-window). |

### Bonus fix
- `rememberDurableMemory` returned hardcoded `isGenome: false` while computing the real value — now returns the actual classification.

### Plan ↔ reality deviations
1. **No versioned migration files** — this repo's migrations are an idempotent statement list in `schema.ts` run at boot (`run_migrations` in `startServer`). The proposed `4.0.0-advanced-features.ts` became a statement block there.
2. **No `MemoryInjector.recallMemories` existed** — recall flows through `recallDurableMemories` (repository chokepoint used by `/recall`, `Memory.search`, chat injection). Hybrid fusion was integrated there so every consumer benefits; the standalone `HybridSearch` service was still added per the plan and is exercised by `MemoryInjector.recallMemories`.
3. **`vector(768)` → `halfvec(dim)`** — the codebase stores embeddings as `halfvec` (HNSW), so window embeddings match that type and dimension (`EG_VEC_DIM`).
4. **Backfill UPDATE skipped** — `ADD COLUMN ... NOT NULL DEFAULT` backfills existing rows metadata-only in PG 11+, and `observed_at` was already populated on every insert.
5. **Importance `decay_rate` not applied** (see above) — kept the tuned genome/phenotype decay rates.

### API surface
- `POST /memories` response now includes `importance_tier` / `importance_score` (computed at write).
- `/recall` results include `importance_tier`, `importance_score`, `vector_score`, `lexical_score`.
- Memory Explorer (`GET /api/dashboard/memories`) inherits the columns via `SELECT *`; the **Memory Explorer tab now renders an IMPORTANCE column** (colored tier pill + score) in `apps/web/src/App.tsx`.

### Verification performed
- `npm run build` (tsc strict) — clean
- `npx vitest run -u` — **63/63 pass**
- Docker image rebuilt; on boot the migration creates the new columns/table/index (check `docker logs` for `[MIGRATE]`; probe with `SELECT column_name FROM information_schema.columns WHERE table_name='memories' AND column_name LIKE 'importance%'`)
- Recall is hybrid-fused by default; disable via `EG_HYBRID_SEARCH=false` if any regression appears.
