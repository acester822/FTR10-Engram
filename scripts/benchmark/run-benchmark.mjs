#!/usr/bin/env node
// Engram benchmark runner — synthetic A/B: no-Engram vs with-Engram vs full-history, deep scored.
//
// Usage:
//   node scripts/benchmark/run-benchmark.mjs                # full run with judge
//   node scripts/benchmark/run-benchmark.mjs --no-judge     # skip judge (raw outputs only)
//   node scripts/benchmark/run-benchmark.mjs --keep         # don't clean seeded memories
//   node scripts/benchmark/run-benchmark.mjs --only recall  # run only the recall lens
//
// Env: UPSTREAM_URL, ANS_MODEL, ENGRAM_URL, JUDGE_URL, JUDGE_MODEL, BENCH_TIMEOUT_MS, BENCH_PSQL

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cfg, callChat, seedMemory, cleanupSeeds, storeCount, recallQuery,
  proxyChat, judgeAnswer, scoreRecall, aggregateArms, markdownReport, SEED_PREFIX,
} from "./lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const config = cfg();
const scenarios = JSON.parse(readFileSync(path.join(__dirname, "datasets", "scenarios.json"), "utf8")).scenarios;

async function main() {
  console.log(`[bench] upstream=${config.upstreamUrl} answerer=${config.answerModel} engram=${config.engramUrl}`);
  console.log(`[bench] judge=${config.judgeModel} @ ${config.judgeUrl} ${args.has("--no-judge") ? "(SKIPPED)" : ""}`);

  // 0. store state
  const storeSize = storeCount(config.psqlCmd);
  console.log(`[bench] store: ${storeSize} active memories`);

  // 1. seed (idempotent: wipe previous seeds first)
  if (!args.has("--only")) {
    cleanupSeeds(config.psqlCmd);
    let n = 0;
    for (const s of scenarios) {
      for (const seed of s.seed) {
        await seedMemory(config.engramUrl, `${SEED_PREFIX}${seed.content}`, seed.sector);
        n++;
      }
    }
    console.log(`[bench] seeded ${n} benchmark memories (prefix ${SEED_PREFIX.trim()})`);
  }

  const retrieval = {};
  const startedAt = new Date().toISOString();

  for (const s of scenarios) {
    console.log(`[bench] scenario ${s.id} (${s.category})...`);

    // retrieval lens
    const recallRes = await recallQuery(config.engramUrl, s.question, 5);
    retrieval[s.id] = { ...scoreRecall(recallRes, s.gold_evidence), count: recallRes.length };
    console.log(`  recall@5=${retrieval[s.id].recallAt5 ?? "-"} hit@5=${retrieval[s.id].hitAt5 ?? "-"}`);

    if (args.has("--only")) continue;

    // arm A — no Engram: raw question straight to the upstream
    s.no_engram = await callChat(config.upstreamUrl, config.answerModel, [{ role: "user", content: s.question }]);

    // arm B — with Engram: real proxy (fresh session → embed → recall → inject → forward)
    s.with_engram = await proxyChat(config.engramUrl, config.answerModel, s.question);
    // what did Engram actually inject? (trace lives at choices[0]._trace)
    const trace = s.with_engram.raw?.choices?.[0]?._trace || {};
    const injectedMems = trace.phenotype || [];
    s.with_engram.injected = {
      genome: (trace.genome || []).length,
      memories: injectedMems.length,
      sources: (trace.web || {}).count || 0,
      evidenceHit: injectedMems.some((m) =>
        (s.gold_evidence || []).some((g) => String(m.content || "").toLowerCase().includes(g.toLowerCase()))),
    };

    // arm C — full-history baseline: every seed in context (context-economy counterpoint)
    const history = s.seed.map((m) => `- ${m.content}`).join("\n");
    s.full_history = await callChat(config.upstreamUrl, config.answerModel, [
      { role: "system", content: `Relevant project notes:\n${history}` },
      { role: "user", content: s.question },
    ]);

    console.log(`  A=${s.no_engram.content.slice(0, 60).replace(/\n/g, " ")}`);
    console.log(`  B=${s.with_engram.content.slice(0, 60).replace(/\n/g, " ")}`);
  }

  // 2. judge (unless --no-judge)
  if (!args.has("--no-judge") && !args.has("--only")) {
    for (const s of scenarios) {
      for (const arm of ["no_engram", "with_engram"]) {
        s[arm].judged = await judgeAnswer(config.judgeUrl, config.judgeModel, {
          question: s.question,
          gold: s.gold,
          answer: s[arm].content,
        });
        console.log(`[bench] judge ${s.id}/${arm}: score=${s[arm].judged.score} correct=${s[arm].judged.correct}`);
      }
    }
  }

  // 3. report
  const agg = aggregateArms(scenarios);
  const run = { startedAt, config, storeSize, scenarios, agg, retrieval };
  mkdirSync(path.join(__dirname, "reports"), { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonPath = path.join(__dirname, "reports", `benchmark-${ts}.json`);
  const mdPath = path.join(__dirname, "reports", `benchmark-${ts}.md`);
  writeFileSync(jsonPath, JSON.stringify(run, null, 2));
  writeFileSync(mdPath, markdownReport(run));
  console.log(`[bench] reports written: ${jsonPath}`);
  console.log(markdownReport(run));

  // 4. cleanup (unless --keep)
  if (!args.has("--keep") && !args.has("--only")) {
    const del = cleanupSeeds(config.psqlCmd);
    console.log(`[bench] cleanup: ${del}`);
  }
}

main().catch((e) => {
  console.error("[bench] FATAL:", e.message);
  // always try cleanup on failure so the store is never left polluted
  try { cleanupSeeds(config.psqlCmd); } catch {}
  process.exit(1);
});
