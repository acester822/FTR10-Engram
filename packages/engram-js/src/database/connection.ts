/*
 - filename: packages/engram-js/src/database/connection.ts
 - what is the file used for: postgres query helpers used by durable repository calls
*/

import { Pool } from "pg";
import type { PoolClient } from "pg";
import { build_pg_pool_config } from "./pgConfig";
import { logger } from "../utils/logger";

const POOL_OPTIONS = build_pg_pool_config(process.env.EG_PG_DB || "engram");
const pool = new Pool({
  ...POOL_OPTIONS,
  max: POOL_OPTIONS.max ?? 20,
  idleTimeoutMillis: 60_000,
  allowExitOnIdle: false,
});

// Log pool errors so stale connections don't cause silent failures
pool.on("error", (err: Error) => {
  logger.error({ module: 'pgpool', err }, "PostgreSQL pool error");
});

let txc: PoolClient | null = null;
let txDepth = 0;

const query = async (sql: string, params: any[] = []) => {
  return await (txc || pool).query(sql, params);
};

export const run_async = async (
  sql: string,
  params: any[] = [],
): Promise<void> => {
  await query(sql, params);
};

export const get_async = async (
  sql: string,
  params: any[] = [],
): Promise<any> => (await query(sql, params)).rows[0];

export const all_async = async (
  sql: string,
  params: any[] = [],
): Promise<any[]> => (await query(sql, params)).rows;

/**
 * Nested transaction support via depth tracking.
 * `begin()` increments depth; the actual PG `BEGIN` only fires at depth 0→1.
 * `commit()` decrements depth; the actual PG `COMMIT` only fires at depth 1→0.
 * `rollback()` resets depth to 0 and rolls back immediately.
 *
 * This allows functions like `rememberDurableMemory` (which manage their own
 * BEGIN/COMMIT internally) to be safely wrapped in an outer transaction by
 * compaction/consolidation engines.
 */
export const transaction = {
  begin: async () => {
    if (txDepth === 0) {
      if (txc) throw new Error("transaction active but depth is 0 — state corruption");
      txc = await pool.connect();
      await txc.query("BEGIN");
    }
    txDepth++;
  },
  commit: async () => {
    if (txDepth <= 0) return;
    txDepth--;
    if (txDepth === 0) {
      if (!txc) return;
      try {
        await txc.query("COMMIT");
      } finally {
        txc.release();
        txc = null;
      }
    }
  },
  rollback: async () => {
    if (txDepth === 0 || !txc) return;
    txDepth = 0;
    try {
      await txc.query("ROLLBACK");
    } finally {
      txc.release();
      txc = null;
    }
  },
};

export const close_database = async () => {
  txDepth = 0;
  if (txc) {
    txc.release();
    txc = null;
  }
  await pool.end();
};
