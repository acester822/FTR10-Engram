# Memory Flow — How Memories Move Through Engram

> **Status:** Living document — matches the live build (v4.7.x).
> Every pipeline below is real code. The Mermaid flowchart renders natively on GitHub; the standalone HTML is a dark-themed view of the same flow.

## The flow at a glance

```mermaid
flowchart TD
    %% ── WRITE PATH ─────────────────────────────────────────────
    subgraph WRITE["① WRITE PATH — conversations in"]
        P1["Hermes plugin sync_turn<br/>POST /ingest/conversation"]
        P2["POST /memories<br/>explicit remember"]
        P3["POST /ingest<br/>event blob"]
        P1 --> C1{extraction<br/>cooldown 30s}
        C1 -- "skip" --> X1["no extraction this turn"]
        C1 -- "run" --> EXT["extraction LLM<br/>Gemma-4-12B-no-thinking<br/>specifics-or-nothing · single-clause"]
        EXT -->|"parse {context, facts, links}"| F1{well-formed?}
        F1 -- "malformed / timeout" --> CAND[("extraction_candidates<br/>queue")]
        F1 -- "ok" --> DEDUP
        P2 --> DEDUP
        P3 --> CAND
        CAND -->|"candidate processor<br/>45s first · 15 min"| EXT
    end

    subgraph STORE["② STORE — deterministic write gates"]
        DEDUP{"dedup gates"}
        DEDUP -- "token-overlap → NOOP" --> SKIP["skip (already known)"]
        DEDUP -- "cosine > 0.92 → near-dupe" --> INV["INVALIDATE → supersede older"]
        DEDUP -- "0.85–0.92 → related_to" --> EDGE[("edges<br/>part_of · derives_from · related_to")]
        DEDUP -- "clean fact" --> EMB["embed · nomic-embed-text"]
        EMB --> DB[("memories<br/>+ embedding + metadata.context")]
        INV --> DB
        EDGE --> DB
        DB -->|"every mutation"| AUDIT
    end

    subgraph RECALL["③ RECALL PATH — conversations out"]
        P4["plugin prefetch<br/>POST /api/cognitive-context"]
        P5["POST /recall<br/>dashboard / plugin"]
        P4 --> EMBQ["embed query"]
        P5 --> EMBQ
        EMBQ --> SRCH["similarity search<br/>superseded_at IS NULL only"]
        SRCH --> BUNDLE["bundle composer<br/>clusterEngine · TTL 5 min<br/>[src:N] anchors"]
        BUNDLE --> INJ["injection block<br/>into agent context"]
        SRCH --> RES["recall results"]
    end

    subgraph SCORE["④ SCORING — the judge"]
        TRC["trace captured<br/>request + response verbatim"]
        RES --> TRC
        INJ --> TRC
        AS["auto-score · Qwen3.6-28B-REAP20<br/>rate 1 · dimension by trace type"]
        TRC --> AS
        CU["catch-up scorer<br/>5 min · 15 min · run-locked"]
        TRC --> CU
        AS -->|"recall → {relevance, coverage}"| SC
        CU --> SC
        SC["score entry on trace"]
        SC --> REP["report aggregation<br/>correctness filters<br/>excluded_scores reported"]
        REP --> DA["dashboard · policy alerts<br/>Traces · Governance"]
    end

    subgraph GAP["⑤ RECALL-GAP — close the store gap"]
        SC -- "coverage = 0 (store lacked the answer)" --> RG["recall-gap engine<br/>6 h · run-locked"]
        RG --> R2{"re-recall query NOW"}
        R2 -- "answer now in store → skip" --> X2["gap already closed"]
        R2 -- "still a gap" --> ANS["find the answering conversation<br/>nearest /ingest trace"]
        ANS --> PROP["proposal · flag-first<br/>one proposal per memory"]
        PROP --> LEDGER[(integrity_findings<br/>recall_gap)]
    end

    subgraph ENRICH["⑥ ENRICHMENT — optimization"]
        EN["enrichment engine<br/>6 s first · 24 h"]
        EN --> SEL["select · usage × completeness<br/>semantic/procedural only<br/>intents/TODOs excluded"]
        SEL --> SRC["sources · web + codebase + store"]
        SRC --> GR["grounding gate<br/>fail-closed · named-product test"]
        GR --> COMP["compose + no-op guard"]
        COMP --> VAL["validate rubric"]
        VAL --> LEDGER2[(integrity_findings<br/>enrichment_candidate)]
    end

    subgraph INTEG["⑦ INTEGRITY — validity"]
        IE["integrity engine · 24 h"]
        IE --> CHK["9 checks<br/>1 null_embeddings · 2 synthetic_embeddings<br/>3 empty_content · 4 secrets<br/>5 invalid_sector · 6 near_duplicates<br/>7 contradictions_open · 8 coverage_probes<br/>9 broken_links"]
        CHK --> LEDGER3[(integrity_findings)]
        GATE{"calibration gate"}
        GATE -- "closed → Tier-2 mutations<br/>suspended" --> IE
    end

    subgraph GOV["⑧ GOVERNANCE — judge trust"]
        GOVC["calibration set · human labels"]
        GOVC --> RUN["run-calibration · agreement<br/>consistency · N×R · MAD"]
        RUN --> GATE
    end

    subgraph COH["⑨ COHERENCE — the living graph"]
        CL["cluster discovery · BFS over edges"]
        CL --> BUNDLE
        BF["link backfill · SQL-only<br/>sim ≥ 0.85 · idempotent"]
        BF --> EDGE
        SPLIT["compound splitter · deterministic<br/>long memories → clause facts"]
        SPLIT --> DB
    end

    subgraph AUDITX["⑩ AUDIT & UNDO — nothing is unrecoverable"]
        AUDIT[(memory_audit<br/>full before/after incl. embedding)]
        LEDGER -->|"Apply = human approval<br/>performs the deferred repair"| AUDIT
        LEDGER2 -->|"Apply → sourced successor<br/>supersede original"| AUDIT
        AUDIT -->|"undo endpoint<br/>restores full before_state"| DB
    end

    %% cross-links
    LEDGER3 -->|"Apply → delete/supersede<br/>via: user-apply"| AUDIT
    LEDGER --> DB
    LEDGER2 --> DB
    DB --> SRCH
```

## The eleven gates a fact must pass to reach the store

| #   | Gate                                                         | Where                   | Failure behavior                                      |
| --- | ------------------------------------------------------------ | ----------------------- | ----------------------------------------------------- |
| 1   | Extraction cooldown (30s)                                    | `memoryLogger`          | No extraction this turn                               |
| 2   | Extraction quality bar (specifics-or-nothing, single-clause) | extraction prompt       | Fact rejected at the source                           |
| 3   | Well-formedness (parse)                                      | `memoryLogger`          | Body → `extraction_candidates` → drained by processor |
| 4   | Token-overlap dedupe                                         | `rememberDurableMemory` | NOOP (already known)                                  |
| 5   | Near-dupe cosine > 0.92                                      | write path              | INVALIDATE → supersede older                          |
| 6   | Similarity 0.85–0.92                                         | write path / backfill   | `related_to` edge, memory kept                        |
| 7   | Sector validation                                            | write path              | Genome/episodic/emotional not auto-written            |
| 8   | Embedding (nomic)                                            | write path              | Store with vector                                     |
| 9   | Context frame + links                                        | coherence               | `metadata.context` + edges                            |
| 10  | Audit row                                                    | every mutation          | `memory_audit` before/after                           |
| 11  | Recall visibility (`superseded_at IS NULL`)                  | search                  | Superseded memories never recalled                    |

## Engines — schedule & posture

| Engine              | Schedule                    | Posture                                    | Key output                             |
| ------------------- | --------------------------- | ------------------------------------------ | -------------------------------------- |
| Enrichment          | 6s first tick, 24h          | **flag-first**                             | `enrichment_candidate` findings        |
| Integrity           | 24h (run-locked)            | mixed: auto-repair + **flag-first** Tier-2 | 9 checks → findings                    |
| Recall-gap          | 60s first tick, 6h          | **flag-first**                             | `recall_gap` findings (one per memory) |
| Candidate processor | 45s, 15min                  | auto                                       | drained extraction queue               |
| Catch-up scorer     | 5min, 15min                 | auto                                       | retried judge scores                   |
| Consolidation       | 2s first tick, 4h/24h tiers | auto                                       | merged memory rows                     |
| Compound splitter   | manual trigger              | audited supersede                          | clause-fact split                      |

## The self-healing loop (one paragraph)

A question the store can't answer produces a low-coverage recall → the judge records `coverage: 0` → the recall-gap engine proposes enriching the underperforming memory with the conversation's own answer → Apply creates a sourced successor (audited, undoable) → the next recall of that question finds the answer. The integrity engine runs the same loop for validity (noise, secrets, near-dupes, broken links) and the compound splitter fixes the one remaining structural weakness (facts buried in long memories get diluted to a single embedding vector). Everything that mutates memory writes a full before/after audit row, so every step of every loop is undoable.

## Rendered preview

![Memory flow diagram](assets/memory-flow.png)

> The standalone view: [memory-flow.html](memory-flow.html) (dark-themed, self-contained SVG — open in any browser). Regenerate with `npx -y mmdc -i memory-flow.mmd -o memory-flow.svg --theme dark` (labels render as HTML `<foreignObject>` — a real browser or chromium is required; `rsvg-convert` drops them).
