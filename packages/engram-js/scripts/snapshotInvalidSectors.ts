import { all_async } from "../src/database/connection";
import { close_database } from "../src/database/connection";
import { VALID_SECTORS } from "../src/services/memoryInjector";
import { writeFileSync } from "node:fs";

const VALID = VALID_SECTORS as readonly string[];
const SCHEMA = process.env.EG_PG_SCHEMA || "public";

async function main() {
  const rows = (await all_async(
    `select id, sector, is_genome, project_id, user_id, access_count, content, metadata, recorded_at
       from "${SCHEMA}"."memories"
      where superseded_at is null
        and sector is not null
        and sector != all($1::text[])`,
    [VALID]
  )) as any[];
  writeFileSync(
    "/home/ftr/Apps/Engram/packages/engram-js/scripts/_invalid_sectors_snapshot.json",
    JSON.stringify(rows, null, 2)
  );
  console.log(`Snapshot of ${rows.length} invalid-sector memories written.`);
  await close_database();
}
main().catch(async (e) => {
  console.error(e);
  await close_database();
  process.exit(1);
});
