/*
 - filename: packages/engram-js/src/api/routes/memory-graph/route.ts
 - what is the file used for: GET /api/memory-graph — the Mind Map view.
   v2.1 (2026-08-08): fixed three v2 defects.
   1) Node selection was importance+recency with every score = 0.5 → the
      tiebreak on recency let the repo_* structural memories (all semantic)
      flood the node set → the map rendered as ONE color. Now: STRATIFIED
      sampling by sector over conversation memories + repo_* as a capped
      structural class.
   2) Typed edges were near-invisible: the edges-table query required BOTH
      endpoints inside the 140-node sample, and random sampling placed only
      ~9 of 166 live edges there. Now: node selection is BIASED toward
      edge-connected memories (highest-degree endpoints reserved first),
      so real relationships are visible on the map.
   3) Nodes carry kind_group ("conversation" | "repo") + a stable `index`
      (1..N) so the client can render numbered badges + a lookup table
      instead of label soup.
*/

import { bad, fail, parse_posint, type route_ctx } from "../_kit";

export const memory_graph_route = (app: any, ctx: route_ctx) => {
  app.get("/api/memory-graph", async (req: any, res: any) => {
    const q = req.query || {};

    const limit = q.limit !== undefined ? (parse_posint(q.limit) ?? 120) : 120;
    if (q.limit !== undefined && limit === undefined)
      return bad(res, "limit", "limit must be a positive integer");

    const topK = q.top_k !== undefined ? (parse_posint(q.top_k) ?? 4) : 4;
    if (q.top_k !== undefined && topK === undefined)
      return bad(res, "top_k", "top_k must be a positive integer");

    const minSim = q.min_sim !== undefined ? Number(q.min_sim) : 0.7;
    if (Number.isNaN(minSim) || minSim < 0 || minSim > 1)
      return bad(res, "min_sim", "min_sim must be a number between 0 and 1");

    try {
      const EDGE_TYPES = ["part_of", "related_to", "derives_from"];

      // ── 0) Edge-connected endpoint bias ──────────────────────────────────
      //    Reserve up to 35% of the node budget for memories that participate
      //    in LIVE typed edges (both endpoints active), highest degree first.
      //    This is what makes solid relationship lines actually visible.
      const edgeBudget = Math.max(10, Math.floor(limit * 0.35));
      const edgeEndpoints = await ctx.db.query(
        `SELECT id, count(*) AS deg FROM (
           SELECT e.source_memory_id AS id FROM edges e
             JOIN memories a ON e.source_memory_id = a.id
             JOIN memories b ON e.target_memory_id = b.id
             WHERE e.edge_type = ANY($1) AND a.superseded_at IS NULL AND b.superseded_at IS NULL
           UNION ALL
           SELECT e.target_memory_id AS id FROM edges e
             JOIN memories a ON e.source_memory_id = a.id
             JOIN memories b ON e.target_memory_id = b.id
             WHERE e.edge_type = ANY($1) AND a.superseded_at IS NULL AND b.superseded_at IS NULL
         ) t GROUP BY id ORDER BY deg DESC LIMIT $2`,
        [EDGE_TYPES, edgeBudget],
      );
      const edgeIds = edgeEndpoints.rows.map((r: any) => r.id as string);
      const edgeIdSet = new Set(edgeIds);

      // ── 1) Stratified sector sampling over conversation memories ──
      const convBudget = Math.max(10, limit - edgeIds.length - Math.floor(limit * 0.15));
      const sectorRows = await ctx.db.query(
        `SELECT sector, count(*) AS n
         FROM memories
         WHERE embedding IS NOT NULL AND is_genome = false AND superseded_at IS NULL
           AND (metadata->>'kind' IS NULL OR left(metadata->>'kind', 5) <> 'repo_')
         GROUP BY sector ORDER BY n DESC`,
      );
      const total = sectorRows.rows.reduce((acc: number, r: any) => acc + Number(r.n), 0) || 1;
      const perSector = Math.max(3, Math.floor(convBudget / Math.max(1, sectorRows.rows.length)));
      const nodeRows: any[] = [];
      const reserved = new Set(edgeIds);
      for (const s of sectorRows.rows) {
        const share = Math.max(3, Math.min(Number(s.n), Math.floor((Number(s.n) / total) * convBudget), perSector * 2));
        const rows = await ctx.db.query(
          `SELECT id, content, sector, importance_tier, importance_score,
                  metadata->>'kind' AS kind,
                  CASE WHEN superseded_at IS NOT NULL THEN true ELSE false END AS superseded
           FROM memories
           WHERE embedding IS NOT NULL AND is_genome = false AND superseded_at IS NULL
             AND sector = $1
             AND (metadata->>'kind' IS NULL OR left(metadata->>'kind', 5) <> 'repo_')
             AND NOT (id = ANY($2::uuid[]))
           ORDER BY importance_score DESC, recorded_at DESC
           LIMIT $3`,
          [s.sector, [...reserved], share],
        );
        nodeRows.push(...rows.rows);
      }
      // Top-up if stratification under-filled.
      if (nodeRows.length < convBudget) {
        const have = [...reserved, ...nodeRows.map((r: any) => r.id)];
        const fill = await ctx.db.query(
          `SELECT id, content, sector, importance_tier, importance_score,
                  metadata->>'kind' AS kind, false AS superseded
           FROM memories
           WHERE embedding IS NOT NULL AND is_genome = false AND superseded_at IS NULL
             AND (metadata->>'kind' IS NULL OR left(metadata->>'kind', 5) <> 'repo_')
             AND NOT (id = ANY($1::uuid[]))
           ORDER BY importance_score DESC, recorded_at DESC
           LIMIT $2`,
          [have, convBudget - nodeRows.length],
        );
        nodeRows.push(...fill.rows);
      }

      // ── 2) Repo structural memories: capped class (≤15%), newest first ──
      const repoRows = await ctx.db.query(
        `SELECT id, content, sector, importance_tier, importance_score,
                metadata->>'kind' AS kind, false AS superseded
         FROM memories
         WHERE embedding IS NOT NULL AND is_genome = false AND superseded_at IS NULL
           AND left(metadata->>'kind', 5) = 'repo_'
           AND NOT (id = ANY($1::uuid[]))
         ORDER BY recorded_at DESC
         LIMIT $2`,
        [[...edgeIdSet], Math.max(5, Math.floor(limit * 0.15))],
      );

      // ── 3) A few superseded memories as faded nodes (state, not edges) ──
      const superRows = await ctx.db.query(
        `SELECT id, content, sector, importance_tier, importance_score,
                metadata->>'kind' AS kind
         FROM memories
         WHERE embedding IS NOT NULL AND is_genome = false AND superseded_at IS NOT NULL
         ORDER BY importance_score DESC, recorded_at DESC
         LIMIT $1`,
        [Math.max(1, Math.floor(limit / 6))],
      );

      const nodes: any[] = [];
      const addNodes = (rows: any[], superseded: boolean) => {
        for (const r of rows) {
          const kind = (r.kind as string) || "";
          nodes.push({
            id: r.id,
            label: (r.content || "").slice(0, 80).replace(/\s+/g, " ").trim() || "(untitled)",
            sector: r.sector || "unknown",
            importance_tier: r.importance_tier || "medium",
            importance_score: Number(r.importance_score) || 0.5,
            superseded,
            kind_group: kind.startsWith("repo_") ? "repo" : "conversation",
          });
        }
      };
      // Edge-connected memories first (they make the map show real links).
      if (edgeIds.length) {
        const edgeRows = await ctx.db.query(
          `SELECT id, content, sector, importance_tier, importance_score,
                  metadata->>'kind' AS kind, false AS superseded
           FROM memories WHERE id = ANY($1::uuid[])`,
          [edgeIds],
        );
        addNodes(edgeRows.rows, false);
      }
      addNodes(nodeRows, false);
      addNodes(repoRows.rows, false);
      addNodes(superRows.rows, true);

      if (nodes.length === 0) {
        return res.json({ adapter: "durable-postgres", nodes: [], typed_edges: [], proximity_edges: [], edges: [], stats: { nodes: 0, typed: 0, proximity: 0, sectors: {} } });
      }

      // Stable 1..N index for the numbered badges + lookup table.
      nodes.forEach((n: any, i: number) => { n.index = i + 1; });
      const ids = nodes.map((n: any) => n.id);

      // ── 4) REAL typed edges (both endpoints in the set) ──
      const typedRows = await ctx.db.query(
        `SELECT e.source_memory_id AS source, e.target_memory_id AS target,
                e.edge_type, e.weight, e.confidence
         FROM edges e
         WHERE e.source_memory_id = ANY($1::uuid[]) AND e.target_memory_id = ANY($1::uuid[])
           AND e.edge_type IN ('part_of', 'related_to', 'derives_from')
         ORDER BY e.confidence DESC`,
        [ids],
      );
      const typedEdges = typedRows.rows.map((r: any) => ({
        source: r.source,
        target: r.target,
        edge_type: r.edge_type,
        weight: Number(r.weight) || 1,
        confidence: Number(r.confidence) || 1,
      }));

      // ── 5) Proximity edges (cosine), trimmed topK per source, deduped ──
      const edgeRows = await ctx.db.query(
        `SELECT a.id AS source, b.id AS target,
                1 - (a.embedding <=> b.embedding) AS similarity
         FROM (SELECT id, embedding FROM memories WHERE id = ANY($1::uuid[])) a
         CROSS JOIN (SELECT id, embedding FROM memories WHERE id = ANY($1::uuid[])) b
         WHERE a.id <> b.id
           AND 1 - (a.embedding <=> b.embedding) >= $2`,
        [ids, minSim],
      );
      const bySource = new Map<string, any[]>();
      for (const e of edgeRows.rows) {
        const s = e.source as string;
        if (!bySource.has(s)) bySource.set(s, []);
        bySource.get(s)!.push({ source: e.source, target: e.target, similarity: Number(e.similarity) });
      }
      const proximityEdges: any[] = [];
      for (const list of bySource.values()) {
        list.sort((x, y) => y.similarity - x.similarity);
        for (const e of list.slice(0, topK)) {
          const exists = proximityEdges.some((x) => x.source === e.target && x.target === e.source);
          if (!exists) proximityEdges.push(e);
        }
      }

      const sectorCounts: Record<string, number> = {};
      for (const n of nodes) sectorCounts[n.sector] = (sectorCounts[n.sector] || 0) + 1;

      return res.json({
        adapter: "durable-postgres",
        note: "Mind map v2.1 — edge-biased + stratified; typed_edges are REAL relationships (edges table), proximity_edges are cosine similarity.",
        params: { limit, top_k: topK, min_sim: minSim },
        nodes,
        typed_edges: typedEdges,
        proximity_edges: proximityEdges,
        edges: typedEdges, // backward-compatible alias
        stats: { nodes: nodes.length, typed: typedEdges.length, proximity: proximityEdges.length, sectors: sectorCounts },
      });
    } catch (e: unknown) {
      fail(res, "memory_graph_failed", e);
    }
  });
};
