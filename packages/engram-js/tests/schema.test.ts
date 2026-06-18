import { describe, it, expect, vi } from 'vitest';
import { buildDurableSchemaSql, DURABLE_SCHEMA_VERSION, DURABLE_TABLES, DURABLE_EDGE_TYPES } from '../src/durable/schema';

describe('buildDurableSchemaSql', () => {
  it('returns an array of SQL statements', () => {
    const sql = buildDurableSchemaSql();
    expect(Array.isArray(sql)).toBe(true);
    expect(sql.length).toBeGreaterThan(0);
  });

  it('uses public schema by default', () => {
    const sql = buildDurableSchemaSql();
    const createSchema = sql[0];
    expect(createSchema).toMatch(/create schema.*public/i);
  });

  it('respects custom schema option', () => {
    const sql = buildDurableSchemaSql({ schema: 'engram_test' });
    const createSchema = sql[0];
    expect(createSchema).toMatch(/create schema.*engram_test/i);
  });

  it('respects custom vector dimension', () => {
    const sql = buildDurableSchemaSql({ vectorDim: 768 });
    // Find the memories table DDL
    const memoriesDDL = sql.find((s: string) => s.includes('create table') && s.includes('memories'));
    expect(memoriesDDL).toMatch(/halfvec\(768\)/);
  });

  it('includes all expected tables', () => {
    const sql = buildDurableSchemaSql();
    const allDDL = sql.join(' ');
    for (const table of DURABLE_TABLES) {
      expect(allDDL).toMatch(new RegExp(`create table if not exists.*${table}`, 'i'));
    }
  });

  it('produces deterministic output for the same options', () => {
    const sql1 = buildDurableSchemaSql({ schema: 'test', vectorDim: 1024 });
    const sql2 = buildDurableSchemaSql({ schema: 'test', vectorDim: 1024 });
    expect(sql1).toEqual(sql2);
  });

  it('snapshot: default public schema with default vector dim', () => {
    const sql = buildDurableSchemaSql();
    // Snapshot the first few key statements to lock in schema structure
    const keyStmts = sql.slice(0, 5);
    expect(keyStmts).toMatchSnapshot();
  });

  it('snapshot: full schema for custom options', () => {
    const sql = buildDurableSchemaSql({ schema: 'engram', vectorDim: 1536 });
    expect(sql).toMatchSnapshot();
  });
});

describe('DURABLE_SCHEMA_VERSION', () => {
  it('is a non-empty string', () => {
    expect(typeof DURABLE_SCHEMA_VERSION).toBe('string');
    expect(DURABLE_SCHEMA_VERSION.length).toBeGreaterThan(0);
  });
});

describe('DURABLE_EDGE_TYPES', () => {
  it('contains the expected edge types', () => {
    expect(DURABLE_EDGE_TYPES).toContain('supports');
    expect(DURABLE_EDGE_TYPES).toContain('contradicts');
    expect(DURABLE_EDGE_TYPES).toContain('derives_from');
    expect(DURABLE_EDGE_TYPES).toContain('causes');
    expect(DURABLE_EDGE_TYPES).toContain('related_to');
  });
});
