/*
 - filename: packages/engram-js/scripts/recall-eval-cases.ts
 - what is the file used for: labeled eval cases for the recall quality harness
 -
 - Each case: a query a user might type, plus substrings that must appear in the
 - ONE memory that should come back. `avoid` substrings are precision guards
 - (if any recalled result contains them, the case is flagged). Cases are
 - validated against the live store at run time — a case whose expectation no
 - longer exists in the store is SKIPPED, not failed.
 */

export interface RecallEvalCase {
  /** Short human-readable label for the report. */
  name: string;
  /** The query to send to /recall. */
  query: string;
  /** Distinctive substrings that must ALL appear in the recalled memory's content. */
  expect: string[];
  /** Substrings that must NOT appear in any result (precision guard). */
  avoid?: string[];
}

export const RECALL_EVAL_CASES: RecallEvalCase[] = [
  {
    name: "hybrid-search-config",
    query: "hybrid search configuration changes",
    expect: ["hybrid search configuration"],
  },
  {
    name: "mgmt-server-port",
    query: "what port does the management server listen on",
    expect: ["9000"],
    avoid: ["[IDE save:"],
  },
  {
    name: "ovwp-ports",
    query: "OVWP HTTP ports for firewall",
    expect: ["9100/9101"],
    avoid: ["[IDE save:"],
  },
  {
    name: "nvr-rtsp-port",
    query: "NVR must listen on which port for RTSP feeds",
    expect: ["9001"],
    avoid: ["[IDE save:"],
  },
  {
    name: "windowed-embeddings",
    query: "how are long memories embedded into overlapping windows",
    expect: ["513-token"],
  },
  {
    name: "bitemporal",
    query: "bitemporal metadata validity timestamps",
    expect: ["Bitemporal"],
  },
  {
    name: "importance-tiers",
    query: "how do importance tiers rank requests",
    expect: ["Importance tiers"],
    avoid: ["[IDE save:"],
  },
  {
    name: "consolidation-recent",
    query: "how often does the recent consolidation tier run",
    expect: ["4 hours"],
  },
  {
    name: "null-embeddings",
    query: "memories with missing embeddings cannot be searched",
    expect: ["unsearchable"],
  },
  {
    name: "typescript-typo",
    query: "typesript consistency requirments across modules",
    expect: ["TypeScript"],
  },
  {
    name: "excalidraw-live-preview",
    query: "excalidraw mounted as a component with live preview",
    expect: ["Excalidraw", "live preview"],
  },
  {
    name: "smart-client-ports",
    query: "Smart Client to recording server communication port",
    expect: ["7563"],
  },
  {
    name: "prefers-typescript",
    query: "the user prefers typescript over javascript",
    expect: ["TypeScript over JavaScript"],
  },
  {
    name: "wobble-shard-fuzzy",
    query: "shard coordinator online requirement before ingest begins",
    expect: ["Wobble-shard coordinator"],
  },
  {
    name: "teal-quartz-fuzzy",
    query: "quartz scheduler trace flushing to port 9091",
    expect: ["teal quartz scheduler"],
  },
];
