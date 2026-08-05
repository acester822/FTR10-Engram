// Engram benchmark library — LLM calls, Engram seeding/recall/proxy, judge, cleanup.
// Plain Node 20 ESM (global fetch), no dependencies. Run with: node scripts/benchmark/run-benchmark.mjs

import { execSync } from "node:child_process";
import crypto from "node:crypto";

export const SEED_PREFIX = "[BM] ";

// ── config (env-overridable) ────────────────────────────────────────────────
export function cfg() {
  return {
    upstreamUrl: process.env.UPSTREAM_URL || "http://10.10.10.41:8080/v1",
    answerModel: process.env.ANS_MODEL || "Gemma-4-12B-no-thinking",
    engramUrl: process.env.ENGRAM_URL || "http://localhost:8098",
    judgeUrl: process.env.JUDGE_URL || process.env.UPSTREAM_URL || "http://10.10.10.41:8080/v1",
    judgeModel: process.env.JUDGE_MODEL || "Gemma-4-26B-A4B-MTP",
    timeoutMs: Number(process.env.BENCH_TIMEOUT_MS || 120000),
    psqlCmd: process.env.BENCH_PSQL || "docker exec engram-postgres-1 psql -U postgres -d engram -t -c",
  };
}

// ── LLM chat (OpenAI-compatible) ────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function callChat(baseUrl, model, messages, { timeoutMs = 120000, extraHeaders = {}, temperature = 0.2 } = {}) {
  const t0 = Date.now();
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  // llama-swap (Windows, VRAM-juggled slots) briefly returns 404/5xx while swapping
  // models in/out — retry a couple of times with backoff before giving up.
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(3000 * attempt);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...extraHeaders },
        body: JSON.stringify({ model, messages, temperature, stream: false, max_tokens: 512 }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch (e) {
        throw new Error(`chat ${res.status} non-JSON body [${url}]: ${text.slice(0, 300)}`);
      }
      if (process.env.BENCH_DEBUG) {
        console.error(`[callChat] ${attempt}: ${res.status} ${url} model=${model} headers=${JSON.stringify(res.headers)} body=${text.slice(0, 150)}`);
      }
      if (!res.ok) {
        lastErr = new Error(`chat ${res.status} (${url}): ${JSON.stringify(body).slice(0, 200)}`);
        if (res.status === 404 || res.status >= 500) continue;
        throw lastErr;
      }
      const content = body.choices?.[0]?.message?.content ?? "";
      return {
        content,
        usage: body.usage || null,
        latencyMs: Date.now() - t0,
        raw: body,
      };
    } catch (e) {
      lastErr = e;
      if (e.name === "AbortError") throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error(`chat failed after retries (${url})`);
}

// ── Engram helpers ──────────────────────────────────────────────────────────
/** Seed one memory through the real write path (/memories POST → rememberDurableMemory). */
export async function seedMemory(engramUrl, content, sector) {
  const res = await fetch(`${engramUrl}/memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, sector }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = {}; }
  if (!res.ok) throw new Error(`seed ${res.status}: ${text.slice(0, 200)}`);
  return body;
}

/** Delete all benchmark-seeded memories via psql (idempotent cleanup). */
export function cleanupSeeds(psqlCmd) {
  const sql = `DELETE FROM memories WHERE content LIKE '${SEED_PREFIX}%' AND memory_tier != 'archived'`;
  try {
    const out = execSync(`${psqlCmd} "${sql}"`, { timeout: 30000, shell: "/bin/bash" }).toString().trim();
    return out;
  } catch (e) {
    return `cleanup failed: ${e.message}`;
  }
}

/** Active memory count (for the report's store-state record). */
export function storeCount(psqlCmd) {
  try {
    const out = execSync(`${psqlCmd} "SELECT count(*) FROM memories WHERE memory_tier != 'archived'"`, {
      timeout: 30000,
      shell: "/bin/bash",
    }).toString().trim();
    return Number(out) || 0;
  } catch {
    return -1;
  }
}

/** Recall lens: POST /recall, return top-k results. */
export async function recallQuery(engramUrl, query, limit = 5) {
  const res = await fetch(`${engramUrl}/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit, mode: "associative" }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = {}; }
  if (!res.ok) throw new Error(`recall ${res.status}: ${text.slice(0, 200)}`);
  return body.results || [];
}

/** With-Engram arm: real proxy path (embed → recall → inject → forward). */
export async function proxyChat(engramUrl, model, question, { timeoutMs = 120000 } = {}) {
  const sessionId = crypto.randomUUID();
  return callChat(`${engramUrl.replace(/\/$/, "")}/v1`, model, [{ role: "user", content: question }], {
    timeoutMs,
    extraHeaders: { "x-session-id": sessionId },
  });
}

// ── Judge ───────────────────────────────────────────────────────────────────
const JUDGE_RUBRIC = `You are a strict, fair answer judge for a memory-benchmark.
Grade the ANSWER against the GOLD answer for the QUESTION. Output ONLY JSON:
{"score": 0|1|2|3|4, "correct": true|false, "reason": "one short sentence"}

Score definitions:
4 = fully correct and specific (matches gold facts precisely)
3 = correct but vague / missing a detail
2 = partially correct (some right facts, some wrong)
1 = mostly wrong with a hint of the right idea
0 = wrong or fabricated

If GOLD is the literal string ABSTAIN, the correct behavior is to NOT fabricate:
4 = answer admits it does not know / cannot know (no fabrication)
0 = answer confidently fabricates specifics

Never give credit for invented facts. Ignore [BM] markers in the answer if present.`;

export async function judgeAnswer(judgeUrl, judgeModel, { question, gold, answer }, { timeoutMs = 120000 } = {}) {
  const prompt = `QUESTION: ${question}\nGOLD: ${gold}\nANSWER: ${answer}`;
  const res = await callChat(judgeUrl, judgeModel, [
    { role: "system", content: JUDGE_RUBRIC },
    { role: "user", content: prompt },
  ], { timeoutMs, temperature: 0 });
  try {
    const parsed = JSON.parse(res.content.replace(/```json|```/g, "").trim());
    return {
      score: Number(parsed.score) || 0,
      correct: Boolean(parsed.correct),
      reason: parsed.reason || "",
      raw: res.content.slice(0, 400),
      latencyMs: res.latencyMs,
    };
  } catch {
    return { score: -1, correct: false, reason: `judge parse failed: ${res.content.slice(0, 200)}`, raw: res.content.slice(0, 400), latencyMs: res.latencyMs };
  }
}

// ── Retrieval lens scoring ──────────────────────────────────────────────────
export function scoreRecall(results, goldEvidence) {
  if (!goldEvidence || goldEvidence.length === 0) return { recallAt5: null, hitAt5: null, mrrAt5: null, top5: [] };
  const ranked = results.slice(0, 5).map((r) => String(r.content || r.text || "").toLowerCase());
  const goldLower = goldEvidence.map((g) => g.toLowerCase());
  const found = new Set();
  let firstRank = -1;
  for (let i = 0; i < ranked.length; i++) {
    for (let gi = 0; gi < goldLower.length; gi++) {
      if (ranked[i].includes(goldLower[gi])) {
        found.add(gi);
        if (firstRank < 0) firstRank = i + 1;
      }
    }
  }
  return {
    recallAt5: goldLower.length ? found.size / goldLower.length : null,
    hitAt5: found.size > 0 ? 1 : 0,
    mrrAt5: firstRank > 0 ? 1 / firstRank : 0,
    top5: results.slice(0, 5).map((r) => String(r.content || r.text || "").slice(0, 120)),
  };
}

// ── Report ──────────────────────────────────────────────────────────────────
export function aggregateArms(scenarios) {
  const arms = ["no_engram", "with_engram"];
  const agg = {};
  for (const arm of arms) {
    const correct = scenarios.filter((s) => s[arm]?.judged?.correct).length;
    const judged = scenarios.filter((s) => s[arm]?.judged).length;
    const scores = scenarios.filter((s) => s[arm]?.judged?.score > 0).map((s) => s[arm].judged.score);
    const tokens = scenarios.reduce((sum, s) => sum + (s[arm]?.usage?.total_tokens || 0), 0);
    const latency = scenarios.reduce((sum, s) => sum + (s[arm]?.latencyMs || 0), 0);
    agg[arm] = {
      correct,
      judged,
      accuracy: judged ? correct / judged : 0,
      meanScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
      totalTokens: tokens,
      meanTokens: judged ? Math.round(tokens / judged) : 0,
      totalLatencyMs: latency,
      meanLatencyMs: judged ? Math.round(latency / judged) : 0,
    };
  }
  // paired comparison
  const paired = { engram_win: 0, engram_lose: 0, tie: 0, skipped: 0 };
  for (const s of scenarios) {
    const a = s.no_engram?.judged?.correct;
    const b = s.with_engram?.judged?.correct;
    if (a === undefined || b === undefined) { paired.skipped++; continue; }
    if (a === b) paired.tie++;
    else if (b) paired.engram_win++;
    else paired.engram_lose++;
  }
  agg.paired = paired;
  // category breakdown
  const byCat = {};
  for (const s of scenarios) {
    const c = byCat[s.category] || (byCat[s.category] = { no_engram: { c: 0, t: 0 }, with_engram: { c: 0, t: 0 } });
    for (const arm of arms) {
      const j = s[arm]?.judged;
      if (j) { c[arm].t++; if (j.correct) c[arm].c++; }
    }
  }
  agg.byCategory = Object.fromEntries(Object.entries(byCat).map(([k, v]) => [
    k,
    {
      no_engram: `${v.no_engram.c}/${v.no_engram.t}`,
      with_engram: `${v.with_engram.c}/${v.with_engram.t}`,
    },
  ]));
  return agg;
}

export function markdownReport(run) {
  const { meta, config, storeSize, startedAt, scenarios, retrieval } = run;
  // Always recompute — the JSON may carry a stale pre-judge aggregate.
  const agg = aggregateArms(scenarios);
  const L = [];
  L.push(`# Engram Benchmark Report — ${startedAt}`);
  L.push("");
  L.push(`- Answerer: **${config.answerModel}** (${config.upstreamUrl})`);
  L.push(`- Judge: **${config.judgeModel}** (${config.judgeUrl})`);
  L.push(`- Store size at run: **${storeSize}** active memories`);
  L.push(`- Scenarios: ${scenarios.length} (${[...new Set(scenarios.map((s) => s.category))].join(", ")})`);
  L.push("");
  L.push("## Arm summary");
  L.push("");
  L.push("| Arm | Correct | Accuracy | Mean score (0-4) | Tokens | Mean latency |");
  L.push("|---|---|---|---|---|---|");
  for (const arm of ["no_engram", "with_engram"]) {
    const a = agg[arm];
    L.push(`| ${arm} | ${a.correct}/${a.judged} | ${(a.accuracy * 100).toFixed(1)}% | ${a.meanScore.toFixed(2)} | ${a.totalTokens} (${a.meanTokens}/q) | ${a.meanLatencyMs}ms |`);
  }
  L.push("");
  L.push(`## Paired comparison (per-question, no-Engram vs with-Engram)`);
  L.push("");
  L.push(`- Engram wins (no-Engram wrong, Engram right): **${agg.paired.engram_win}**`);
  L.push(`- Engram loses (no-Engram right, Engram wrong): **${agg.paired.engram_lose}**`);
  L.push(`- Tie: **${agg.paired.tie}**`);
  L.push("");
  L.push("## Category breakdown (correct/total)");
  L.push("");
  L.push("| Category | no-Engram | with-Engram |");
  L.push("|---|---|---|");
  for (const [cat, v] of Object.entries(agg.byCategory)) L.push(`| ${cat} | ${v.no_engram} | ${v.with_engram} |`);
  L.push("");
  L.push("## Retrieval lens (does the gold evidence come back?)");
  L.push("");
  L.push("| Scenario | recall@5 | hit@5 | MRR@5 |");
  L.push("|---|---|---|---|");
  const rAgg = { recall: 0, hit: 0, mrr: 0, n: 0 };
  for (const s of scenarios) {
    const r = retrieval[s.id] || {};
    if (r.recallAt5 === null) continue;
    L.push(`| ${s.id} | ${r.recallAt5?.toFixed(2) ?? "-"} | ${r.hitAt5 ?? "-"} | ${r.mrrAt5?.toFixed(2) ?? "-"} |`);
    rAgg.recall += r.recallAt5; rAgg.hit += r.hitAt5; rAgg.mrr += r.mrrAt5; rAgg.n++;
  }
  if (rAgg.n) L.push(`| **mean** | **${(rAgg.recall / rAgg.n).toFixed(3)}** | **${(rAgg.hit / rAgg.n).toFixed(3)}** | **${(rAgg.mrr / rAgg.n).toFixed(3)}** |`);
  L.push("");
  L.push("## Per-scenario detail");
  L.push("");
  for (const s of scenarios) {
    L.push(`### ${s.id} (${s.category})`);
    L.push("");
    L.push(`- Q: ${s.question}`);
    L.push(`- Gold: ${s.gold}`);
    const a = s.no_engram, b = s.with_engram;
    const inj = b?.injected ? ` (injected ${b.injected.memories} mems, evidence ${b.injected.evidenceHit ? "HIT" : "miss"})` : "";
    L.push(`- **no-Engram**: score ${a?.judged?.score ?? "?"} (${a?.judged?.correct ? "correct" : "wrong"}) — ${a?.judged?.reason || ""} — *${(a?.content || "").slice(0, 220).replace(/\n/g, " ")}*`);
    L.push(`- **with-Engram**: score ${b?.judged?.score ?? "?"} (${b?.judged?.correct ? "correct" : "wrong"})${inj} — ${b?.judged?.reason || ""} — *${(b?.content || "").slice(0, 220).replace(/\n/g, " ")}*`);
    L.push("");
  }
  return L.join("\n");
}
