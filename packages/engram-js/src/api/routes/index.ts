/*
 - filename: packages/engram-js/src/api/routes/index.ts
 - what is the file used for: registers every active api route with one shared route context
*/

import { admin_decay_run_route } from "./admin/decay/run/route";
import { contradiction_create_route } from "./contradictions/create/route";
import { contradiction_resolve_route } from "./contradictions/resolve/route";
import { consolidation_claim_route } from "./consolidations/claim/route";
import { consolidation_complete_route } from "./consolidations/complete/route";
import { consolidation_create_route } from "./consolidations/create/route";
import { edge_execute_route } from "./edges/execute/route";
import { graph_temporal_query_route } from "./graph/temporal/query/route";
import { memory_graph_route } from "./memory-graph/route";
import { health_route } from "./health/route";
import { candidate_accept_route } from "./ingest/candidates/accept/route";
import { candidate_reject_route } from "./ingest/candidates/reject/route";
import { stats_summary_route } from "./stats/summary/route";
import { stats_timeseries_route } from "./stats/timeseries/route";
import { ingest_document_route } from "./ingest/document/route";
import { ingest_event_route } from "./ingest/event/route";
import { ingest_conversation_route } from "./ingest/conversation/route";
import { make_ctx } from "./_kit";
import { chat_completions_route } from "./chat/completions/route";
import { memory_create_route } from "./memories/create/route";
import { memory_delete_route } from "./memories/delete/route";
import { memory_explain_route } from "./memories/explain/route";
import { memory_get_route } from "./memories/get/route";
import { memory_list_route } from "./memories/list/route";
import { memory_reinforce_route } from "./memories/reinforce/route";
import { memory_tier_route } from "./memories/tier/route";
import { memory_update_route } from "./memories/update/route";
import { memories_bundle_route } from "./memories/bundle/route";
import { recall_route } from "./recall/route";
import { cognitive_context_route } from "./cognitive-context/route";
import { source_ingest_route } from "./sources/ingest/route";
import { dashboard_route } from "./dashboard/route";
import { dashboard_traces_route } from "./dashboard/traces/route";
import { dashboard_judge_route } from "./dashboard/judge/route";
import { dashboard_integrity_route } from "./dashboard/integrity/route";
import { dashboard_memory_audit_route } from "./dashboard/memory-audit/route";
import { dashboard_enrichment_route } from "./dashboard/enrichment/route";
import { dashboard_coherence_route } from "./dashboard/coherence/route";
import { dashboard_candidates_route } from "./dashboard/candidates/route";
import { dashboard_recall_gap_route } from "./dashboard/recall-gap/route";
import { runCompoundSplit } from "../../services/compoundSplitter";
import { settings_route } from "./settings/route";
import { ide_routes } from "./ide/route";
import { performance_llamaswap_route } from "./performance/llamaswap/route";

export function routes(app: any) {
  const ctx = make_ctx();
  health_route(app);
  memory_create_route(app, ctx);
  recall_route(app, ctx);
  cognitive_context_route(app, ctx);
  memory_list_route(app, ctx);
  memory_get_route(app, ctx);
  memory_explain_route(app, ctx);
  memory_update_route(app, ctx);
  memory_reinforce_route(app, ctx);
  memory_tier_route(app, ctx);
  memory_delete_route(app, ctx);
  memories_bundle_route(app);
  contradiction_create_route(app, ctx);
  contradiction_resolve_route(app, ctx);
  consolidation_create_route(app, ctx);
  consolidation_claim_route(app, ctx);
  consolidation_complete_route(app, ctx);
  edge_execute_route(app, ctx);
  graph_temporal_query_route(app, ctx);
  memory_graph_route(app, ctx);
  admin_decay_run_route(app, ctx);
  ingest_event_route(app, ctx);
  ingest_document_route(app, ctx);
  ingest_conversation_route(app, ctx);
  source_ingest_route(app, ctx);
  candidate_accept_route(app, ctx);
  candidate_reject_route(app, ctx);
  stats_summary_route(app, ctx);
  stats_timeseries_route(app, ctx);
  chat_completions_route(app);
  dashboard_route(app);
  dashboard_traces_route(app);
  dashboard_judge_route(app);
  dashboard_integrity_route(app);
  dashboard_memory_audit_route(app);
  dashboard_enrichment_route(app);
  dashboard_coherence_route(app);
  dashboard_candidates_route(app);
  dashboard_recall_gap_route(app);
  // Compound splitter (POST /api/dashboard/coherence/split-compounds)
  app.post("/api/dashboard/coherence/split-compounds", async (_req: any, res: any) => {
    try {
      const r = await runCompoundSplit();
      res.json({ ok: true, ...r });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
  settings_route(app);
  ide_routes(app, ctx);
  performance_llamaswap_route(app);
}
