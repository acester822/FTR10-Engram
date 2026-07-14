/*
 * scripts/hardDeleteInvalidSectors.ts
 *
 * Hard-deletes (physically removes) memories whose `sector` is NOT one of the
 * 5 canonical sectors (semantic | procedural | episodic | emotional | reflective).
 * Includes superseded rows — this is a true purge, not a soft delete.
 *
 * DRY RUN by default. Pass --apply to actually delete.
 */

import { all_async, run_async } from "../src/database/connection";
import { close_database } from "../src/database/connection";
import { VALID_SECTORS } from "../src/services/memoryInjector";

const VALID = VALID_SECTORS as readonly string[];
const APPLY = process.argv.includes("--apply");
const SCHEMA = process.env.EG_PG_SCHEMA || "public";

async function main() {
  const rows = (await all_async(
    `select id, sector, is_genome, project_id, content
       from "${SCHEMA}"."memories"
      where sector is not null
        and sector != all($1::text[])
      order by sector, recorded_at`,
    [VALID]
  )) as any[];

  console.log(
    `\nFound ${rows.length} memories (active + superseded) under invalid sectors.`
  );
  const bySector: Record<string, number> = {};
  for (const r of rows) bySector[r.sector] = (bySector[r.sector] || 0) + 1;
  for (const [s, n] of Object.entries(bySector).sort()) {
    console.log(`  ${s}: ${n}`);
  }

  if (!rows.length) {
    await close_database();
    return;
  }

  if (!APPLY) {
    console.log(
      "\n*** DRY RUN — no rows deleted. Re-run with --apply to execute. ***"
    );
    await close_database();
    return;
  }

  const ids = rows.map((r) => r.id);
  const res = await run_async(
    `delete from "${SCHEMA}"."memories"
      where sector is not null
        and sector != all($1::text[])`,
    [VALID]
  );
  // run_async returns void; report via a count query.
  const remaining = (await all_async(
    `select count(*)::int n
       from "${SCHEMA}"."memories"
      where sector is not null
        and sector != all($1::text[])`,
    [VALID]
  )) as any[];
  console.log(
    `\nDeleted ${ids.length} invalid-sector rows. Invalid rows remaining: ${remaining[0].n}.`
  );
  await close_database();
}

main().catch(async (e) => {
  console.error("HARD DELETE FAILED:", e);
  await close_database();
  process.exit(1);
});
