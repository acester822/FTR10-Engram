import { all_async } from "../src/database/connection";
import { close_database } from "../src/database/connection";
import { VALID_SECTORS } from "../src/services/memoryInjector";

const VALID = VALID_SECTORS as readonly string[];

async function main() {
  const rows = await all_async(
    `select id, sector, is_genome, project_id, user_id, access_count, content
       from "public"."memories"
      where superseded_at is null
        and sector is not null
        and sector != all($1::text[])
      order by sector, recorded_at`,
    [VALID]
  );

  const bySector: Record<string, any[]> = {};
  for (const r of rows) {
    (bySector[r.sector] ||= []).push(r);
  }

  console.log(`\n=== INVALID-SECTOR MEMORIES (active, not superseded) ===`);
  console.log(`total: ${rows.length}`);
  for (const [sector, mems] of Object.entries(bySector).sort()) {
    console.log(`\n--- sector="${sector}" (${mems.length}) ---`);
    for (const m of mems) {
      const c = String(m.content).replace(/\s+/g, " ").slice(0, 140);
      console.log(`  [${m.id}] genome=${m.is_genome ? 1 : 0} proj=${m.project_id ?? "∅"} acc=${m.access_count}`);
      console.log(`      ${c}`);
    }
  }

  const validCounts = await all_async(
    `select sector, count(*)::int as n
       from "public"."memories"
      where superseded_at is null
      group by sector
      order by n desc`
  );
  console.log(`\n=== ALL SECTORS (current db) ===`);
  for (const v of validCounts) console.log(`  ${v.sector}: ${v.n}`);

  await close_database();
}

main().catch(async (e) => {
  console.error("INSPECT FAILED:", e);
  await close_database();
  process.exit(1);
});
