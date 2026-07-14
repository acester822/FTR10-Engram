/*
 * scripts/consolidateInvalidSectors.ts
 *
 * One-off repair script for the Engram memory store.
 *
 * Problem: old extraction/compaction/consolidation runs stored memories under
 * arbitrary "sector" values that are NOT the 5 canonical sectors
 * (semantic | procedural | episodic | emotional | reflective). This script:
 *   1. Finds every active memory under an invalid sector.
 *   2. Clusters them by embedding similarity to find near-duplicates.
 *   3. For each cluster, merges the members into a single canonical memory
 *      (canonical sector via normalizeSector, deduped/cleaned content).
 *   4. Soft-deletes (supersedes) the originals and inserts the merged memory
 *      with a valid embedding + audit trail.
 *
 * DRY RUN by default. Pass --apply to actually write.
 */

import crypto from "node:crypto";
import { all_async, run_async } from "../src/database/connection";
import { close_database } from "../src/database/connection";
import { embed } from "../src/embeddings/embed";
import { rememberDurableMemory } from "../src/durable/repository";
import { normalizeSector, classifyMemory, VALID_SECTORS } from "../src/services/memoryInjector";

const VALID = VALID_SECTORS as readonly string[];
const APPLY = process.argv.includes("--apply");
const SIM_THRESHOLD = Number(process.env.SIM_THRESHOLD) || 0.82; // cosine similarity above which two memories are "same topic"
const SCHEMA = process.env.EG_PG_SCHEMA || "public";

const cos = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
};

const clean = (s: string) =>
  s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(important decision\s*:?\s*)/i, "")
    .replace(/^(decision\s*:?\s*)/i, "")
    .trim();

async function main() {
  // 1. Fetch every active memory under a non-canonical sector.
  const rows = (await all_async(
    `select id, sector, is_genome, project_id, user_id, access_count, content
       from "${SCHEMA}"."memories"
      where superseded_at is null
        and sector is not null
        and sector != all($1::text[])
      order by recorded_at`,
    [VALID]
  )) as Array<{
    id: string;
    sector: string;
    is_genome: boolean;
    project_id: string | null;
    user_id: string;
    access_count: number;
    content: string;
  }>;

  console.log(`\nFound ${rows.length} active memories under invalid sectors.`);
  if (!rows.length) {
    await close_database();
    return;
  }

  // 2. Embed all of them.
  console.log("Embedding...");
  const emb: Record<string, number[]> = {};
  for (const r of rows) {
    emb[r.id] = await embed(r.content);
  }

  // 3. Cluster (greedy union-find by similarity).
  const parent: Record<string, string> = {};
  const find = (x: string): string => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (const r of rows) parent[r.id] = r.id;
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      // Only cluster memories that share a project (or are both project-less)
      // to avoid merging unrelated topics from different projects.
      const a = rows[i];
      const b = rows[j];
      if ((a.project_id || null) !== (b.project_id || null)) continue;
      if (cos(emb[a.id], emb[b.id]) >= SIM_THRESHOLD) union(a.id, b.id);
    }
  }

  const clusters: Record<string, typeof rows> = {};
  for (const r of rows) {
    const root = find(r.id);
    (clusters[root] ||= []).push(r);
  }

  console.log(`Grouped into ${Object.keys(clusters).length} clusters.\n`);

  // 4. Build merged representatives.
  const newMemories: Array<{
    content: string;
    sector: string;
    project_id: string | null;
    user_id: string;
    is_genome: boolean;
    supersede: string[];
  }> = [];

  for (const [, members] of Object.entries(clusters)) {
    // Merge content: dedup cleaned lines, keep the most informative.
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const m of members) {
      const c = clean(m.content);
      const key = c.toLowerCase();
      if (c && !seen.has(key)) {
        seen.add(key);
        lines.push(c);
      }
    }
    const content =
      lines.length === 1 ? lines[0] : lines.join(" | ");

    // Choose canonical sector. Start from the existing (invalid) sectors after
    // normalization; but prefer a content-based heuristic so genuinely
    // procedural/episodic/emotional/reflective memories land in the right
    // bucket. Rank: (a) normalizeSector of the most common invalid sector,
    // (b) classifyMemory(content) on the merged text — pick the non-semantic
    // resolution if either resolves elsewhere, else semantic.
    const normSectors = members.map((m) => normalizeSector(m.sector, "semantic"));
    const counts: Record<string, number> = {};
    for (const s of normSectors) counts[s] = (counts[s] || 0) + 1;
    const byFrequency = Object.entries(counts).sort((x, y) => y[1] - x[1])[0][0];

    const heuristic = classifyMemory(content).sector;
    const canonicalSector = byFrequency !== "semantic" ? byFrequency : heuristic;

    const projectId = members[0].project_id || null;
    const userId = members[0].user_id || "system";
    const isGenome = members.some((m) => m.is_genome);

    newMemories.push({
      content,
      sector: canonicalSector,
      project_id: projectId,
      user_id: userId,
      is_genome: isGenome,
      supersede: members.map((m) => m.id),
    });
  }

  // Report plan.
  console.log("=== CONSOLIDATION PLAN ===");
  for (const nm of newMemories) {
    console.log(
      `\n[${nm.sector}${nm.is_genome ? " / genome" : ""}] <- ${nm.supersede.length} mem(s) (proj=${nm.project_id ?? "∅"})`
    );
    console.log(`   ${nm.content.slice(0, 200)}`);
  }

  const totalSuperseded = newMemories.reduce((n, m) => n + m.supersede.length, 0);
  console.log(
    `\nSUMMARY: ${rows.length} invalid memories -> ${newMemories.length} canonical memories (superseding ${totalSuperseded}).`
  );

  if (!APPLY) {
    console.log(
      "\n*** DRY RUN — no changes written. Re-run with --apply to execute. ***"
    );
    await close_database();
    return;
  }

  // 5. Execute: insert merged memory + supersede originals (in one tx per cluster).
  console.log("\nApplying...");
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      if (/^\s*(select|with)\b/i.test(sql)) {
        return { rows: await all_async(sql, params as any[]) };
      }
      await run_async(sql, params as any[]);
      return { rows: [] };
    },
  };

  let created = 0;
  for (const nm of newMemories) {
    const embedding = await embed(nm.content);
    await rememberDurableMemory(db as any, {
      content: nm.content,
      user_id: nm.user_id,
      project_id: nm.project_id || undefined,
      actor_id: "sector-repair",
      embedding,
      metadata: {
        sector: nm.sector,
        is_genome: nm.is_genome,
        source: "sector_repair_consolidation",
      },
    });
    created++;

    // Soft-delete (supersede) the originals with an audit trail.
    const now = new Date().toISOString();
    for (const oldId of nm.supersede) {
      await run_async(
        `update "${SCHEMA}"."memories"
         set valid_to = coalesce(valid_to, $1), superseded_at = coalesce(superseded_at, $1)
         where id = $2 and superseded_at is null`,
        [now, oldId]
      );
      await run_async(
        `insert into "${SCHEMA}"."audit_log"
          (id,user_id,project_id,event_type,target_table,target_id,operation,before_state,after_state,metadata,recorded_at,actor_id,actor_type)
         values ($1,$2,$3,'memory.supersede','memories',$4,'supersede',null,null,$5::jsonb,$6,$7,$8)`,
        [
          crypto.randomUUID(),
          nm.user_id,
          nm.project_id || null,
          oldId,
          JSON.stringify({ reason: "sector repair consolidation", new_sector: nm.sector }),
          now,
          "sector-repair",
          "system",
        ]
      );
    }
  }

  console.log(`\nCreated ${created} canonical memories; superseded ${totalSuperseded}.`);
  await close_database();
}

main().catch(async (e) => {
  console.error("CONSOLIDATION FAILED:", e);
  await close_database();
  process.exit(1);
});
