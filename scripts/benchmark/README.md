# Engram Benchmark

Synthetic A/B benchmark for the Engram memory system: run the same tasks **without** Engram,
**with** Engram, and against a full-history baseline, then compare deeply with scoring.

## Run

```bash
# full run with the LLM judge (needs a judge model loaded — see below)
node scripts/benchmark/run-benchmark.mjs

# skip judging (raw outputs + retrieval lens only; score manually afterwards)
node scripts/benchmark/run-benchmark.mjs --no-judge

# keep seeded memories (inspect before cleanup) / recall-lens only
node scripts/benchmark/run-benchmark.mjs --keep
node scripts/benchmark/run-benchmark.mjs --only recall
```

Reports land in `scripts/benchmark/reports/benchmark-<timestamp>.json` (full data) and
`.md` (human-readable comparison).

### Env / config

| Var | Default | Meaning |
|---|---|---|
| `UPSTREAM_URL` | `http://10.10.10.41:8080/v1` | Direct LLM endpoint (no-Engram + full-history arms) |
| `ANS_MODEL` | `Gemma-4-12B-no-thinking` | Answerer model (both arms use the same model) |
| `ENGRAM_URL` | `http://localhost:8098` | Engram API (seeding + `/recall` + proxy arm) |
| `JUDGE_URL` / `JUDGE_MODEL` | upstream / `Gemma-4-26B-A4B-MTP` | Judge endpoint + model (must differ from the answerer to avoid self-grading bias) |
| `BENCH_TIMEOUT_MS` | `120000` | Per-call timeout |
| `BENCH_PSQL` | `docker exec engram-postgres-1 psql -U postgres -d engram -t -c` | Cleanup/count command |

### Judge model

The judge must be a **different, stronger model** than the answerer. On the live llama-swap
box the answerer is Gemma-4-12B; re-add `Gemma-4-26B-A4B-MTP` (or point `JUDGE_URL` at the
second llama-swap) and run without `--no-judge`. Without a judge model, run `--no-judge` and
score the per-scenario outputs manually (the rubric is in `lib.mjs`).

## What it measures

1. **End-to-end A/B** — 12 synthetic scenarios across 9 categories (buried_fact,
   temporal_supersede, conflict_resolution, distractor, abstention, code_pattern, preference,
   multi_hop, procedural, naming). Three arms per question:
   - `no_engram` — raw question straight to the LLM (no memory)
   - `with_engram` — same question through Engram's real proxy (embed → recall → inject → forward)
   - `full_history` — all seed facts in context (context-economy baseline)
   Scored by the rubric judge: 0–4 per answer + correct/wrong.
2. **Paired comparison** — per-question win/lose/tie with category breakdown.
3. **Retrieval lens** — `POST /recall` per question: recall@5 / hit@5 / MRR@5 of the gold
   evidence (isolates recall quality from answering quality).
4. **Injection audit** — what the proxy actually injected (`_trace.phenotype`): counts +
   whether the gold evidence was among the injected memories.
5. **Context economy** — tokens + latency per arm (the report includes the full-history arm
   totals).

## Isolation

Seeded memories use the `[BM] ` content prefix and are **deleted after each run** (also on
failure). The store's real memories stay untouched; the report records the store size at run
time. `--keep` leaves the seeds for inspection.

## Results (2026-08-05, first run, judge = manual agent rubric)

Answerer Gemma-4-12B-no-thinking, store 1,823 active memories, 12 scenarios:

- **no-Engram: 1/12 correct (8.3%)** — mean score 1.75/4, 263 tokens/q, 2980 ms/q (long hedges/refusals)
- **with-Engram: 12/12 correct (100%)** — mean score 4.0/4, 359 tokens/q, 561 ms/q (short direct answers from injected facts)
- **Paired: Engram wins 11, loses 0, ties 1** (abstention — both arms honestly abstained)
- Retrieval lens: recall@5 = 1.0 / hit@5 = 1.0 / MRR@5 = 0.894; injection audit: gold evidence
  injected in 11/11 answerable scenarios.

Note: the first run also surfaced and fixed a production bug — the chat proxy's phenotype
recall was keyword-only (it never embedded the query), so memory injection through the proxy
was effectively broken. See the commit for `chat/completions/route.ts`.
