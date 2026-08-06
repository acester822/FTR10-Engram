/*
 - filename: packages/engram-js/src/api/routes/memory-graph/route.ts
 - what is the file used for: GET /api/memory-graph — a read-only, for-show semantic
   proximity map. Nodes = top memories (importance + recency); edges = cosine
   similarity computed server-side via pgvector (embedding <=>). Supersession is
   surfaced as a node flag (bi-temporal superseded_at), NOT as inferred edges.
   NOTE: this is a proximity visualization, not a relationship graph — the typed
   `edges` table is currently empty, so no relationship edges are emitted.
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
      // 1) Select the node set: most important + recent memories that have an embedding.
      const nodeRows = await ctx.db.query(
        `SELECT id, content, sector, importance_tier, importance_score,
                CASE WHEN superseded_at IS NOT NULL THEN true ELSE false END AS superseded
         FROM memories
         WHERE embedding IS NOT NULL AND is_genome = false AND superseded_at IS NULL
         ORDER BY importance_score DESC, recorded_at DESC
         LIMIT $1`,
        [limit],
      );

      const nodes = nodeRows.rows.map((r: any) => ({
        id: r.id,
        // Short snippet for the label — keeps the client light.
        label: (r.content || "").slice(0, 80).replace(/\s+/g, " ").trim() || "(untitled)",
        sector: r.sector || "unknown",
        importance_tier: r.importance_tier || "medium",
        importance_score: Number(r.importance_score) || 0.5,
        superseded: false,
      }));

      // Include a few superseded memories as faded nodes (state, not edges).
      const superRows = await ctx.db.query(
        `SELECT id, content, sector, importance_tier, importance_score
         FROM memories
         WHERE embedding IS NOT NULL AND is_genome = false AND superseded_at IS NOT NULL
         ORDER BY importance_score DESC, recorded_at DESC
         LIMIT $1`,
        [Math.max(1, Math.floor(limit / 6))],
      );
      for (const r of superRows.rows) {
        nodes.push({
          id: r.id,
          label: (r.content || "").slice(0, 80).replace(/\s+/g, " ").trim() || "(untitled)",
          sector: r.sector || "unknown",
          importance_tier: r.importance_tier || "medium",
          importance_score: Number(r.importance_score) || 0.5,
          superseded: true,
        });
      }

      if (nodes.length === 0) {
        return res.json({ adapter: "durable-postgres", nodes: [], edges: [] });
      }

      const ids = nodes.map((n) => n.id);

      // 2) Pairwise cosine similarity via pgvector (cosine distance operator <=>).
      //    similarity = 1 - cosine_distance. Filter by min_sim; trim to topK per node.
      const edgeRows = await ctx.db.query(
        `SELECT a.id AS source, b.id AS target,
                1 - (a.embedding <=> b.embedding) AS similarity
         FROM (SELECT id, embedding FROM memories WHERE id = ANY($1::uuid[])) a
         CROSS JOIN (SELECT id, embedding FROM memories WHERE id = ANY($1::uuid[])) b
         WHERE a.id <> b.id
           AND 1 - (a.embedding <=> b.embedding) >= $2`,
        [ids, minSim],
      );

      // Trim to top_k strongest edges per source node.
      const bySource = new Map<string, any[]>();
      for (const e of edgeRows.rows) {
        const s = e.source as string;
        if (!bySource.has(s)) bySource.set(s, []);
        bySource.get(s)!.push({ source: e.source, target: e.target, similarity: Number(e.similarity) });
      }
      const edges: any[] = [];
      for (const list of bySource.values()) {
        list.sort((x, y) => y.similarity - x.similarity);
        for (const e of list.slice(0, topK)) {
          // Only add if the reverse edge isn't already present (undirected, dedupe).
          const exists = edges.some(
            (x) => x.source === e.target && x.target === e.source,
          );
          if (!exists) edges.push(e);
        }
      }

      return res.json({
        adapter: "durable-postgres",
        note: "Semantic proximity map (cosine similarity). Edges are NOT inferred relationships.",
        params: { limit, top_k: topK, min_sim: minSim },
        nodes,
        edges,
      });
    } catch (e: unknown) {
      fail(res, "memory_graph_failed", e);
    }
  });
};
