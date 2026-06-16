/*
 - filename: packages/engram-js/src/database/connection.ts
 - what is the file used for: postgres query helpers used by durable repository calls
*/

import { Pool } from "pg";
import type { PoolClient } from "pg";
import { build_pg_pool_config } from "./pgConfig";

const pool = new Pool(build_pg_pool_config(process.env.EG_PG_DB || "engram"));
let txc: PoolClient | null = null;

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

export const transaction = {
  begin: async () => {
    if (txc) throw new Error("transaction active");
    txc = await pool.connect();
    await txc.query("BEGIN");
  },
  commit: async () => {
    if (!txc) return;
    try {
      await txc.query("COMMIT");
    } finally {
      txc.release();
      txc = null;
    }
  },
  rollback: async () => {
    if (!txc) return;
    try {
      await txc.query("ROLLBACK");
    } finally {
      txc.release();
      txc = null;
    }
  },
};

export const close_database = async () => {
  if (txc) {
    txc.release();
    txc = null;
  }
  await pool.end();
};
