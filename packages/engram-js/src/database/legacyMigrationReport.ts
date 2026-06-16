/*
 - filename: packages/engram-js/src/database/legacymigrationreport.ts
 - what is the file used for: prints a non-destructive legacy data migration report
*/

import fs from "node:fs";
import { buildLegacyMigrationReport } from "../durable/migrationReport";

const read = (p: string) => JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));

const main = async () => {
  const src = process.argv[2] || process.env.EG_LEGACY_REPORT_INPUT;
  const out = process.argv[3] || process.env.EG_LEGACY_REPORT_OUTPUT;
  if (!src) {
    console.error("usage: npm run migration-report -- <legacy-data.json> [report.json]");
    process.exit(1);
  }
  const txt = JSON.stringify(buildLegacyMigrationReport(read(src)), null, 2);
  out ? fs.writeFileSync(out, `${txt}\n`) : console.log(txt);
};

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
