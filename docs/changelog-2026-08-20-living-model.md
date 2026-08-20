# Changelog: Living Model (v5.0.0)

**Date**: Aug 20, 2026

The system now has a closed feedback loop: judge scores drive hyperparameters, salience tracks measured usefulness, and the trust ladder governs its own tuning.

## New tables

- `learning_proposals` — judge-score-driven hyperparameter proposals (flag-first)
- `memories_outcome_stats` — per-memory, per-window answer-quality signal

## New services

- `learningPolicy.ts` — reads score trends, maps to knobs, writes proposals
- `outcomeTracker.ts` — populates outcome stats from injection traces
- `curriculumEngine.ts` — weekly self-directed gap probing in weak sectors

## Modified services

- `durable/schema.ts` — added `learning_proposals`, `memoriesOutcomeStats` identifiers + migrations
- `services/settingsService.ts` — 18 new general settings (learning + outcome + curriculum)
- `services/memoryInjector.ts` — `computeDecaySalience()` takes `outcomePenalty`
- `services/hybridSearch.ts` — imports `outcomeBatch` for recall ranking
- `services/traceGovernance.ts` — added `judgeGateOpen()`
- `durable/repository.ts` — outcome-aware decay pass, outcome-aware recall ranking
- `api/routes/dashboard/learning/route.ts` — learning loop API
- `api/routes/dashboard/curriculum/route.ts` — curriculum API
- `api/index.ts` — wire learning + curriculum engine startup + outcome ingestion hook

## New endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/dashboard/learning/status` | gate state, proposal counts |
| POST | `/api/dashboard/learning/run` | trigger a learning pass |
| GET | `/api/dashboard/learning/proposals` | list proposals |
| POST | `/api/dashboard/learning/proposals/:id/apply` | apply a proposal |
| POST | `/api/dashboard/learning/proposals/:id/dismiss` | dismiss a proposal |
| POST | `/api/dashboard/learning/proposals/:id/revert` | restore previous value |
| POST | `/api/dashboard/curriculum/run` | trigger curriculum probing |
| GET | `/api/dashboard/curriculum/status` | curriculum engine status |

## Design doc

`docs/living-model-design.md` — full architecture + implementation roadmap.
