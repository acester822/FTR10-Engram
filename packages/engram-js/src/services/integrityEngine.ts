/*
 - filename: packages/engram-js/src/services/integrityEngine.ts
 - what is the file used for: the memory integrity (auto-heal) engine
   (v4.4.0-integrity). Runs against the memories STORE on a schedule (or
   manually) verifying memories are complete (embeddable), valid (true, not
   noise/false), and coherent (no contradictions/duplicates) — repairing via
   the SHARED mutation primitives, with every action audited and logged as a
   finding. Two-tier automation:
   - Tier 1 (AUTO): deterministic checks — no LLM.
   - Tier 2 (GATED): judge-assisted false/stale memory sampling — only when the
     AUTOMATIC gate is open (latest calibration agree_rate >= min, consistency
     MAD <= max, evals fresh). User decision (Aug 2026): the gate turns ITSELF
     on/off from persisted eval results; the GUI shows a flashing red banner
     while closed. Nothing LLM-judged is ever touched while the gate is closed.
*/

import crypto from "node:crypto";
import { all_async as pg_all, run_async as pg_run } from "../database/connection";
import { embed, normalizeEmbedding } from "../embeddings/embed";
import { normalizeSector } from "./memoryInjector";
import { callJudge, parseJudge } from "./traceScorer";
import { latestJudgeEval } from "./traceGovernance";
import {
  hardDeleteMemories,
  supersedeMemories,
  reclassifyMemorySector,
  recordMemoryAudit,
  enrichMemory,
} from "../durable/mutations";
import { containsSecret } from "./traceStore";
import { saveSettings } from "./settingsService";
import { logger } from "../utils/logger";
import path from "node:path";

const VALID_SECTORS = ["semantic", "procedural", "episodic", "emotional", "reflective"];

// ── Config (mirrored GENERAL_SETTINGS → process.env, live at call time) ──

export function integrityEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes(String(process.env.EG_INTEGRITY_ENABLED).toLowerCase());
}
function integrityIntervalMs(): number {
  const n = Number(process.env.EG_INTEGRITY_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? n : 86400000;
}
function sampleSize(): number {
  const n = Number(process.env.EG_INTEGRITY_SAMPLE_SIZE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 25;
}
function deleteConfidence(): number {
  const n = Number(process.env.EG_INTEGRITY_DELETE_CONFIDENCE);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.15;
}
/** Tier 2 action mode — default FLAG (safe): the memory-validity rubric is a
 *  DIFFERENT rubric from the trace-scoring one the gate calibrates, and until
 *  it is validated too, LLM-judged deletions are opt-in only. 'delete' and
 *  'supersede' still require the gate to be open. */
function tier2Action(): "flag" | "delete" | "supersede" {
  const v = String(process.env.EG_INTEGRITY_TIER2_ACTION || "flag").toLowerCase();
  return v === "delete" || v === "supersede" ? v : "flag";
}

// ── The AUTOMATIC Tier-2 gate ───────────────────────────────────────────

export interface IntegrityGate {
  open: boolean;
  calibration: number | null;
  mad: number | null;
  reasons: string[];
  tier2: boolean;
}

export async function integrityGate(): Promise<IntegrityGate> {
  const minCal = Number(process.env.EG_INTEGRITY_MIN_CALIBRATION) || 0.8;
  const maxMad = Number(process.env.EG_INTEGRITY_MAX_MAD) || 0.1;
  const maxAgeDays = Number(process.env.EG_INTEGRITY_GATE_MAX_AGE_DAYS) || 7;
  const reasons: string[] = [];
  const cal = await latestJudgeEval("calibration");
  const con = await latestJudgeEval("consistency");
  const calRate = cal?.result?.agree_rate ?? null;
  const mad = con?.result?.overall_mean_abs_dev ?? null;
  const stale = (row: any) => {
    if (!row) return true;
    return Date.now() - new Date(row.created_at).getTime() > maxAgeDays * 86400000;
  };
  if (!cal || calRate === null) reasons.push("no calibration results — run calibration in the Governance tab");
  else if (stale(cal)) reasons.push(`calibration results older than ${maxAgeDays}d — re-run`);
  else if (calRate < minCal) reasons.push(`calibration ${calRate} < ${minCal}`);
  if (!con || mad === null) reasons.push("no consistency results — run consistency in the Governance tab");
  else if (stale(con)) reasons.push(`consistency results older than ${maxAgeDays}d — re-run`);
  else if (mad > maxMad) reasons.push(`consistency MAD ${mad} > ${maxMad}`);
  const open = reasons.length === 0;
  return { open, calibration: calRate, mad, reasons, tier2: open };
}

// ── Findings ledger ─────────────────────────────────────────────────────

async function writeFinding(
  runId: string,
  checkName: string,
  opts: { memoryId?: string | null; severity?: string; actionTaken?: string; detail?: unknown; status?: string },
): Promise<void> {
  await pg_run(
    `INSERT INTO public.integrity_findings (run_id, check_name, memory_id, severity, action_taken, detail, status, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, CASE WHEN $7 = 'resolved' THEN now() ELSE NULL END)`,
    [
      runId,
      checkName,
      opts.memoryId ?? null,
      opts.severity ?? "medium",
      opts.actionTaken ?? "none",
      JSON.stringify(opts.detail ?? {}),
      opts.status ?? "open",
    ],
  ).catch((e: any) => logger.warn({ module: "integrityEngine", err: e?.message }, "finding write failed"));
}

// ── Main run ────────────────────────────────────────────────────────────

export async function runIntegrity(): Promise<any> {
  if (integrityRunning) return { skipped: true, reason: "integrity run already in progress — skipped (manual + scheduled overlapped)" };
  integrityRunning = true;
  try {
    return await doIntegrityRun();
  } finally {
    integrityRunning = false;
  }
}

let integrityRunning = false;

async function doIntegrityRun(): Promise<any> {
  if (!integrityEnabled()) {
    return { skipped: true, reason: "EG_INTEGRITY_ENABLED is false — enable it in Settings → General → Integrity" };
  }
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const gate = await integrityGate();
  const summary: Record<string, any> = {};
  const tier2 = { sampled: 0, deleted: 0, superseded: 0, flagged: 0, errors: 0 };

  // Insert the run row FIRST — findings reference it (FK); the pre-fix code
  // inserted it last so every finding silently FK-failed.
  await pg_run(
    `INSERT INTO public.integrity_runs (id, started_at, tier2_enabled, gate) VALUES ($1, $2, $3, $4::jsonb)`,
    [runId, startedAt, gate.open, JSON.stringify(gate)],
  );

  // ── Tier 1: deterministic checks ──

  // 1. null_embeddings → backfill (recall-invisible memories)
  {
    const rows = await pg_all(
      `SELECT id, content FROM public.memories
       WHERE superseded_at IS NULL AND memory_tier <> 'archived' AND embedding IS NULL
       ORDER BY recorded_at ASC LIMIT 100`,
      [],
    );
    summary.null_embeddings = rows.length;
    let ok = 0;
    let failed = 0;
    for (const r of rows) {
      try {
        const vec = normalizeEmbedding(await embed(r.content));
        if (vec && vec.length) {
          await pg_run(`UPDATE public.memories SET embedding = $2::halfvec WHERE id = $1`, [r.id, JSON.stringify(vec)]);
          await recordMemoryAudit({
            actor_id: "auto-heal",
            event_type: "integrity_repair",
            operation: "backfill_embedding",
            target_table: "memories",
            target_id: r.id,
            before_state: { embedding: null },
            after_state: { embedding: `halfvec(${vec.length})` },
            metadata: { check: "null_embeddings" },
          });
          ok++;
        } else {
          failed++;
          await writeFinding(runId, "null_embeddings", { memoryId: r.id, severity: "high", actionTaken: "flag", detail: { reason: "embed returned empty" } });
        }
      } catch (e: any) {
        failed++;
        await writeFinding(runId, "null_embeddings", { memoryId: r.id, severity: "high", actionTaken: "flag", detail: { reason: e?.message || String(e) } });
      }
    }
    summary.null_embeddings_backfilled = ok;
    summary.null_embeddings_failed = failed;
  }

  // 2. synthetic_embeddings → re-embed once; still synthetic → flag
  {
    const rows = await pg_all(
      `SELECT id, content FROM public.memories WHERE superseded_at IS NULL AND embedding_synthetic = true LIMIT 50`,
      [],
    );
    summary.synthetic_embeddings = rows.length;
    for (const r of rows) {
      try {
        const vec = normalizeEmbedding(await embed(r.content));
        if (vec && vec.length) {
          await pg_run(
            `UPDATE public.memories SET embedding = $2::halfvec, embedding_synthetic = false WHERE id = $1`,
            [r.id, JSON.stringify(vec)],
          );
          await recordMemoryAudit({
            actor_id: "auto-heal",
            event_type: "integrity_repair",
            operation: "reembed",
            target_table: "memories",
            target_id: r.id,
            before_state: { embedding_synthetic: true },
            after_state: { embedding_synthetic: false },
            metadata: { check: "synthetic_embeddings" },
          });
        }
      } catch (e: any) {
        await writeFinding(runId, "synthetic_embeddings", { memoryId: r.id, severity: "medium", actionTaken: "flag", detail: { reason: e?.message || String(e) } });
      }
    }
  }

  // 3. empty_content → delete
  {
    const rows = await pg_all(
      `SELECT id FROM public.memories WHERE superseded_at IS NULL AND (content IS NULL OR btrim(content) = '')`,
      [],
    );
    summary.empty_content = rows.length;
    if (rows.length) {
      await hardDeleteMemories(rows.map((r: any) => r.id), "auto-heal", { check: "empty_content" });
      for (const r of rows) {
        await writeFinding(runId, "empty_content", { memoryId: r.id, severity: "high", actionTaken: "delete", status: "resolved" });
      }
      summary.empty_content_deleted = rows.length;
    }
  }

  // 4. secrets → delete (the June-incident rule, guaranteed)
  {
    const rows = await pg_all(
      `SELECT id, content FROM public.memories WHERE superseded_at IS NULL LIMIT 5000`,
      [],
    );
    const targets = rows.filter((r: any) => containsSecret(r.content || ""));
    summary.secrets = targets.length;
    if (targets.length) {
      await hardDeleteMemories(targets.map((r: any) => r.id), "auto-heal", { check: "secrets" });
      for (const r of targets) {
        await writeFinding(runId, "secrets", { memoryId: r.id, severity: "high", actionTaken: "delete", detail: { content: (r.content || "").slice(0, 200) }, status: "resolved" });
      }
      summary.secrets_deleted = targets.length;
    }
  }

  // 5. invalid_sector → reclassify
  {
    const rows = await pg_all(
      `SELECT id, sector FROM public.memories
       WHERE superseded_at IS NULL AND sector NOT IN ('semantic','procedural','episodic','emotional','reflective')
       LIMIT 200`,
      [],
    );
    summary.invalid_sector = rows.length;
    for (const r of rows) {
      const fixed = normalizeSector(r.sector);
      if (fixed !== r.sector) {
        await reclassifyMemorySector(r.id, fixed, "auto-heal", { check: "invalid_sector" });
        await writeFinding(runId, "invalid_sector", { memoryId: r.id, severity: "medium", actionTaken: "reclassify", detail: { from: r.sector, to: fixed }, status: "resolved" });
      }
    }
  }

  // 6. near_duplicates → supersede the older (reversible)
  {
    const rows = await pg_all(
      `SELECT a.id AS a_id, b.id AS b_id, a.recorded_at AS a_ts, b.recorded_at AS b_ts,
              round((1 - (a.embedding <=> b.embedding))::numeric, 3) AS sim
       FROM public.memories a JOIN public.memories b ON a.id < b.id
       WHERE a.superseded_at IS NULL AND b.superseded_at IS NULL
         AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
         AND (1 - (a.embedding <=> b.embedding)) > 0.92
       ORDER BY sim DESC LIMIT 100`,
      [],
    );
    summary.near_duplicates = rows.length;
    for (const r of rows) {
      const older = new Date(r.a_ts) <= new Date(r.b_ts) ? r.a_id : r.b_id;
      const kept = older === r.a_id ? r.b_id : r.a_id;
      await supersedeMemories([older], "auto-heal", { check: "near_duplicates", kept, similarity: Number(r.sim) });
      await writeFinding(runId, "near_duplicates", { memoryId: older, severity: "medium", actionTaken: "supersede", detail: { kept, similarity: Number(r.sim) }, status: "resolved" });
    }
  }

  // 7. contradictions_open → flag only (never auto-resolve)
  {
    const rows = await pg_all(`SELECT count(*)::int AS n FROM public.contradictions WHERE status = 'open'`, []);
    summary.contradictions_open = rows[0]?.n || 0;
    if (rows[0]?.n) {
      await writeFinding(runId, "contradictions_open", { memoryId: null, severity: "medium", actionTaken: "flag", detail: { count: rows[0].n, note: "unresolved contradictions — review manually, never auto-resolve" } });
    }
  }

  // 8. coverage_probes → known-good queries must still hit
  {
    const probes = [
      "always run tests before committing",
      "PDF report generation with html2canvas",
      "judge calibration and consistency governance",
    ];
    const missed: string[] = [];
    for (const q of probes) {
      try {
        const vec = normalizeEmbedding(await embed(q));
        const res = await pg_all(
          `SELECT id FROM public.memories
           WHERE superseded_at IS NULL AND embedding IS NOT NULL
           ORDER BY embedding <=> $1::halfvec LIMIT 1`,
          [JSON.stringify(vec)],
        );
        if (!res.length) missed.push(q);
      } catch {
        /* embed backend down — skip probe this run */
      }
    }
    summary.coverage_probes_missed = missed;
    if (missed.length) {
      await writeFinding(runId, "coverage_probes", { memoryId: null, severity: "high", actionTaken: "flag", detail: { missed } });
    }
  }

  // 9. broken_links → edges whose endpoint memory is superseded or gone
  //    (coherence rung v4.6.0 — the graph cannot rot silently). Deleted
  //    endpoints vanish via ON DELETE CASCADE, so this catches the soft-dead
  //    (superseded) side. Flag only — pruning waits for Tier-2 authority.
  {
    const rows = await pg_all(
      `SELECT e.id AS edge_id, e.edge_type, e.source_memory_id, e.target_memory_id,
              (s.superseded_at IS NOT NULL) AS source_superseded, (t.superseded_at IS NOT NULL) AS target_superseded
       FROM public.edges e
       LEFT JOIN public.memories s ON s.id = e.source_memory_id
       LEFT JOIN public.memories t ON t.id = e.target_memory_id
       WHERE (s.superseded_at IS NOT NULL OR t.superseded_at IS NOT NULL)
       LIMIT 200`,
      [],
    );
    summary.broken_links = rows.length;
    for (const r of rows) {
      await writeFinding(runId, "broken_links", {
        memoryId: r.target_superseded ? r.target_memory_id : r.source_memory_id,
        severity: "low",
        actionTaken: "flag",
        detail: { edge_id: r.edge_id, edge_type: r.edge_type, source_superseded: r.source_superseded, target_superseded: r.target_superseded },
      });
    }
  }

  // ── Tier 2: gated judge sampling ──
  if (gate.open) {
    const conf = deleteConfidence();
    const action = tier2Action();
    const rows = await pg_all(
      `SELECT id, content, sector FROM public.memories
       WHERE superseded_at IS NULL AND memory_tier <> 'archived' AND embedding IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM public.integrity_findings f
           WHERE f.check_name = 'false_memory_sampling' AND f.memory_id = memories.id AND f.status = 'open'
         )
       ORDER BY (CASE WHEN access_count = 0 THEN 0 ELSE 1 END), recorded_at ASC
       LIMIT $1`,
      [sampleSize()],
    );
    for (const r of rows) {
      tier2.sampled++;
      try {
        const j = await callJudge(
          `You are a strict memory-validity auditor. Given a stored memory fact, judge whether it is TRUE, FALSE, NOISE (not a real fact), or STALE. Respond ONLY with JSON: {"score": <0.0-1.0>, "reason": "<one sentence>"} where 0 = definitely false/noise and 1 = definitely true and useful.`,
          `STORED MEMORY (sector: ${r.sector}):\n${(r.content || "").slice(0, 800)}`,
        );
        const parsed = j.ok ? parseJudge(j.content || "") : null;
        if (!parsed) {
          tier2.errors++;
          continue;
        }
        if (parsed.score < conf) {
          if (action === "flag") {
            // Safe default: surface the candidate, never mutate on an
            // unvalidated rubric. Human applies/disposes in the Audit tab.
            await writeFinding(runId, "false_memory_sampling", { memoryId: r.id, severity: "high", actionTaken: "flag", detail: { score: parsed.score, reason: parsed.reason, verdict: "delete candidate" } });
            tier2.flagged++;
          } else {
            await hardDeleteMemories([r.id], "auto-heal", { check: "false_memory_sampling", judge_score: parsed.score, judge_reason: parsed.reason });
            await writeFinding(runId, "false_memory_sampling", { memoryId: r.id, severity: "high", actionTaken: "delete", detail: { score: parsed.score, reason: parsed.reason }, status: "resolved" });
            tier2.deleted++;
          }
        } else if (parsed.score < 0.4) {
          if (action === "flag" || action === "delete") {
            await writeFinding(runId, "false_memory_sampling", { memoryId: r.id, severity: "medium", actionTaken: "flag", detail: { score: parsed.score, reason: parsed.reason, verdict: "supersede candidate" } });
            if (action !== "flag") tier2.flagged++;
          } else {
            await supersedeMemories([r.id], "auto-heal", { check: "false_memory_sampling", judge_score: parsed.score, judge_reason: parsed.reason });
            await writeFinding(runId, "false_memory_sampling", { memoryId: r.id, severity: "medium", actionTaken: "supersede", detail: { score: parsed.score, reason: parsed.reason }, status: "resolved" });
            tier2.superseded++;
          }
        }
      } catch (e: any) {
        tier2.errors++;
        logger.warn({ module: "integrityEngine", err: e?.message }, "tier2 sample failed");
      }
    }
  }

  await pg_run(
    `UPDATE public.integrity_runs SET completed_at = $2, summary = $3::jsonb WHERE id = $1`,
    [runId, new Date().toISOString(), JSON.stringify(summary)],
  );

  logger.info({ module: "integrityEngine", runId, gate: gate.open, summary, tier2 }, "integrity run complete");
  return { run_id: runId, gate, summary, tier2, skipped: false };
}

// ── Status + findings queries ───────────────────────────────────────────

export async function integrityStatus(): Promise<any> {
  const gate = await integrityGate();
  const runs = await pg_all(
    `SELECT id, started_at, completed_at, tier2_enabled, summary, gate
     FROM public.integrity_runs ORDER BY started_at DESC LIMIT 1`,
    [],
  );
  const openFindings = await pg_all(
    `SELECT count(*)::int AS n FROM public.integrity_findings WHERE status = 'open'`,
    [],
  );
  return {
    enabled: integrityEnabled(),
    gate,
    last_run: runs[0] || null,
    open_findings: openFindings[0]?.n || 0,
  };
}

export async function listFindings(f: { status?: string; severity?: string; limit?: number } = {}): Promise<any[]> {
  const where: string[] = [];
  const params: any[] = [];
  if (f.status) {
    params.push(f.status);
    where.push(`status = $${params.length}`);
  }
  if (f.severity) {
    params.push(f.severity);
    where.push(`severity = $${params.length}`);
  }
  const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 500);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await pg_all(
    `SELECT f.id, f.check_name, f.memory_id, f.severity, f.action_taken, f.detail, f.status, f.created_at, f.resolved_at,
            m.content AS memory_content, m.sector AS memory_sector, m.superseded_at AS memory_superseded_at,
            CASE WHEN f.detail->>'new_memory_id' IS NULL THEN NULL
                 ELSE EXISTS (SELECT 1 FROM public.memories s WHERE s.id = (f.detail->>'new_memory_id')::uuid AND s.superseded_at IS NULL)
            END AS successor_live
     FROM public.integrity_findings f
     LEFT JOIN public.memories m ON m.id = f.memory_id
     ${whereSql}
     ORDER BY f.created_at DESC LIMIT $${params.length + 1}`,
    [...params, limit],
  );
  // Surface the verdict at the top level so the GUI can show what Apply would do.
  return rows.map((f: any) => ({ ...f, verdict: f.detail?.verdict ?? null }));
}

/** Human disposition of a finding.
 *  dismiss → close without touching the memory.
 *  apply → PERFORM the deferred repair (human click IS the approval — no gate
 *  needed): for flagged false_memory_sampling candidates, delete or supersede
 *  the memory per the verdict, through the audited mutation primitives, then
 *  mark the finding resolved with the outcome recorded in its detail. */
export async function resolveFinding(
  id: string,
  action: "dismiss" | "apply",
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  const rows = await pg_all(`SELECT * FROM public.integrity_findings WHERE id = $1`, [id]);
  if (!rows.length) return { ok: false, error: "not_found" };
  const f = rows[0];

  if (action === "dismiss") {
    await pg_run(
      `UPDATE public.integrity_findings
       SET status = 'dismissed', resolved_at = now(),
           detail = jsonb_set(coalesce(detail, '{}'::jsonb), '{resolution}', to_jsonb($2::text))
       WHERE id = $1`,
      [id, note ?? "dismissed by user"],
    );
    return { ok: true };
  }

  // apply — perform the deferred repair
  if (f.status !== "open") return { ok: true }; // already handled
  let actionTaken = f.action_taken;
  let appliedNote = note ?? "applied by user";

  // Enrichment access request — Apply = GRANT the directory (persisted),
  // Dismiss = deny (default flow marks it dismissed).
  if (f.check_name === "enrichment_access_request" && f.action_taken === "flag") {
    const root = f.detail?.root;
    if (typeof root === "string" && root) {
      const current = String(process.env.EG_ENRICHMENT_SEARCH_ROOTS || "");
      const list = current.split(",").map((s) => s.trim()).filter(Boolean);
      if (!list.some((r) => path.resolve(r) === path.resolve(root))) {
        list.push(root);
        await saveSettings({ "general.enrichment_search_roots": list.join(",") });
        appliedNote = `granted access to ${root}`;
      } else {
        appliedNote = `already granted: ${root}`;
      }
      actionTaken = "grant_access";
    } else {
      appliedNote = "no root in finding detail — nothing to grant";
    }
  } else if (f.check_name === "enrichment_candidate" && f.action_taken === "flag" && f.memory_id && f.detail?.new_content) {
    // Deferred enrichment (only reachable in flag mode) — human click = approval.
    const r = await enrichMemory(f.memory_id, f.detail.new_content, f.detail.sources ?? [], "user-apply");
    if (r.ok) {
      actionTaken = "enrich";
      appliedNote = `applied by user (enrich) — successor ${r.new_id}`;
    } else {
      appliedNote = `enrichment failed: ${r.error}`;
    }
  } else if (f.action_taken === "flag" && f.memory_id && f.check_name === "false_memory_sampling") {
    const verdict = f.detail?.verdict;
    const stillThere = await pg_all(`SELECT id, superseded_at FROM public.memories WHERE id = $1`, [f.memory_id]);
    if (!stillThere.length) {
      appliedNote = "memory already deleted — finding resolved";
    } else if (stillThere[0].superseded_at) {
      appliedNote = "memory already superseded — finding resolved";
    } else if (verdict === "delete candidate") {
      await hardDeleteMemories([f.memory_id], "auto-heal", {
        check: "false_memory_sampling",
        via: "user-apply",
        finding_id: id,
        judge_score: f.detail?.score,
        judge_reason: f.detail?.reason,
      });
      actionTaken = "delete";
      appliedNote = `applied by user (delete) — judge ${f.detail?.score}: ${f.detail?.reason}`;
    } else {
      await supersedeMemories([f.memory_id], "auto-heal", {
        check: "false_memory_sampling",
        via: "user-apply",
        finding_id: id,
        judge_score: f.detail?.score,
        judge_reason: f.detail?.reason,
      });
      actionTaken = "supersede";
      appliedNote = `applied by user (supersede) — judge ${f.detail?.score}: ${f.detail?.reason}`;
    }
  }

  await pg_run(
    `UPDATE public.integrity_findings
     SET status = 'resolved', resolved_at = now(), action_taken = $2,
         detail = jsonb_set(coalesce(detail, '{}'::jsonb), '{resolution}', to_jsonb($3::text))
     WHERE id = $1`,
    [id, actionTaken, appliedNote],
  );
  return { ok: true };
}

// ── Scheduler (started beside consolidation in api/index.ts) ────────────

let timer: NodeJS.Timeout | null = null;
export const integrityEngine = {
  start(): void {
    if (timer) return;
    const tick = async () => {
      if (!integrityEnabled()) return;
      try {
        await runIntegrity();
      } catch (e: any) {
        logger.error({ module: "integrityEngine", err: e?.message }, "scheduled integrity run failed");
      }
    };
    // first tick shortly after boot, then on the interval
    setTimeout(tick, 15000);
    timer = setInterval(tick, integrityIntervalMs());
  },
};
