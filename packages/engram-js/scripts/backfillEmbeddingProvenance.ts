/*
 - filename: packages/engram-js/scripts/backfillEmbeddingProvenance.ts
 - what is the file used for: one-off backfill of memories.embedding_synthetic
 -
 - Flags existing rows whose stored halfvec embedding matches the deterministic
 - synthetic hash fallback (i.e. NOT a real semantic-model embedding). The DB
 - stores halfvec (fp16), which rounds values, so a tolerance of 1e-3 is used
 - for the match. Real model embeddings differ from the hash by orders of
 - magnitude per dimension, so the tolerance cannot cause false positives.
 -
 - DRY-RUN by default; pass --apply to write.
 - Usage: bun run tsx scripts/backfillEmbeddingProvenance.ts [--apply]
 */

import { run_async, all_async } from "../src/database/connection";
import { isSyntheticEmbedding } from "../src/embeddings/embed";

const APPLY = process.argv.includes("--apply");
const PAGE = 500;
const TOLERANCE = 1e-3;

async function main(): Promise<void> {
  let offset = 0;
  let scanned = 0;
  let synthetic = 0;
  let skipped = 0;

  for (;;) {
    const rows = await all_async(
      `select id, content, embedding from "public"."memories"
       where embedding is not null
       order by recorded_at desc
       limit $1 offset $2`,
      [PAGE, offset],
    );
    if (!rows.length) break;

    for (const r of rows) {
      scanned++;
      let emb: number[] | null = null;
      if (Array.isArray(r.embedding)) emb = r.embedding;
      else if (typeof r.embedding === "string") {
        try {
          emb = JSON.parse(r.embedding);
        } catch {
          skipped++;
        }
      } else {
        skipped++;
      }
      if (!emb || !emb.length) {
        skipped++;
        continue;
      }
      const isSyn = isSyntheticEmbedding(emb, String(r.content || ""), "semantic", TOLERANCE);
      if (isSyn) {
        synthetic++;
        if (APPLY) {
          await run_async(
            `update "public"."memories" set embedding_synthetic = true where id = $1`,
            [r.id],
          );
        }
      }
    }
    offset += PAGE;
    if (rows.length < PAGE) break;
  }

  console.log(
    `[backfillEmbeddingProvenance] scanned=${scanned} synthetic=${synthetic} unparsable=${skipped} ` +
      `${APPLY ? "APPLIED" : "DRY-RUN (pass --apply to write)"}`,
  );
}

main().catch((e) => {
  console.error("backfill failed:", e);
  process.exit(1);
});
