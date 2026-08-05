/*
 - filename: packages/engram-js/scripts/recall-eval.ts
 - what is the file used for: recall quality harness (recall@k against labeled cases)
 -
 - Answers the one question a memory system exists for: does the RIGHT memory
 - come back? Runs every labeled case through the LIVE /recall API (embedding
 - chain, hybrid fusion, penalties — the whole real path), then reports
 - recall@1/@3/@5 for hybrid mode and (by default) non-hybrid mode.
 -
 - Usage:
 -   bun run tsx scripts/recall-eval.ts                       # default: http://localhost:8098
 -   bun run tsx scripts/recall-eval.ts --url http://localhost:8098 --limit 5
 -   bun run tsx scripts/recall-eval.ts --no-hybrid-compare   # hybrid only
 -   bun run tsx scripts/recall-eval.ts --json                # machine-readable
 */

import { RECALL_EVAL_CASES, type RecallEvalCase } from "./recall-eval-cases";

const args = process.argv.slice(2);
const arg = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const flag = (name: string): boolean => args.includes(name);

const URL = arg("--url", "http://localhost:8098")!.replace(/\/$/, "");
const LIMIT = Math.min(parseInt(arg("--limit", "5")!, 10) || 5, 20);
const API_KEY = arg("--api-key", process.env.EG_API_KEY);
const HYBRID_COMPARE = !flag("--no-hybrid-compare");
const JSON_OUT = flag("--json");

interface RecallResult {
  id: string;
  content: string;
  score: number;
  embedding_synthetic?: boolean;
}

async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(URL + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(API_KEY ? { "x-api-key": API_KEY } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

async function recall(query: string, hybrid: boolean): Promise<RecallResult[]> {
  const body: Record<string, unknown> = { query, limit: LIMIT };
  if (!hybrid) body.hybrid = false;
  const data = await api<{ results?: RecallResult[] }>("/recall", body);
  return data.results || [];
}

/** 1-based rank of the memory containing ALL expect substrings, or -1. */
function rankOf(results: RecallResult[], expect: string[]): number {
  const norm = (s: string) => s.toLowerCase();
  for (let i = 0; i < results.length; i++) {
    const c = norm(results[i].content || "");
    if (expect.every((e) => c.includes(norm(e)))) return i + 1;
  }
  return -1;
}

/** Any avoid substring present in top-k results? (precision violation) */
function avoidHit(results: RecallResult[], avoid: string[] | undefined): boolean {
  if (!avoid?.length) return false;
  const norm = (s: string) => s.toLowerCase();
  return results.some((r) => avoid.some((a) => norm(r.content || "").includes(norm(a))));
}

async function main(): Promise<void> {
  // Snapshot the store so cases whose expectation vanished are skipped, not failed.
  const store = await api<{ items?: Array<{ content?: string }> }>("/memories?limit=500");
  const storeText = (store.items || []).map((m) => (m.content || "").toLowerCase());
  const norm = (s: string) => s.toLowerCase();

  const cases = RECALL_EVAL_CASES.filter((c) => {
    const inStore = c.expect.every((e) => storeText.some((s) => s.includes(norm(e))));
    if (!inStore) {
      console.warn(`SKIP  ${c.name} — expectation no longer in store`);
    }
    return inStore;
  });

  interface Row {
    name: string;
    hybridRank: number;
    plainRank: number;
    synthetic: boolean;
    avoidHit: boolean;
  }
  const rows: Row[] = [];

  for (const c of cases) {
    const hybridResults = await recall(c.query, true);
    const plainResults = HYBRID_COMPARE ? await recall(c.query, false) : [];
    const rankH = rankOf(hybridResults, c.expect);
    const rankP = HYBRID_COMPARE ? rankOf(plainResults, c.expect) : -1;
    const matched =
      rankH >= 0
        ? hybridResults[rankH - 1]
        : HYBRID_COMPARE && rankP >= 0
          ? plainResults[rankP - 1]
          : null;
    rows.push({
      name: c.name,
      hybridRank: rankH,
      plainRank: rankP,
      synthetic: Boolean(matched?.embedding_synthetic),
      avoidHit: avoidHit(hybridResults, c.avoid),
    });
  }

  const summarize = (rankOf: (r: Row) => number, mode: string) => {
    const hit = rows.filter((r) => rankOf(r) >= 0);
    const k1 = hit.filter((r) => rankOf(r) === 1).length;
    const k3 = hit.filter((r) => rankOf(r) <= 3).length;
    const k5 = hit.filter((r) => rankOf(r) <= 5).length;
    const n = rows.length;
    return {
      mode,
      cases: n,
      recall_at_1: n ? +(k1 / n).toFixed(3) : 0,
      recall_at_3: n ? +(k3 / n).toFixed(3) : 0,
      recall_at_5: n ? +(k5 / n).toFixed(3) : 0,
    };
  };

  const hybridSum = summarize((r) => r.hybridRank, "hybrid");
  const plainSum = HYBRID_COMPARE ? summarize((r) => r.plainRank, "non-hybrid") : null;
  const precisionViolations = rows.filter((r) => r.avoidHit).length;
  const syntheticMatched = rows.filter((r) => r.synthetic).length;

  if (JSON_OUT) {
    console.log(JSON.stringify({ url: URL, limit: LIMIT, rows, hybrid: hybridSum, nonHybrid: plainSum, precision_violations: precisionViolations, synthetic_matched: syntheticMatched }, null, 2));
    return;
  }

  console.log(`\nRecall eval — ${URL} (top-${LIMIT}, ${cases.length} cases)`);
  console.log("=".repeat(92));
  console.log(
    "case".padEnd(26) +
      "hybrid".padEnd(10) +
      (HYBRID_COMPARE ? "plain".padEnd(10) : "") +
      "synth".padEnd(8) +
      "avoid-hit".padEnd(10) +
      "query",
  );
  console.log("-".repeat(92));
  for (const r of rows) {
    const rk = (n: number) => (n === -1 ? "MISS" : `#${n}`);
    console.log(
      r.name.padEnd(26) +
        rk(r.hybridRank).padEnd(10) +
        (HYBRID_COMPARE ? rk(r.plainRank).padEnd(10) : "") +
        (r.synthetic ? "SYNTH".padEnd(8) : "—".padEnd(8)) +
        (r.avoidHit ? "YES".padEnd(10) : "no".padEnd(10)) +
        RECALL_EVAL_CASES.find((c) => c.name === r.name)?.query,
    );
  }
  console.log("-".repeat(92));
  console.log(`hybrid     recall@1=${hybridSum.recall_at_1}  @3=${hybridSum.recall_at_3}  @5=${hybridSum.recall_at_5}  (${hybridSum.cases} cases)`);
  if (plainSum) {
    console.log(`non-hybrid recall@1=${plainSum.recall_at_1}  @3=${plainSum.recall_at_3}  @5=${plainSum.recall_at_5}`);
  }
  console.log(`precision violations: ${precisionViolations} | recalled memories flagged synthetic: ${syntheticMatched}`);
  console.log(`SKIPPED cases (expectation gone from store): ${RECALL_EVAL_CASES.length - cases.length}`);
}

main().catch((e) => {
  console.error("recall-eval failed:", e);
  process.exit(1);
});
