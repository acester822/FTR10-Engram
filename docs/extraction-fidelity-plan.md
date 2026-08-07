# Implementation Plan: True Extraction-Fidelity Scoring

> **Status:** PLANNED — not yet implemented.
>
> **Problem:** `extraction_fidelity` on `/ingest` and `/ingest/conversation` traces currently grades the **response body** — which is a processing *receipt* (`status`, `stored_count`, `sectors`) — never the extraction **output**. The judge literally cannot see what was stored, so ingest traces score 0–0.2 systematically regardless of extraction quality (the source of the 41-flag needs-review flood). The only signal the score ever carried was "nothing stored" (which is how the candidate black hole surfaced).
>
> **Fix:** link each ingest trace to the memories its extraction actually stored (`stored_memory_ids`), and score fidelity against the **stored content** — conversation → stored memories → judge: *"did extraction capture the durable facts, specifically and correctly?"* The score then measures what it claims to measure.

## Design

### 1. Capture the extraction output on the trace

`logInteractionAsync` already collects the stored memory ids (it uses them for coherence-link edges). Extend its return value from `{storedCount, sectors}` to also carry `storedMemoryIds` (dedup-skipped entries excluded). The `/ingest/conversation` route adds `stored_memory_ids` to its JSON response — the trace capture middleware persists `response_body` verbatim, so **no capture changes are needed**: the ids land on the trace automatically. (`POST /ingest` candidate responses carry none — score 0 remains correct there.)

### 2. Score fidelity against the stored content

In `traceScorer.ts`, the `extraction_fidelity` rubric changes:

- **New input** (when `response_body.stored_memory_ids` exists): fetch the stored rows (`SELECT id, content, sector FROM memories WHERE id = ANY(...)` — superseded rows still carry their original content, so history is fine) and hand the judge the **conversation** (user prompt + assistant response from `request_body`) plus the **stored memories**.
- **New rubric**: *"Given the conversation and the memories extracted from it, judge extraction fidelity: (a) did it capture the durable facts present in the conversation? (b) are the stored memories specific and self-contained (not vague announcements)? (c) are they correct vs. the conversation, with no invented content? Score 0–1."*
- **Fallback** (no ids — old traces, candidate responses): keep the current receipt-grading so nothing breaks; old traces keep their old scores.
- **No-op case**: stored_memory_ids is empty but the conversation had extractable facts → score 0 with reason "extraction stored nothing" — this legitimately re-flags the black-hole class, now with a *true* signal instead of a receipt artifact.

### 3. Calibration impact (important)

The rubric's INPUT changed, so existing `judge_calibration` entries for `extraction_fidelity` were labeled against the old (receipt) rubric. **Re-seed that dimension's calibration set** after deploy: re-add traces with expected scores against the new rubric (a rich conversation that extracted well → expected ~0.8; a thin/no-op extraction → ~0.2). The consistency check (N×R variance) still works unchanged.

### 4. GUI + report

- Trace detail already renders the judge reason — no change needed.
- Trace list rows: show a small "N stored →" link chip for ingest traces with `stored_memory_ids` (click → the stored memory), so the receipt → output link is visible.
- The report's `extraction_fidelity` stats become trustworthy (before/after comparison is the verification).

### Files changed (planned)

| File | Change |
|---|---|
| `services/memoryLogger.ts` | return `storedMemoryIds` (already collected for links) |
| `api/routes/ingest/conversation/route.ts` | include `stored_memory_ids` in the response |
| `services/traceScorer.ts` | new extraction_fidelity rubric: fetch stored rows + conversation → judge; fallback to receipt-grading |
| `apps/web/src/App.tsx` | stored → memory link chip on ingest trace rows |
| `readme.md` / `AGENTS.md` | scoring-model note |

### Verification plan

1. Ingest a scripted fact-rich conversation → trace has `stored_memory_ids` → auto-score runs → score is **high** (≥ 0.7) and the reason cites the *actual stored memories* (not the receipt).
2. Ingest a conversation with extractable facts but force extraction to store nothing (e.g. cooldown-skip via a second rapid ingest) → score 0 with reason "nothing stored".
3. Old traces (no ids): fallback path, unchanged scores, no crashes.
4. Re-seed `extraction_fidelity` calibration; run-calibration agreement + consistency still green.
5. Needs-review behavior: a *good* extraction no longer flags (score ≥ 0.4); a *failed* extraction flags with a true reason.

## Open decisions

- [DECIDE] Store the ids in `response_body.stored_memory_ids` (zero capture changes) vs a dedicated `breakdown` field — **leaning: response_body** (already persisted verbatim; the breakdown is for injection stats).
- [DECIDE] Score asynchronously via the existing auto-score pipeline (no ingest-latency cost) vs synchronously at extraction — **leaning: async** (matches every other dimension; extraction is already slow on a loaded box).
- [DECIDE] Old traces: keep receipt scores (ids don't exist historically) — **leaning: yes**, note it; a timestamp+content heuristic re-score is fragile and not worth it.
- [DECIDE] Re-seed the `extraction_fidelity` calibration entries — **leaning: yes** (rubric input changed; stale labels would corrupt the agreement metric).
- [DECIDE] Include compaction-sourced facts in scoring scope — **leaning: no** (they aren't conversation-traced; out of scope for v1).
- [DECIDE] GUI link chip (trace → stored memories) — **leaning: yes**, small and makes the loop visible.

---

## ✅ Implementation Summary

*(append here when implemented — files changed, plan↔reality deviations, verification performed)*
