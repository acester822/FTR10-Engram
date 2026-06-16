/*
    ____                   __  __                                 
   / __ \                 |  \/  |                                
  | |  | |_ __   ___ _ __ | \  / | ___ _ __ ___   ___  _ __ _   _ 
  | |  | | '_ \ / _ \ '_ \| |\/| |/ _ \ '_ ` _ \ / _ \| '__| | | |
  | |__| | |_) |  __/ | | | |  | | |__| | | | (_) | |  | |_| |
   \____/| .__/ \___|_| |_|_|  |_|\___|_| |_| |_|\___/|_|   \__, |
         | |                                                 __/ |
         |_|                                                |___/ 
  CaviraOSS @ 2026

 - filename: packages/engram-js/src/services/consolidationEngine.ts
 - what is the file used for: Background cron job that groups episodic memories older than 24 hours by consolidation_hash or embedding similarity, uses local LLM to summarize into one semantic memory, then deletes raw episodic memories.
*/

import crypto from "node:crypto";
import { all_async } from "../database/connection";

// ── Types ─────────────────────────────────────────────────────────────

export interface ConsolidationCandidate {
  id: string;
  content: string;
  created_at: string | null;
  consolidation_hash: string | null;
}

export interface ConsolidationResult {
  consolidated: number;
  deleted: number;
  newMemoryId: string | null;
}

// ── Configuration ─────────────────────────────────────────────────────

const CONSOLIDATION_THRESHOLD_HOURS = 24; // Memories older than 24h are candidates
const MIN_MEMORIES_TO_CONSOLIDATE = 3;    // Don't consolidate unless we have at least 3 related memories
const MAX_BATCH_SIZE = 10;                // Max episodic memories to consolidate per cycle
const LOCAL_LLM_MODEL = process.env.CONSOLIDATION_MODEL || "qwen2.5:7b";
const LOCAL_LLM_URL = process.env.OLLAMA_URL || "http://localhost:11434";

// ── Consolidation Engine ──────────────────────────────────────────────

export class ConsolidationEngine {
  /**
   * Query the database for episodic memories older than the threshold,
   * grouped by consolidation_hash (or unhashed fallback).
   */
  async getCandidates(
    db: { query(sql: string, params?: unknown[]): Promise<{ rows?: any[] }> },
    schema = process.env.EG_PG_SCHEMA || "public",
  ): Promise<Map<string | null, ConsolidationCandidate[]>> {
    const memories = `"${schema}"."memories"`;

    // Build the time threshold expression — default to Postgres syntax since EG_STORAGE=postgres
    const isPostgres = (process.env.EG_STORAGE || process.env.EG_STORAGE_BACKEND || "postgres").toLowerCase() !== "sqlite";
    const timeThreshold = isPostgres
      ? `NOW() - INTERVAL '${CONSOLIDATION_THRESHOLD_HOURS} hours'`
      : `datetime('now', '-${CONSOLIDATION_THRESHOLD_HOURS} hours')`;

   let rows: { rows?: any[] } = { rows: [] };
    try {
      rows = (await db.query(
        `select id, content, recorded_at, consolidation_hash 
          from ${memories}
          where memory_tier != 'archived'
            and is_genome = false
            and sector = 'episodic'
            and recorded_at < ${timeThreshold}
          order by recorded_at asc
          limit $1`,
        [MAX_BATCH_SIZE * 3],
      )) as { rows?: any[] };
    } catch (e) {
      // Log but don't crash — sector column may not exist on older installs
      console.warn("[ConsolidationEngine] getCandidates failed:", (e as Error).message);
    }

    const candidates: ConsolidationCandidate[] = (rows?.rows || []).map(
      (r) => ({
        id: r.id,
        content: r.content,
        created_at: r.recorded_at ?? null,
        consolidation_hash: r.consolidation_hash ?? null,
      }),
    );

    // Group by consolidation_hash; unhashed memories go into a "null" bucket
    const grouped = new Map<string | null, ConsolidationCandidate[]>();
    for (const c of candidates) {
      const key = c.consolidation_hash || "unhashed";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(c);
    }

    return grouped;
  }

  /**
   * Send a batch of episodic memories to the local LLM for synthesis.
   */
  async synthesizeWithLLM(
    memories: ConsolidationCandidate[],
  ): Promise<string | null> {
    const memoryList = memories
      .map((m) => `- [${m.created_at ? new Date(m.created_at).toISOString().split("T")[0] : "unknown"}] ${m.content}`)
      .join("\n");

    const prompt = `You are a cognitive memory consolidation engine. 
Your task is to read the following short-term, fragmented "episodic" memories and synthesize them into ONE concise, timeless "semantic" fact or rule.
Discard irrelevant details (like specific dates or one-off errors). Focus on the core pattern, preference, or architectural fact.
Respond ONLY with the synthesized sentence. Do not add quotes or introductory text.

Episodic Memories:
${memoryList}

Synthesized Semantic Memory:`.trim();

    try {
      const response = await fetch(`${LOCAL_LLM_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: LOCAL_LLM_MODEL,
          prompt,
          stream: false,
          options: { temperature: 0.1, num_predict: 150 },
        }),
      });

      if (!response.ok) {
        console.error(`[ConsolidationEngine] LLM returned status ${response.status}`);
        return null;
      }

      const data = await response.json();
      const synthesized = (data.response || "").trim();
      return synthesized.length >= 10 ? synthesized : null;
    } catch {
      console.error("[ConsolidationEngine] LLM synthesis failed");
      return null;
    }
  }

  /**
   * Run a single consolidation cycle: group candidates, synthesize each group via LLM,
   * insert semantic memories, delete the raw episodic ones.
   */
  async runCycle(
    db: { query(sql: string, params?: unknown[]): Promise<{ rows?: any[] }> },
    schema = process.env.EG_PG_SCHEMA || "public",
  ): Promise<ConsolidationResult> {
    const grouped = await this.getCandidates(db, schema);

    let consolidated = 0;
    let deleted = 0;
    let newMemoryId: string | null = null;

    for (const [hash, batch] of grouped) {
      if (batch.length < MIN_MEMORIES_TO_CONSOLIDATE) continue;

      const synthesized = await this.synthesizeWithLLM(batch);
      if (!synthesized?.trim()) continue;

      // Insert consolidated semantic memory (graceful fallback if genome columns don't exist yet)
      const newId = crypto.randomUUID();
      await db.query(
          `insert into "${schema}"."memories" 
             (id, content, sector, is_genome, decay_rate, access_count, recorded_at, consolidation_hash, user_id)
            values ($1, $2, 'semantic', false, 0.05, 1, now(), $3, 'system')`,
          [newId, synthesized, hash],
        );

      // Delete the raw episodic memories
      const ids = batch.map((m) => `'${m.id}'`).join(",");
      await db.query(`delete from "${schema}"."memories" where id in (${ids})`);

      consolidated++;
      deleted += batch.length;
      newMemoryId = newId;
    }

    return { consolidated, deleted, newMemoryId };
  }

 /**
    * Starts the background consolidation cron job. Call this once when your server boots.
    */
   start(): void {
     const intervalMs = 30 * 60 * 1000; // every 30 minutes
     const realDb = { query: (sql: string, params?: unknown[]) => all_async(sql, params as any[] ?? []).then((rows) => ({ rows })) };

     // Run once immediately on startup, then periodically
     this.runConsolidationCycle(realDb, process.env.EG_PG_SCHEMA || "public").catch((err) => {
       console.error("[Engram] Initial consolidation cycle failed:", err);
     });

     const timer = setInterval(() => {
       this.runConsolidationCycle(realDb, process.env.EG_PG_SCHEMA || "public").catch((err) => {
         console.error("[Engram] Scheduled consolidation cycle failed:", err);
       });
     }, intervalMs);

     timer.unref?.(); // Don't prevent process exit

     console.log("[Engram] Consolidation engine scheduled (every 30 mins).");
   }

  /**
   * Run the consolidation cycle and log results.
   */
  async runConsolidationCycle(
    db: { query(sql: string, params?: unknown[]): Promise<{ rows?: any[] }> },
    schema = process.env.EG_PG_SCHEMA || "public",
  ): Promise<ConsolidationResult> {
    console.log("[Engram] 🧠 Starting memory consolidation cycle...");
    const result = await this.runCycle(db, schema);
    if (result.consolidated > 0) {
      console.log(
        `[Engram] ✅ Consolidation complete. ${result.consolidated} groups → ${result.deleted} memories consolidated into semantic memory: ${result.newMemoryId}`,
      );
    } else {
      console.log("[Engram] No consolidation candidates found.");
    }
    return result;
  }
}

// ── Singleton ───────────────────────────────────────────────────────────

export const consolidationEngine = new ConsolidationEngine();
