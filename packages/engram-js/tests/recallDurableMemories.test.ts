import { describe, it, expect, vi } from 'vitest';
import { recallDurableMemories, DurableExecutor, DurableRecallInput } from '../src/durable/repository';

// ── Mock DurableExecutor ─────────────────────────────────────────────────

function createMockDb(rows: any[]): DurableExecutor {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('recallDurableMemories', () => {
  it('throws for empty query', async () => {
    const db = createMockDb([]);
    await expect(
      recallDurableMemories(db, { query: '' } as DurableRecallInput),
    ).rejects.toThrow('query is required');
  });

  it('throws for whitespace-only query', async () => {
    const db = createMockDb([]);
    await expect(
      recallDurableMemories(db, { query: '   ' } as DurableRecallInput),
    ).rejects.toThrow('query is required');
  });

  it('throws for invalid mode', async () => {
    const db = createMockDb([]);
    await expect(
      recallDurableMemories(db, { query: 'test', mode: 'invalid' as any }),
    ).rejects.toThrow('mode must be strict, historical, or associative');
  });

  it('returns empty results when DB returns no rows', async () => {
    const db = createMockDb([]);
    const result = await recallDurableMemories(db, { query: 'hello world' });
    expect(result.query).toBe('hello world');
    expect(result.mode).toBe('associative');
    expect(result.results).toEqual([]);
  });

  it('passes ILIKE query and limit params correctly', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [] });
    const db: DurableExecutor = { query: queryFn };
    await recallDurableMemories(db, { query: 'test', limit: 3 });

    // Verify the query was called with the right params
    const [sql, params] = queryFn.mock.calls[0];
    expect(sql).toMatch(/m\.content ilike \$1/i);
    expect(params).toContain('%test%');
    // Default limit is 10, but we passed 3. The third param should be 3.
    // This is because $1=query, $2=atTime, $3=limit
    expect(params[2]).toBe(3);
  });

  it('respects user_id filter', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [] });
    const db: DurableExecutor = { query: queryFn };
    await recallDurableMemories(db, { query: 'test', user_id: 'user-123' });

    const [sql, params] = queryFn.mock.calls[0];
    expect(sql).toMatch(/m\.user_id = \$\d+/);
    expect(params).toContain('user-123');
  });

  it('respects project_id filter', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [] });
    const db: DurableExecutor = { query: queryFn };
    await recallDurableMemories(db, { query: 'test', project_id: 'proj-abc' });

    const [sql, params] = queryFn.mock.calls[0];
    expect(sql).toMatch(/m\.project_id/i);
    expect(params).toContain('proj-abc');
  });

  it('uses vector recall when embedding is provided', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [] });
    const db: DurableExecutor = { query: queryFn };
    const embedding = [0.1, 0.2, 0.3];
    await recallDurableMemories(db, { query: 'test', embedding });

    const [sql] = queryFn.mock.calls[0];
    expect(sql).toMatch(/<=>/); // vector distance operator
    expect(sql).toMatch(/vector_distance/);
    expect(sql).toMatch(/m\.embedding is not null/);
  });

  it('uses text ILIKE when embedding is empty', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [] });
    const db: DurableExecutor = { query: queryFn };
    await recallDurableMemories(db, { query: 'test', embedding: [] });

    const [sql] = queryFn.mock.calls[0];
    expect(sql).toMatch(/m\.content ilike \$1/);
    expect(sql).not.toMatch(/<=>/);
  });

  it('clamps limit to 1-100 range', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [] });
    const db: DurableExecutor = { query: queryFn };

    // Too low: negative values get clamped to 1
    await recallDurableMemories(db, { query: 'test', limit: -5 });
    expect(queryFn.mock.calls[0][1][2]).toBe(1);

    // Too high
    await recallDurableMemories(db, { query: 'test', limit: 500 });
    expect(queryFn.mock.calls[1][1][2]).toBe(100);
  });

  it('filters by candidate_ids when provided', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [] });
    const db: DurableExecutor = { query: queryFn };
    await recallDurableMemories(db, { query: 'test', candidate_ids: ['id-1', 'id-2'] });

    const [sql, params] = queryFn.mock.calls[0];
    expect(sql).toMatch(/m\.id = any/i);
    expect(sql).toMatch(/array_position/);
    expect(params).toContainEqual(['id-1', 'id-2']);
  });

  it('applies strict mode filters', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [] });
    const db: DurableExecutor = { query: queryFn };
    await recallDurableMemories(db, { query: 'test', mode: 'strict' });

    const [sql] = queryFn.mock.calls[0];
    // strict mode adds: provenance existence check, contradiction exclusion, recall_allowed
    expect(sql).toContain('"provenance" strict_p');
    expect(sql).toContain('"contradictions" strict_c');
    expect(sql).toContain('recall_allowed');
  });

  it('memoizes historical mode ordering', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [] });
    const db: DurableExecutor = { query: queryFn };
    await recallDurableMemories(db, { query: 'test', mode: 'historical' });

    const [sql] = queryFn.mock.calls[0];
    expect(sql).toMatch(/recorded_at desc/);
  });

  it('maps row data correctly in results', async () => {
    const fakeRows = [
      {
        id: 'mem-1',
        content: 'test memory',
        facets: { key: 'val' },
        contracts: '{}',
        metadata: '{}',
        salience: 0.8,
        confidence: 0.9,
        recorded_at: '2025-01-01T00:00:00Z',
        valid_from: null,
        valid_to: null,
        sector: 'semantic',
        vector_distance: null,
        provenance: [],
        contradictions: [],
      },
    ];
    const db = createMockDb(fakeRows);
    const result = await recallDurableMemories(db, { query: 'test' });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe('mem-1');
    expect(result.results[0].content).toBe('test memory');
    expect(result.results[0].score).toBeGreaterThan(0);
  });
});
