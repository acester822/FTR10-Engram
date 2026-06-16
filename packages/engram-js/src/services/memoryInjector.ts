/*
 - filename: packages/engram-js/src/services/memoryInjector.ts
 - what is the file used for: Genome vs Phenotype separation and Temporal Decay engine
*/

import crypto from "node:crypto";
import type {
  DurableExecutor,
  DurableRememberInput,
} from "../durable/repository";
import { rememberDurableMemory } from "../durable/repository";
import { runDurableDecayJob, type DurableDecayJobResult } from "../durable/repository";

// ── Genome vs Phenotype classification ──────────────────────────────

export const GENOME_PATTERNS = [
  // Core facts — invariant truths
  /(?:^|[^a-z])(?:the\s+)?(?:capital|city|country|continent|ocean|mountain|river)\b/i,
  // Definitions and taxonomies
  /\b(?:is defined as|means|refers to|denotes|signifies)\b/i,
  // Scientific constants / laws
  /\b(?:speed of light|gravitational constant|planck\s*constant|avogadro|bohr\s*radius)\b/i,
  // Mathematical identities
  /\b(?:euler\s*(?:s|')? identity|pythagorean theorem|fermat's last theorem|fundamental theorem of calculus)\b/i,
  // Historical dates and events with precise anchors
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},\s+\d{4}\b/i,
] as const;

export const PHENOTYPE_PATTERNS = [
  // Opinions and beliefs
  /\b(?:i think|i believe|i feel|i prefer|i like|i want|in my opinion|imho)\b/i,
  // Temporal references — time-bound statements
  /\b(?:today|yesterday|tomorrow|this\s+week|last\s+(?:month|year)|next\s+(?:month|year))\b/i,
  // Conversational fillers and discourse markers
  /\b(?:well|so|um|uh|you know|i mean|like)\s+[a-z]/i,
  // Personal experiences — inherently ephemeral
  /\b(?:last night|this morning|just now|right before|when i was)/i,
] as const;

export function classifyAsGenome(content: string): boolean {
  for (const pattern of GENOME_PATTERNS) {
    if (pattern.test(content)) return true;
  }
  // Default heuristic: short, declarative sentences without first-person pronouns
  const trimmed = content.trim();
  if (trimmed.length < 50 && !/^(i|we|my|our)\b/i.test(trimmed)) {
    return true;
  }
  return false;
}

// ── Classification helper used by repository.ts ──────────────────────

export interface MemoryClassificationResult {
  is_genome: boolean;
  sector: string;
}

/**
 * Classify a piece of content as genome or phenotype, returning both the
 * classification flag and an inferred HMD sector.
 */
export function classifyMemory(content: string): MemoryClassificationResult {
  const isGenome = classifyAsGenome(content);
  // Infer sector from content heuristics
  let sector = "semantic";
  if (/\b(?:deploy|build|run|install|compile)\b/i.test(content)) sector = "procedural";
  else if (/\b(?:today|yesterday|tomorrow|last night|this morning)\b/i.test(content)) sector = "episodic";
  else if (/\b(?:frustrat|hppy|love|hate|annoyed|excited|disappointed)\b/i.test(content)) sector = "emotional";
  else if (/\b(?:lesson|learned|realized|understand|summary|conclusion)\b/i.test(content)) sector = "reflective";

  return { is_genome: isGenome, sector };
}

// ── Decay rate constants used by repository.ts ────────────────────────

export const DEFAULT_GENOME_DECAY_RATE = 0.03;   // genome memories decay at 30% the phenotype rate
export const DEFAULT_PHENOTYPE_DECAY_RATE = 0.1;  // plan default: REAL DEFAULT 0.1

// ── Temporal Decay Engine ───────────────────────────────────────────

export interface DecayConfig {
  // Base decay rate per day (0-1), lower = slower decay
  baseRate: number;
  // Genome memories decay slower — this multiplier is applied on top of baseRate
  genomeMultiplier: number;
  // Access-based reinforcement: each access reduces effective age by this many days
  accessReinforcementDays: number;
  // Minimum salience threshold before a memory is considered "decayed" and can be archived
  decayThreshold: number;
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  baseRate: 0.01,        // 1% per day default
  genomeMultiplier: 0.3, // Genome memories decay at 30% the rate of phenotype
  accessReinforcementDays: 7, // Each access resets effective age by 7 days
  decayThreshold: 0.1,   // Below this salience → eligible for archive
};

export function computeEffectiveAge(
  recordedAt: string | Date,
  lastAccessedAt: string | Date | null,
  accessCount: number,
): number {
  const base = new Date(recordedAt);
  if (Number.isNaN(base.getTime())) return 0;

  // If there are accesses, compute effective age by subtracting reinforcement days per access
  let effectiveAgeMs = Date.now() - base.getTime();
  if (lastAccessedAt && accessCount > 0) {
    const lastAccess = new Date(lastAccessedAt);
    if (!Number.isNaN(lastAccess.getTime())) {
      // Use time since last access as the primary age signal, but also factor in total accesses
      const daysSinceLastAccess = Math.max(0, (Date.now() - lastAccess.getTime()) / 86_400_000);
      effectiveAgeMs = daysSinceLastAccess * 86_400_000;
    }
  }

  // Apply access reinforcement: each access reduces effective age by `accessReinforcementDays` worth of time
  const reinforcementDays = accessCount * DEFAULT_DECAY_CONFIG.accessReinforcementDays;
  const effectiveAgeMsReduced = Math.max(0, effectiveAgeMs - reinforcementDays * 86_400_000);

  return effectiveAgeMsReduced / 86_400_000; // Convert to days
}

export function computeDecaySalience(
  currentSalience: number,
  isGenome: boolean,
  effectiveAgeDays: number,
  config: DecayConfig = DEFAULT_DECAY_CONFIG,
): number {
  const rate = isGenome ? config.baseRate * config.genomeMultiplier : config.baseRate;
  // Exponential decay with salience-dependent lambda (faster decay for lower salience)
  const lambda = rate / (currentSalience + 0.1);
  const next = currentSalience * Math.exp(-lambda * effectiveAgeDays);
  return Math.max(0, Math.min(1, Number(next.toFixed(6))));
}

// ── MemoryInjector Service ──────────────────────────────────────────

export interface MemoryInjectorOptions {
  decayConfig?: DecayConfig;
  classifyAsGenomeFn?: (content: string) => boolean;
}

export class MemoryInjector {
  private config: DecayConfig;
  private classifyFn: (content: string) => boolean;

  constructor(options: MemoryInjectorOptions = {}) {
    this.config = options.decayConfig || DEFAULT_DECAY_CONFIG;
    this.classifyFn = options.classifyAsGenomeFn || classifyAsGenome;
  }

  /**
   * Inject a memory, classifying it as genome or phenotype and setting appropriate decay rate.
   */
  async inject(
    db: DurableExecutor,
    input: Omit<DurableRememberInput, "is_genome" | "decay_rate"> & {
      isGenome?: boolean;
    },
  ): Promise<{ id: string; status: "stored"; isGenome: boolean }> {
    const content = input.content?.trim() || "";
    if (!content) throw new Error("content is required");

    const isGenome = typeof input.isGenome === "boolean" ? input.isGenome : this.classifyFn(content);
    const decayRate = isGenome ? this.config.baseRate * this.config.genomeMultiplier : this.config.baseRate;

    return await rememberDurableMemory(db, {
      ...input,
      content,
      // Override default values with genome-aware ones
      metadata: {
        ...(input.metadata || {}),
        is_genome: isGenome,
        decay_rate: decayRate,
        access_count: 0,
      },
    });
  }

  /**
   * Record an access to a memory — this reinforces the memory by updating last_accessed_at.
   */
  async recordAccess(
    db: DurableExecutor,
    memoryId: string,
    userId?: string,
    now = new Date(),
  ): Promise<{ id: string; isGenome: boolean; salience: number }> {
    const memories = this.table(db, "memories");
    const auditLog = this.table(db, "audit_log");

    const result = (await db.query(
      `update ${memories}
       set last_accessed_at = $2, access_count = access_count + 1
       where id = $1 and superseded_at is null
       returning id,is_genome,salience`,
      [memoryId, now.toISOString()],
    )) as { rows?: any[] };

    const row = result.rows?.[0];
    if (!row) throw new Error(`memory ${memoryId} not found`);

    await db.query(
      `insert into ${auditLog}
        (id,user_id,project_id,event_type,target_table,target_id,operation,before_state,after_state,metadata,recorded_at,actor_id,actor_type)
       values ($1,$2,$3,'memory.access','memories',$4,'access',null,null,$5::jsonb,$6,$7,$8)`,
      [
        crypto.randomUUID(),
        userId || null,
        null,
        memoryId,
        JSON.stringify({ is_genome: row.is_genome }),
        now.toISOString(),
        userId || "system",
        userId ? "user" : "system",
      ],
    );

    return {
      id: memoryId,
      isGenome: Boolean(row.is_genome),
      salience: Number(row.salience ?? 0.5),
    };
  }

  /**
   * Run a temporal decay job — scans memories and applies exponential decay based on effective age.
   */
  async runDecayJob(
    db: DurableExecutor,
    options: {
      userId?: string;
      projectId?: string;
      actorId?: string;
      limit?: number;
      dryRun?: boolean;
    } = {},
  ): Promise<DurableDecayJobResult> {
    return await runDurableDecayJob(db, {
      user_id: options.userId,
      project_id: options.projectId,
      actor_id: options.actorId || "decay_engine",
      limit: options.limit,
      dry_run: options.dryRun,
    });
  }

  /**
   * Archive memories that have decayed below the threshold.
   */
  async archiveDecayed(
    db: DurableExecutor,
    options: {
      userId?: string;
      projectId?: string;
      actorId?: string;
      limit?: number;
      dryRun?: boolean;
    } = {},
  ): Promise<{ archived: number; memories: Array<{ id: string; salience_before: number; salience_after: number }> }> {
    const memories = this.table(db, "memories");
    const auditLog = this.table(db, "audit_log");

    const limit = Math.max(1, Math.min(500, options.limit || 100));
    const threshold = this.config.decayThreshold;
    const params: unknown[] = [threshold];
    const filters = ["memory_tier != 'archived'", "superseded_at is null", "salience < $1"];

    if (options.userId) {
      params.push(options.userId);
      filters.push(`user_id = $${params.length}`);
    }
    if (options.projectId) {
      params.push(options.projectId);
      filters.push(`project_id = $${params.length}`);
    }

    const candidates = (await db.query(
      `select id,user_id,project_id,salience,memory_tier,is_genome from ${memories}
       where ${filters.join(" and ")}
       order by salience asc
       limit $2`,
      [...params, limit],
    )) as { rows?: any[] };

    const changed: Array<{ id: string; salience_before: number; salience_after: number }> = [];
    if (options.dryRun) {
      return { archived: 0, memories: candidates.rows?.map((r) => ({ ...r })) || [] };
    }

    await db.query("BEGIN");
    try {
      for (const row of candidates.rows || []) {
        const newTier = row.is_genome ? "cold" : "archived";
        await db.query(
          `update ${memories} set memory_tier = $2 where id = $1`,
          [row.id, newTier],
        );

        changed.push({
          id: row.id,
          salience_before: Number(row.salience ?? 0.5),
          salience_after: Number((Number(row.salience ?? 0.5) * 0.8).toFixed(6)),
        });

        await db.query(
          `insert into ${auditLog}
            (id,user_id,project_id,event_type,target_table,target_id,operation,before_state,after_state,metadata,recorded_at,actor_id,actor_type)
           values ($1,$2,$3,'memory.archive','memories',$4,'archive',null,null,$5::jsonb,$6,$7,$8)`,
          [
            crypto.randomUUID(),
            row.user_id || null,
            row.project_id || null,
            row.id,
            JSON.stringify({ archived_as: newTier }),
            new Date().toISOString(),
            options.actorId || "decay_engine",
            "system",
          ],
        );
      }

      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }

    return { archived: changed.length, memories: changed };
  }

  private table(db: DurableExecutor, name: string): string {
    const schema = process.env.EG_PG_SCHEMA || "public";
    return `"${schema}"."${name.replace(/"/g, '""')}"`;
  }
}
