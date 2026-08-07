/*
 - filename: packages/engram-js/src/services/enrichmentEngine.ts
 - what is the file used for: the memory OPTIMIZATION (enrichment) engine —
   rung 3 of the trust ladder (calibration → integrity → optimization).
   Takes the memories the user actually uses that are weakest (completeness
   rubric), finds the missing data from verified sources — the store itself,
   the codebase (rg, file:line), and the web (searxNcrawl, opt-in but default
   ON per user decision) — and creates sourced SUCCESSORS via the shared
   audited mutation primitives. Never rewrites: original stays verbatim in
   history; every enrichment is one audit row ('enrich') + one undo click.
   Per user decision (Aug 2026): action defaults to APPLY (agents are trusted;
   the audit + undo are the safety net), and directories outside the search
   allowlist surface as grant/deny access-request findings.
*/

import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { all_async as pg_all, run_async as pg_run } from "../database/connection";
import { embed, normalizeEmbedding } from "../embeddings/embed";
import { callJudge, parseJudge } from "./traceScorer";
import { enrichMemory } from "../durable/mutations";
import { AutoSearchEngine } from "./autoSearch";
import { logger } from "../utils/logger";

// ── Config (GENERAL_SETTINGS → process.env, live at call time) ──

export function enrichmentEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes(String(process.env.EG_ENRICHMENT_ENABLED).toLowerCase());
}
export function enrichmentAction(): "apply" | "flag" {
  return String(process.env.EG_ENRICHMENT_ACTION || "apply").toLowerCase() === "flag" ? "flag" : "apply";
}
function poolSize(): number {
  const n = Number(process.env.EG_ENRICHMENT_POOL_SIZE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
}
function batchSize(): number {
  const n = Number(process.env.EG_ENRICHMENT_BATCH_SIZE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8;
}
function minIncomplete(): number {
  const n = Number(process.env.EG_ENRICHMENT_MIN_INCOMPLETE);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.6;
}
function minUsage(): number {
  const n = Number(process.env.EG_ENRICHMENT_MIN_USAGE);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
}
function searchRoots(): string[] {
  const raw = String(process.env.EG_ENRICHMENT_SEARCH_ROOTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return raw.length ? raw : ["/home/ftr/Apps"];
}
function webEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes(String(process.env.EG_ENRICHMENT_WEB_ENABLED || "true").toLowerCase());
}
function maxWebResults(): number {
  const n = Number(process.env.EG_ENRICHMENT_MAX_WEB_RESULTS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

// ── Local helpers ─────────────────────────────────────────────────────────

const STOP = new Set("the this that with from have your their about into would could should which these those what when where while after before against between through during without within along across behind beyond except inside near off onto upon under toward using also than then them they there were will over again any each few more most other some such only own same so too very just but not no nor or and of in on at by for to".split(" "));

function keyTerms(content: string): string[] {
  const tokens = content.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 5 && !STOP.has(t) && !/^\d+$/.test(t));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
    if (out.length >= 6) break;
  }
  return out;
}

function parseEnrichmentJson(content: string): any | null {
  let text = content.trim().replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

function execFileP(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? "" : String(stdout));
    });
  });
}

/** rg over the ALLOWED roots only (roots come from Settings — the allowlist). */
async function codebaseSearch(terms: string[], roots: string[]): Promise<any[]> {
  if (!terms.length || !roots.length) return [];
  const args = ["-l", "-i", "-m", "5", "--max-filesize", "512K", "--glob", "!node_modules/**", "--glob", "!*.lock", "--glob", "!*.min.js", "--glob", "!dist/**"];
  for (const t of terms) args.push("-e", t);
  args.push(...roots);
  const files = (await execFileP("rg", args, 20000)).split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 6);
  const sources: any[] = [];
  for (const file of files) {
    const lineArgs = ["-n", "-m", "1", "-i"];
    for (const t of terms) lineArgs.push("-e", t);
    lineArgs.push(file);
    const hit = (await execFileP("rg", lineArgs, 10000)).split("\n")[0]?.trim() || "";
    const m = hit.match(/^(\d+):(.*)$/s);
    sources.push({
      type: "codebase",
      file,
      line: m ? Number(m[1]) : null,
      excerpt: m ? m[2].slice(0, 400) : "",
    });
    if (sources.length >= 3) break;
  }
  return sources;
}

async function webSearch(query: string, max: number): Promise<any[]> {
  try {
    const engine = new AutoSearchEngine();
    const results = await engine.search([query.slice(0, 120)]);
    return results.slice(0, max).map((r: any) => ({
      type: "web",
      url: r.url,
      title: r.title || "",
      snippet: (r.snippet || r.content || "").slice(0, 500),
    }));
  } catch (e: any) {
    logger.warn({ module: "enrichmentEngine", err: e?.message }, "web search failed");
    return [];
  }
}

// ── Findings (reuses the integrity ledger) ───────────────────────────────

async function writeFinding(
  checkName: string,
  opts: { memoryId?: string | null; severity?: string; actionTaken?: string; detail?: unknown; status?: string },
): Promise<void> {
  // Links to the most recent integrity run for FK; params start at $1 here
  // (the run_id comes from a subquery, NOT a bound param).
  await pg_run(
    `INSERT INTO public.integrity_findings (run_id, check_name, memory_id, severity, action_taken, detail, status, resolved_at)
     VALUES ((SELECT id FROM public.integrity_runs ORDER BY started_at DESC LIMIT 1), $1, $2, $3, $4, $5::jsonb, $6, CASE WHEN $6 = 'resolved' THEN now() ELSE NULL END)`,
    [checkName, opts.memoryId ?? null, opts.severity ?? "medium", opts.actionTaken ?? "none", JSON.stringify(opts.detail ?? {}), opts.status ?? "open"],
  ).catch((e: any) => logger.warn({ module: "enrichmentEngine", err: e?.message }, "finding write failed"));
}

// ── The run ──────────────────────────────────────────────────────────────

let lastRun: any = null;
let running = false;
export function enrichmentLastRun(): any {
  return lastRun;
}

export async function runEnrichment(): Promise<any> {
  if (running) return { skipped: true, reason: "enrichment run already in progress — skipped (manual + scheduled overlapped)" };
  running = true;
  try {
    return await doRun();
  } finally {
    running = false;
  }
}

async function doRun(): Promise<any> {
  if (!enrichmentEnabled()) {
    return { skipped: true, reason: "EG_ENRICHMENT_ENABLED is false — enable in Settings → General → Enrichment" };
  }
  const action = enrichmentAction();
  const stats = { sampled: 0, candidates: 0, enriched: 0, flagged: 0, failed: 0, skipped_no_sources: 0, access_requests: 0 };
  const started = Date.now();

  // 1. Selection — used-most first, deterministic filter to bound judge cost.
  const pool = await pg_all(
    `SELECT id, content, sector, access_count FROM public.memories
     WHERE superseded_at IS NULL AND memory_tier <> 'archived' AND embedding IS NOT NULL
       AND is_genome = false AND sector IN ('semantic', 'procedural')
       AND access_count >= $1
       AND NOT EXISTS (
         SELECT 1 FROM public.integrity_findings f
         WHERE f.check_name = 'enrichment_candidate' AND f.memory_id = memories.id AND f.status = 'open'
       )
     ORDER BY access_count DESC, decay_rate ASC, recorded_at ASC
     LIMIT $2`,
    [minUsage(), poolSize()],
  );
  if (!pool.length) {
    lastRun = { at: new Date().toISOString(), action, stats, ms: Date.now() - started, note: "no candidates meeting usage floor" };
    return lastRun;
  }

  // 2. Completeness rubric — judge-sample the batch.
  const batch = pool.slice(0, batchSize());
  const roots = searchRoots();
  const candidates: any[] = [];
  for (const mem of batch) {
    stats.sampled++;
    try {
      const j = await callJudge(
        `You are a memory completeness auditor. Given a stored memory fact, judge whether it is COMPLETE or missing critical detail that would materially improve future recall. Respond ONLY with JSON: {"score": <0.0-1.0>, "reason": "<one sentence>", "missing": "<what detail is absent, or empty string>"} where 0 = complete and 1 = critically incomplete.`,
        `STORED MEMORY (sector: ${mem.sector}):\n${(mem.content || "").slice(0, 800)}`,
      );
      const parsed = j.ok ? parseEnrichmentJson(j.content || "") : null;
      if (!parsed || typeof parsed.score !== "number") {
        stats.failed++;
        continue;
      }
      if (parsed.score >= minIncomplete()) {
        candidates.push({ ...mem, missing: parsed.missing || parsed.reason || "", completeness: parsed.score });
      }
    } catch (e: any) {
      stats.failed++;
    }
  }

  // 3. Per candidate: gather sources → compose → validate → act.
  for (const cand of candidates) {
    stats.candidates++;
    const sources: any[] = [];

    // 3a. The store itself — related memories.
    try {
      const vec = normalizeEmbedding(await embed(cand.content));
      const related = await pg_all(
        `SELECT id, content, round((1 - (embedding <=> $1::halfvec))::numeric, 3) AS sim
         FROM public.memories
         WHERE id <> $2 AND superseded_at IS NULL AND embedding IS NOT NULL
           AND (1 - (embedding <=> $1::halfvec)) >= 0.85
         ORDER BY embedding <=> $1::halfvec LIMIT 3`,
        [JSON.stringify(vec), cand.id],
      );
      for (const r of related) sources.push({ type: "memory", memory_id: r.id, similarity: Number(r.sim), content: r.content.slice(0, 300) });
    } catch {
      /* embed down — skip store source */
    }

    // 3b. Codebase — rg over allowed roots.
    let codebaseHits = 0;
    try {
      const hits = await codebaseSearch(keyTerms(cand.content), roots);
      codebaseHits = hits.length;
      sources.push(...hits);
    } catch {
      /* rg unavailable */
    }

    // 3c. Web — searxNcrawl (default ON per user decision).
    if (webEnabled()) {
      const web = await webSearch(cand.content, maxWebResults());
      sources.push(...web);
    }

    const realSources = sources.filter((s) => s.type !== "memory" || (s.content && s.content.length > 20));
    if (!realSources.length) {
      stats.skipped_no_sources++;
      // Access-request mechanism: suggest the dot-dirs the user named when
      // codebase search came up empty and they exist on disk.
      const home = os.homedir();
      for (const dir of [path.join(home, ".hermes"), path.join(home, ".ftr")]) {
        if (roots.some((r) => path.resolve(r) === dir)) continue;
        const exists = await new Promise<boolean>((resolve) => {
          execFile("test", ["-d", dir], (err) => resolve(!err));
        });
        if (!exists) continue;
        const dup = await pg_all(
          `SELECT id FROM public.integrity_findings WHERE check_name='enrichment_access_request' AND status='open' AND detail->>'root' = $1 LIMIT 1`,
          [dir],
        );
        if (!dup.length) {
          await writeFinding("enrichment_access_request", {
            memoryId: cand.id,
            severity: "info",
            actionTaken: "flag",
            detail: {
              root: dir,
              memory_id: cand.id,
              memory_content: cand.content.slice(0, 200),
              reason: `no codebase evidence found in allowed roots (${roots.join(", ")}) — grant to search this directory`,
            },
          });
          stats.access_requests++;
        }
      }
      continue;
    }

    // 3d. Compose the enriched successor (original verbatim + sourced additions).
    let enriched = "";
    try {
      const compose = await callJudge(
        `You are a memory enrichment composer. Given an ORIGINAL memory and numbered EVIDENCE sources, produce an enriched version. Rules: (1) keep the original text VERBATIM as the base; (2) append ONLY additions directly supported by the evidence; (3) tag each addition inline as [src:N] referencing the evidence; (4) never invent facts. Return ONLY JSON: {"enriched": "<full enriched text>", "notes": "<brief>"}.`,
        `ORIGINAL:\n${cand.content}\n\nEVIDENCE:\n${JSON.stringify(realSources.map((s, i) => ({ n: i + 1, ...s })), null, 1).slice(0, 6000)}`,
      );
      const parsed = compose.ok ? parseEnrichmentJson(compose.content || "") : null;
      enriched = parsed?.enriched && typeof parsed.enriched === "string" ? parsed.enriched.trim() : "";
    } catch (e: any) {
      stats.failed++;
      logger.warn({ module: "enrichmentEngine", err: e?.message }, "compose failed");
      continue;
    }
    if (!enriched || enriched === cand.content) {
      stats.failed++;
      continue;
    }

    // 3e. Validate — factual vs sources, no hallucination.
    let valid = true;
    try {
      const v = await callJudge(
        `You are a strict enrichment validator. Given ORIGINAL, ENRICHED, and SOURCES, judge whether ENRICHED preserves the original and adds ONLY facts supported by the sources (no hallucination, no off-topic drift). Respond ONLY with JSON: {"score": <0.0-1.0>, "reason": "<one sentence>"} where 0 = terrible and 1 = perfect.`,
        `ORIGINAL:\n${cand.content}\n\nENRICHED:\n${enriched}\n\nSOURCES:\n${JSON.stringify(realSources).slice(0, 6000)}`,
      );
      const parsed = v.ok ? parseJudge(v.content || "") : null;
      if (!parsed || parsed.score < 0.6) valid = false;
    } catch {
      valid = false;
    }
    if (!valid) {
      stats.failed++;
      continue;
    }

    // 3f. Act (default apply per user decision; flag still available).
    if (action === "apply") {
      const r = await enrichMemory(cand.id, enriched, realSources, "enrichment");
      if (!r.ok) {
        stats.failed++;
        continue;
      }
      await writeFinding("enrichment_candidate", {
        memoryId: cand.id,
        severity: "medium",
        actionTaken: "enrich",
        detail: {
          score: cand.completeness,
          missing: cand.missing,
          sources: realSources,
          old_content: cand.content,
          new_content: enriched,
          new_memory_id: r.new_id,
        },
        status: "resolved",
      });
      stats.enriched++;
    } else {
      await writeFinding("enrichment_candidate", {
        memoryId: cand.id,
        severity: "medium",
        actionTaken: "flag",
        detail: {
          verdict: "enrich",
          score: cand.completeness,
          missing: cand.missing,
          sources: realSources,
          old_content: cand.content,
          new_content: enriched,
        },
      });
      stats.flagged++;
    }
  }

  lastRun = { at: new Date().toISOString(), action, stats, ms: Date.now() - started };
  logger.info({ module: "enrichmentEngine", action, stats }, "enrichment run complete");
  return lastRun;
}

// ── Scheduler ────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
export const enrichmentEngine = {
  start(): void {
    if (timer) return;
    const tick = async () => {
      if (!enrichmentEnabled()) return;
      try {
        await runEnrichment();
      } catch (e: any) {
        logger.error({ module: "enrichmentEngine", err: e?.message }, "scheduled enrichment run failed");
      }
    };
    setTimeout(tick, 30000);
    timer = setInterval(tick, Number(process.env.EG_ENRICHMENT_INTERVAL_MS) || 86400000);
  },
};
