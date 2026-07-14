import { all_async } from "../src/database/connection";
import { close_database } from "../src/database/connection";
import { VALID_SECTORS } from "../src/services/memoryInjector";

const VALID = VALID_SECTORS as readonly string[];
const SCHEMA = process.env.EG_PG_SCHEMA || "public";

async function main() {
  const invalid = (await all_async(
    `select count(*)::int n
       from "${SCHEMA}"."memories"
      where superseded_at is null
        and sector is not null
        and sector != all($1::text[])`,
    [VALID]
  )) as any[];
  console.log("Remaining active invalid-sector memories:", invalid[0].n);

  const breakdown = (await all_async(
    `select sector, count(*)::int n
       from "${SCHEMA}"."memories"
      where superseded_at is null
      group by sector
      order by n desc`
  )) as any[];
  console.log("\nAll active sectors:");
  for (const r of breakdown) console.log(`  ${r.sector}: ${r.n}`);

  const nullEmb = (await all_async(
    `select count(*)::int n
       from "${SCHEMA}"."memories"
      where superseded_at is null
        and embedding is null`
  )) as any[];
  console.log("\nActive memories with NULL/empty embedding:", nullEmb[0].n);

  const superseded = (await all_async(
    `select count(*)::int n
       from "${SCHEMA}"."memories"
      where superseded_at is not null`
  )) as any[];
  console.log("Total superseded (soft-deleted) memories:", superseded[0].n);

  const audit = (await all_async(
    `select count(*)::int n
       from "${SCHEMA}"."audit_log"
      where event_type = 'memory.supersede'
        and actor_id = 'sector-repair'`
  )) as any[];
  console.log("Sector-repair audit rows:", audit[0].n);

  await close_database();
}
main().catch(async (e) => {
  console.error(e);
  await close_database();
  process.exit(1);
});
