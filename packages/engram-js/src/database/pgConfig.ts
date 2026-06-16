/*
 - filename: packages/engram-js/src/database/pgconfig.ts
 - what is the file used for: builds the postgres pool options from environment variables
*/

import type { PoolConfig } from "pg";
import { load_env_files } from "../configuration/envFile";

load_env_files(__dirname);

type pg_cfg = PoolConfig & { statement_timeout?: number };

const pos = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const ssl = () =>
  process.env.EG_PG_SSL === "require"
    ? { rejectUnauthorized: false }
    : process.env.EG_PG_SSL === "disable"
      ? false
      : undefined;

export const build_pg_pool_config = (database: string): pg_cfg => ({
  host: process.env.EG_PG_HOST,
  port: process.env.EG_PG_PORT ? Number(process.env.EG_PG_PORT) : undefined,
  database,
  user: process.env.EG_PG_USER,
  password: process.env.EG_PG_PASSWORD,
  ssl: ssl(),
  max: pos("EG_PG_POOL_MAX", 10),
  idleTimeoutMillis: pos("EG_PG_IDLE_TIMEOUT_MS", 30000),
  connectionTimeoutMillis: pos("EG_PG_CONNECTION_TIMEOUT_MS", 5000),
  statement_timeout: pos("EG_PG_STATEMENT_TIMEOUT_MS", 30000),
});
