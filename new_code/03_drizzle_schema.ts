/*
 * ORM Equivalent for Drizzle (schema.ts)
 */

export const memories = sqliteTable('memories', { // or pgTable
  // ... your existing id, content, sector, embedding columns ...
  isGenome: boolean('is_genome').default(false),
  decayRate: real('decay_rate').default(0.1),
  accessCount: integer('access_count').default(0),
  lastAccessed: timestamp('last_accessed').defaultNow(),
  consolidationHash: text('consolidation_hash'),
});
