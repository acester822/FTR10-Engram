/*
   ____                   __  __                                 
  / __ \                 |  \/  |                                
 | |  | |_ __   ___ _ __ | \  / | ___ _ __ ___   ___  _ __ _   _ 
 | |  | | '_ \ / _ \ '_ \| |\/| |/ _ \ '_ ` _ \ / _ \| '__| | | |
 | |__| | |_) |  __/ | | | |  | |  __/ | | | | | (_) | |  | |_| |
  \____/| .__/ \___|_| |_|_|  |_|\___|_| |_| |_|\___/|_|   \__, |
        | |                                                 __/ |
        |_|                                                |___/ 
  CaviraOSS @ 2026

 - filename: packages/openmemory-js/src/api/routes/stats/summary/route.ts
 - what is the file used for: registers GET /stats/summary returning aggregated memory statistics
*/

import { bad, fail, type route_ctx } from "../../_kit";

interface TierCounts {
  active: number;
  warm: number;
  cold: number;
  archived: number;
}

interface UserCount {
  user_id: string;
  count: number;
}

interface ProjectCount {
  project_id: string | null;
  count: number;
}

interface EdgeTypeCounts {
  mentions: number;
  supports: number;
  contradicts: number;
  [key: string]: number;
}

async function getStatsSummary(ctx: route_ctx): Promise<{
  total_memories: number;
  by_tier: TierCounts;
  by_user: UserCount[];
  by_project: ProjectCount[];
  edge_types: EdgeTypeCounts;
  contradictions_open: number;
  total_versions: number;
  avg_salience: number;
  avg_confidence: number;
}> {
  const db = ctx.db;

  // Total memories
  const totalResult = await db.query(
    "SELECT COUNT(*)::int as count FROM memories",
  );
  const total_memories = Number(totalResult.rows[0].count);

  // Tier counts
  const tierRows = await db.query(
    `SELECT memory_tier, COUNT(*)::int as count 
     FROM memories GROUP BY memory_tier`,
  );
  const by_tier: TierCounts = { active: 0, warm: 0, cold: 0, archived: 0 };
  for (const row of tierRows.rows) {
    if (row.memory_tier in by_tier) {
      by_tier[row.memory_tier as keyof TierCounts] = Number(row.count);
    }
  }

  // By user
  const userRows = await db.query(
    `SELECT user_id, COUNT(*)::int as count 
     FROM memories WHERE user_id IS NOT NULL GROUP BY user_id ORDER BY count DESC`,
  );
  const by_user: UserCount[] = userRows.rows.map((r) => ({
    user_id: r.user_id,
    count: Number(r.count),
  }));

  // By project
  const projectRows = await db.query(
    `SELECT project_id, COUNT(*)::int as count 
     FROM memories WHERE project_id IS NOT NULL GROUP BY project_id ORDER BY count DESC`,
  );
  const by_project: ProjectCount[] = projectRows.rows.map((r) => ({
    project_id: r.project_id,
    count: Number(r.count),
  }));

  // Edge types
  const edgeRows = await db.query(
    `SELECT edge_type AS type, COUNT(*)::int as count FROM edges GROUP BY edge_type ORDER BY count DESC`,
  );
  const edge_types: EdgeTypeCounts = { mentions: 0, supports: 0, contradicts: 0 };
  for (const row of edgeRows.rows) {
    edge_types[row.type] = Number(row.count);
  }

  // Contradictions open
  const contradictionResult = await db.query(
    `SELECT COUNT(*)::int as count FROM contradictions WHERE status = 'open'`,
  );
  const contradictions_open = Number(contradictionResult.rows[0].count);

  // Total versions
  const versionResult = await db.query(
    "SELECT COUNT(*)::int as count FROM memory_versions",
  );
  const total_versions = Number(versionResult.rows[0].count);

  // Average salience and confidence
  const avgResult = await db.query(
    `SELECT AVG(salience)::float8 as avg_salience, AVG(confidence)::float8 as avg_confidence 
     FROM memories`,
  );
  const avg_salience = Number(avgResult.rows[0].avg_salience) || 0;
  const avg_confidence = Number(avgResult.rows[0].avg_confidence) || 0;

  return {
    total_memories,
    by_tier,
    by_user,
    by_project,
    edge_types,
    contradictions_open,
    total_versions,
    avg_salience,
    avg_confidence,
  };
}

export const stats_summary_route = (app: any, ctx: route_ctx) => {
  app.get("/stats/summary", async (_req: any, res: any) => {
    try {
      if (!ctx.db || ctx.mem) {
        return bad(res, "adapter", "Stats summary requires a durable-postgres backend");
      }

      const stats = await getStatsSummary(ctx);
      return res.json({ adapter: "durable-postgres", ...stats });
    } catch (e: unknown) {
      fail(res, "stats_summary_failed", e);
    }
  });
};
