# The Living Engram: Closing the Feedback Loop

> **Status**: design doc (v1.0) — Aug 2026
> **Author**: acester822 + Hermes Agent
> **Goal**: make Engram a *self-improving* system where judge scores drive hyperparameters, memory salience tracks measured usefulness, and the trust ladder governs its own tuning — without breaking the audit/undo guarantee.

---

## Diagnosis: the loop is open, not closed

Engram already has every component of a learning system:

- `traceScorer.ts` → three judge dimensions (`recall_relevance`, `extraction_fidelity`, `answer_quality`)
- `traceStore.ts` → persistent trace table with scores, injection stats, bodies
- `traceSuggestions.ts` → deterministic remediation suggestions
- `enrichmentEngine.ts` → used-most × weakest → sourced successors
- `recallGapEngine.ts` → recall failures → enrichment proposals
- `consolidationEngine.ts` → merge/update/promote/delete
- `integrityEngine.ts` → auto-heal with calibration gate
- `memoryInjector.ts` → temporal decay + access reinforcement

The gap: **judge scores go to a dashboard for a human to eyeball.** They never feed back into the hyperparameters that control extraction, recall, or decay. The system measures its own performance but doesn't *act* on those measurements. That's an open loop.

A closed loop: scores → adjust knobs → next run scores differently → measure again.

---

## Design principles

1. **The store is the authority; the LLM is a stateless function.** Learning lives in Postgres + TypeScript, not in weight updates. (See §Why not weights below.)
2. **Every change is audited and reversible.** Your trust ladder's strongest property — `audit_log` with before/after state, one-click undo — must extend to *every* knob the system turns on itself. No silent mutations.
3. **The judge governs the loop.** Calibration gate + consistency check + policy thresholds already exist. The same gate that blocks integrity Tier-2 from acting when the judge is uncalibrated also blocks the learning loop from turning knobs when the judge is unreliable.
4. **Deterministic over LLM-driven.** Wherever possible, use arithmetic on existing scores, not another LLM call. LLMs are slow, non-deterministic, and expensive; the judge is already there for the one thing arithmetic can't do (grade quality).
5. **Flag-first for structural changes.** New knobs, new tables, new code paths — default to `flag` so the human can review before apply. Earn `apply` by demonstrating stable improvement.

---

## Step 1: Close the loop (judge scores → hyperparameters)

### 1.1 What exists

`traceSuggestions.ts` already computes `dimAvg("recall_relevance")`, compares to `policyThresholds()`, and emits suggestions like "Recall relevance is weak (avg 0.42)". But these are text strings returned by `POST /api/dashboard/traces/report`. Nothing consumes them.

### 1.2 What's missing

A `learning_policy` subsystem that:
- Reads score trends from `traces.scores` (last N days)
- Maps each trend to a specific hyperparameter adjustment
- Writes the proposed adjustment to a new `learning_proposals` table (flag-first)
- On human Apply, writes the adjustment to `app_settings` with an `audit_log` entry
- Tracks whether the adjustment actually improved the next window's scores

### 1.3 Concrete mapping: score → knob

| Score signal | Current behavior | Proposed knob | Where the knob lives |
|---|---|---|---|
| `recall_relevance` trending DOWN over last 7 days | Nothing; human sees suggestion | Adjust hybrid fusion: lower `vectorProbability` floor or shift keyword weight | `EG_HYBRID_VECTOR_FLOOR` (new, default 0.25) and `EG_HYBRID_KEYWORD_SCALE` (new, default 2.0) in `scoring.ts` → `vectorProbability()` and `lexicalProbability()` |
| `recall_relevance` on conversational queries (low, expected) but DOWN on knowledge queries | `eligibleForScoring` already filters conversational queries | Tighten `QUESTION_RE` / raise `EG_AUTO_SEARCH_MIN_CONFIDENCE` | `autoSearch.ts` → `shouldSearch()` |
| `extraction_fidelity` trending DOWN on `semantic` sector | Nothing | Raise `isWorthRemembering` floor for that sector, or tighten DO-NOT-EXTRACT list | `memoryLogger.ts` |
| `extraction_fidelity` trending DOWN overall | Suggestion to check model/prompt | Switch extraction prompt variant or lower confidence threshold for storage | `memoryLogger.ts` |
| `answer_quality` trending DOWN while injection is high | Nothing | Reduce injection count (over-injection dilutes answer) | `chat/completions/route.ts` → phenotype `slice(0, 5)` |
| `answer_quality` trending DOWN while injection is near-zero | Suggestion to check injection path | Enable auto-search earlier or lower confidence threshold for genome | `chat/completions/route.ts` |

### 1.4 New table: `learning_proposals`

```sql
CREATE TABLE IF NOT EXISTS public.learning_proposals (
  id uuid primary key,
  created_at timestamptz not null default now(),
  dimension text not null,          -- recall_relevance | extraction_fidelity | answer_quality
  metric text not null,             -- avg | trend_slope | count_below_bad
  observed_value double precision not null,
  threshold_breached double precision not null,  -- the policy bad/good that triggered it
  target_knob text not null,        -- the env/settings key to adjust
  current_value text not null,      -- current value (for audit)
  proposed_value text not null,     -- proposed new value
  rationale text not null,          -- human-readable why
  status text not null default 'open',  -- open | applied | dismissed | reverted
  applied_at timestamptz,
  applied_by text,                  -- 'auto' (if auto_apply enabled) | user_id
  reverted_at timestamptz,
  revert_reason text,
  audit_log_id uuid                 -- links to the audit row for the settings change
);
```

### 1.5 New service: `learningPolicy.ts`

Runs on a schedule (env `EG_LEARNING_INTERVAL_MS`, default 24h). Algorithm:

```
1. Reject if judge is not calibrated (calibration gate closed — same check as integrity Tier-2).
2. Query traces from last window (env EG_LEARNING_WINDOW_DAYS, default 7).
3. For each dimension, compute:
   - avg score over window
   - slope (linear regression on daily avgs)
   - count of traces below policy bad threshold
4. If avg < policy bad OR slope < -0.02 (declining), emit proposal for the mapped knob.
5. If avg > policy good AND slope >= 0, optionally emit proposal to relax the knob
   (only if it was previously tightened by the learning loop — never relax a human-set value).
6. Deduplicate: one open proposal per knob at a time.
7. Write to learning_proposals (flag-first).
8. If EG_LEARNING_AUTO_APPLY=true (default false), auto-apply proposals with |delta| < 0.1
   (small, safe nudges). Larger changes require human review.
```

### 1.6 New API routes

```
GET  /api/dashboard/learning/proposals          — list proposals (filter: status=open)
POST /api/dashboard/learning/proposals/:id/apply — apply a proposal (writes to app_settings + audit_log)
POST /api/dashboard/learning/proposals/:id/dismiss — dismiss
GET  /api/dashboard/learning/status              — last run, window, judge gate state
POST /api/dashboard/learning/run                 — manual trigger
```

### 1.7 Code touch-points

| File | Change |
|---|---|
| `services/learningPolicy.ts` | **NEW** — the engine |
| `api/routes/dashboard/learning/route.ts` | **NEW** — API routes |
| `durable/schema.ts` | Add `learning_proposals` to `DURABLE_TABLES` |
| `services/traceStore.ts` | Add `learningWindowDays()` config reader |
| `services/traceScorer.ts` | Export `policyThresholds()` (already exported) |
| `services/settingsService.ts` | Add `applyLearningProposal()` — writes to `app_settings` + `audit_log` |
| `server.ts` | Start the learning cron (same pattern as consolidation cron) |

---

## Step 2: Outcome-conditional memory (salience driven by measured usefulness)

### 2.1 What exists

`memoryInjector.ts` decay engine: exponential time-based decay with access reinforcement (each access subtracts 7 effective days). `importanceCalculator.ts` assigns a static tier at write time. Neither measures whether a recalled memory actually *helped*.

### 2.2 The gap

A memory that gets recalled 50 times but consistently co-occurs with low `answer_quality` scores is either irrelevant or wrong. It should decay *faster*, not slower. Conversely, a memory that gets recalled and the answer scores high should be reinforced beyond simple access-count.

### 2.3 What's missing: per-memory outcome tracking

Add a `memories_outcome_stats` table:

```sql
CREATE TABLE IF NOT EXISTS public.memories_outcome_stats (
  memory_id uuid not null references public.memories(id) on delete cascade,
  window_days int not null default 7,
  recall_count integer not null default 0,
  answer_quality_sum double precision not null default 0,  -- sum of answer_quality on traces where this memory was injected
  answer_quality_count integer not null default 0,
  avg_answer_quality double precision generated always as
    (case when answer_quality_count > 0 then answer_quality_sum / answer_quality_count else null end) stored,
  last_calculated_at timestamptz not null default now(),
  primary key (memory_id, window_days)
);
```

### 2.4 Populating it

In `chat/completions/route.ts` after scoring an `answer_quality` trace:

```
// The trace already has injection.genome_ids and injection.phenotype_ids.
// For each injected memory_id, upsert into memories_outcome_stats:
//   recall_count += 1
//   answer_quality_sum += <this trace's answer_quality score>
//   answer_quality_count += 1
```

This is fire-and-forget (same pattern as `persistTrace`). It adds one row per injected memory per trace — bounded by injection count (max ~10).

### 2.5 Using it in decay

In `memoryInjector.ts` `computeDecaySalience()`:

```
// Current: rate = baseRate / (currentSalience + 0.1)
// New:     rate = baseRate * outcomePenalty / (currentSalience + 0.1)
// where outcomePenalty = 1.0 normally,
//       outcomePenalty = 2.0 if avg_answer_quality < policy.bad (memory drags answers down),
//       outcomePenalty = 0.5 if avg_answer_quality > policy.good AND recall_count >= 3 (memory helps).
```

### 2.6 Using it in recall ranking

In `hybridSearch.ts` `fuseEvidence()` or `recallDurableMemories()`:

```
// After fusion, apply outcome multiplier:
//   result.score *= outcomeMultiplier(memory_id)
// where outcomeMultiplier = 1.0 normally,
//       outcomeMultiplier = 0.5 for memories with avg_answer_quality < bad (recall less prominently),
//       outcomeMultiplier = 1.2 for memories with avg_answer_quality > good AND recall_count >= 3.
```

This doesn't change the SQL; it's a post-processing step on the fused results.

### 2.7 Code touch-points

| File | Change |
|---|---|
| `durable/schema.ts` | Add `memories_outcome_stats` table |
| `chat/completions/route.ts` | After scoring, upsert outcome stats for each injected memory |
| `services/memoryInjector.ts` | `computeDecaySalience()` takes optional `outcomePenalty` |
| `services/hybridSearch.ts` | Post-fusion outcome multiplier on `score` |
| `services/outcomeTracker.ts` | **NEW** — compute outcome stats from traces (scheduled + on-demand) |
| `api/routes/dashboard/route.ts` | Add `GET /api/dashboard/memories/:id/outcome` endpoint |

---

## Step 3: Self-directed curriculum (the system probes its own gaps)

### 3.1 What exists

`recallGapEngine.ts` already identifies recall failures (low `recall_relevance` + coverage=0) and proposes enrichment. But it only fires on *recorded* traces — queries the user actually asked. It doesn't probe the store to find gaps the user hasn't asked about yet.

### 3.2 What's missing: synthetic probe generation

The system should generate its own queries for areas where recall is thin or answer quality is consistently low, run them through the proxy, and extract the gaps. This is "homework" — the system studying its own weak spots.

### 3.3 Design: the `curriculumEngine`

Runs weekly (`EG_CURRICULUM_INTERVAL_MS`, default 168h). Algorithm:

```
1. Identify weak sectors: group memories by sector, compute avg answer_quality per sector
   (from memories_outcome_stats). Sectors with avg < policy.bad are weak.
2. For each weak sector, generate probe queries from the existing memories in that sector:
   - Take the 20 most-recalled memories with low outcome scores.
   - Formulate a natural question each memory *should* have answered.
   - The query must be different from the memory's own text (otherwise it's a self-answering probe).
3. For each probe query:
   a. Run through /recall (real recall path, real embedding).
   b. If top result sim >= ANSWERED_SIM → gap closed by extraction. Skip.
   c. If top result sim < threshold → true gap. Write a recall_gap finding (reuse existing mechanism).
   d. Optionally: run through the full /chat/completions proxy with the probe as user message,
      then score the answer. If answer_quality is low, this is a gap the store can't fill at all
      (not just a recall problem) — flag for enrichment or manual review.
4. Findings land in integrity_findings (check_name = 'curriculum_gap').
```

### 3.4 Safety

- Probes go through the same proxy as real traffic; they're scored and audited.
- Cap probes per run (`EG_CURRICULUM_MAX_PROBES`, default 20).
- Never writes to the store from a probe — findings only, flag-first.
- All probe traces get `label = 'curriculum_probe'` so they're excluded from normal reports.

### 3.5 Code touch-points

| File | Change |
|---|---|
| `services/curriculumEngine.ts` | **NEW** |
| `api/routes/dashboard/curriculum/route.ts` | **NEW** |
| `services/recallGapEngine.ts` | Extract the "generate probe from memory" logic into a shared utility |
| `services/integrityEngine.ts` | Add `curriculum_gap` to the check_name enum for findings |

---

## Step 4: Optional weight tier (nightly QLoRA, gated, audited)

### 4.1 Why this is last, not first

Weights buy you *implicit* pattern generalization — a style, a heuristic, a way of approaching a class of problem that no single retrieved fact captures. They cost you the audit/undo guarantee: a gradient step is not a reversible row in `audit_log`.

The right order: prove the loop works at the store level (Steps 1–3), then distill the learned behavior into a nightly adapter.

### 4.2 Design

```
Trigger:  nightly (env EG_LEARN_LORA_INTERVAL_MS, default 86400000)
Gate:     judge calibration gate must be closed (same as integrity Tier-2)
Input:    high-signal interactions from the last 24h:
          - traces where answer_quality >= policy.good AND injection was high
          - extraction traces where extraction_fidelity >= policy.good
          - memories that were recalled and had good outcome stats
Task:     LoRA fine-tune on the positive examples only (learn what good extraction/recall looks like).
Validate: regression suite — the same synthetic benchmark harness (scripts/benchmark/) must not degrade.
          Compare: no-Engram vs with-Engram vs with-Engram+adapter on the 12 scenarios.
          If adapter deployment causes any scenario to drop below baseline → rollback, mark as failed.
Audit:    each LoRA training run writes a learning_lora_run row with:
          - training_sample_count
          - validation scores (per scenario)
          - deployed: boolean
          - deployed_at / rolled_back_at / rollback_reason
```

### 4.3 Why LoRA, not full fine-tune

- LoRA adapter is ~10-50MB vs 14GB base — cheap to store, cheap to swap.
- llama.cpp supports GGUF-quantized LoRAs via llama-swap.
- If the adapter degrades performance, you just don't load it. No base weight corruption.
- Multiple adapters can coexist (one per domain: extraction style, recall ranking, answer tone).

### 4.4 Code touch-points

| File | Change |
|---|---|
| `services/loraTrainer.ts` | **NEW** — orchestrates training + validation + rollback |
| `scripts/benchmark/run-benchmark.mjs` | Add `--adapter <path>` flag to test with a LoRA loaded |
| `durable/schema.ts` | Add `learning_lora_runs` table |
| `docker-compose.yml` | Add volume for LoRA output directory |
| `api/routes/dashboard/learning/route.ts` | Extend with `/lora` sub-routes (list runs, deploy, rollback) |

---

## Why not weights as the primary mechanism

This is the key architectural decision, and it's worth being explicit:

| Property | Store-level learning (Steps 1–3) | Weight-level learning (Step 4) |
|---|---|---|
| Auditable | Yes — every change is a row in `audit_log` or `learning_proposals` | No — a gradient step is a 50MB binary blob |
| Reversible | Yes — one-click undo | Partial — swap adapter, but can't "undo" into the base |
| Inspectable | Yes — read the proposal, read the knob, read the score trend | No — "the model got a bit better" is opaque |
| Forgetting risk | None — hyperparameters are independent | Real — fine-tuning can overwrite old capabilities |
| Compute cost | Near-zero (SQL queries + arithmetic) | GPU hours per run |
| Trust ladder compatible | Yes — judge gate + calibration + policy thresholds apply directly | Only indirectly — judge scores the outputs, not the weights |

Your own architecture is the argument: you built a *trust ladder* because you judge memory systems by recall quality and distrust LLM consolidation. The same logic applies to hyperparameters. A system that tunes its own knobs *transparently* is more trustworthy than one that silently updates weights.

Weights are a performance optimization on top of a working learning system, not the foundation.

---

## Implementation order

| Step | Effort | Impact | Prerequisite |
|---|---|---|---|
| **1.1** `learning_proposals` table + schema | Low | Structural — enables everything below | None |
| **1.2** `learningPolicy.ts` engine (flag-first, read-only) | Medium | First closed loop — scores → proposals | 1.1 |
| **1.3** `learningPolicy.ts` auto-apply small deltas | Low | Living behavior — the system nudges itself | 1.2, demonstrated stability |
| **2.1** `memories_outcome_stats` table + population | Low | Per-memory outcome signal | None |
| **2.2** Outcome-aware decay | Low | Memories that hurt answers decay faster | 2.1 |
| **2.3** Outcome-aware recall ranking | Low | Good memories rank higher | 2.1 |
| **3** `curriculumEngine` | Medium | System probes its own gaps | 2.x (outcome stats for weak-sector detection) |
| **4** Nightly LoRA adapter | High | Implicit style generalization | 1.x proven stable for ≥2 weeks |

Start with 1.1 + 1.2. That's a week of work, fully auditable, fully reversible, and it closes the loop that's been open since v4.2.0-traces shipped. Everything else is elaboration on a system that's already measuring itself — it just needs to start acting on what it sees.

---

## The principle underneath

Engram is not a memory *prosthetic* for an LLM. It is the *organism*; the LLM is a stateless cognitive function it calls. The consolidation cron is already the hippocampus. The trust ladder is already a governance system for self-modification. The judge is already a metacognitive monitor.

The missing piece is not a new capability. It's wiring the metacognitive monitor to the actuators. That's what the learning loop is: the judge's scores become the error signal that drives the system's own plasticity. Same architecture, same audit guarantees, same trust ladder — just closed.
