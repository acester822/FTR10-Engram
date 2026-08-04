/*
 - filename: packages/engram-js/src/services/bitemporalMemory.ts
 - what is the file used for: bitemporal tracking (recorded_at vs observed_at, validity windows)
*/

import { logger } from "../utils/logger";

interface BitemporalQuery {
  as_of?: Date; // Query as of this time (observed_at)
  valid_at?: Date; // Query for facts valid at this time
}

/** Minimal structural db type — avoids importing DurableExecutor (would cycle). */
export interface BitemporalDb {
  query(sql: string, params?: unknown[]): Promise<any>;
}

/**
 * Bitemporal memory helpers.
 *
 * Engram's `memories` table already carries the bitemporal columns
 * (`observed_at`, `valid_from`, `valid_to`, `recorded_at`, `superseded_at`).
 * `rememberDurableMemory` writes the defaults at insert time
 * (observed_at = when the fact was learned, valid_from = observed_at unless a
 * source/metadata override is given). This service exposes the explicit
 * temporal operations: store/update validity, query as-of / valid-at, and
 * supersede.
 */
export class BitemporalMemory {
  private memoriesTable: string;

  constructor(private db: BitemporalDb) {
    const schema = process.env.EG_PG_SCHEMA || "public";
    this.memoriesTable = `"${schema}"."memories"`;
  }

  /**
   * Store bitemporal metadata on an existing memory.
   * observed_at = when we learned the fact; valid_from/valid_to = when the
   * fact is (was) true in the world.
   */
  async storeWithTemporal(
    memoryId: string,
    observedAt: Date,
    validFrom?: Date,
    validTo?: Date,
  ): Promise<void> {
    await this.db.query(
      `update ${this.memoriesTable}
       set observed_at = $2, valid_from = $3, valid_to = $4
       where id = $1`,
      [memoryId, observedAt.toISOString(), (validFrom || observedAt).toISOString(), validTo ? validTo.toISOString() : null],
    );

    logger.debug(
      {
        memoryId,
        observedAt,
        validFrom: validFrom || observedAt,
        validTo,
      },
      "Stored bitemporal metadata",
    );
  }

  /** Query memories observed (learned) as of a specific time. */
  async queryAsOf(asOf: Date, limit: number = 10): Promise<any[]> {
    const result = await this.db.query(
      `select * from ${this.memoriesTable}
       where observed_at <= $1
         and (valid_to is null or valid_to > $1)
         and memory_tier != 'archived'
         and superseded_at is null
       order by observed_at desc
       limit $2`,
      [asOf.toISOString(), limit],
    );
    return result.rows || [];
  }

  /** Query memories whose validity window covers a specific time. */
  async queryValidAt(validAt: Date, limit: number = 10): Promise<any[]> {
    const result = await this.db.query(
      `select * from ${this.memoriesTable}
       where valid_from <= $1
         and (valid_to is null or valid_to > $1)
         and memory_tier != 'archived'
         and superseded_at is null
       order by valid_from desc
       limit $2`,
      [validAt.toISOString(), limit],
    );
    return result.rows || [];
  }

  /** Update a memory's validity window. */
  async updateValidity(
    memoryId: string,
    validFrom: Date,
    validTo?: Date,
  ): Promise<void> {
    await this.db.query(
      `update ${this.memoriesTable}
       set valid_from = $2, valid_to = $3
       where id = $1`,
      [memoryId, validFrom.toISOString(), validTo ? validTo.toISOString() : null],
    );
  }

  /**
   * Supersede a memory: close its validity window and archive it so recall
   * (which filters on `superseded_at is null` and `valid_to`) drops it.
   */
  async supersede(memoryId: string, supersededAt: Date): Promise<void> {
    await this.db.query(
      `update ${this.memoriesTable}
       set valid_to = $2, memory_tier = 'archived', superseded_at = $2
       where id = $1`,
      [memoryId, supersededAt.toISOString()],
    );

    logger.info({ memoryId, supersededAt }, "Memory superseded");
  }
}
