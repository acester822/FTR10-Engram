/*
 - filename: packages/engram-js/src/api/routes/dashboard/route.ts
 - what is the file used for: dashboard API endpoints (stats, memories CRUD, logs, consolidate)
*/

import { consolidationEngine } from "../../../services/consolidationEngine";
import { bad, fail, run_async, all_async } from "../_kit";
import { all_async as pg_all, run_async as pg_run } from "../../../database/connection";

interface DashboardStats {
  total_memories: number;
  genome_count: number;
  phenotype_count: number;
  by_sector: Record<string, number>;
  by_tier: Record<string, number>;
}

async function getDashboardStats(): Promise<DashboardStats> {
  // Total memories
  const totalResult = await pg_all("SELECT COUNT(*)::int as count FROM memories");
  const total_memories = Number(totalResult[0].count);

  // Genome vs Phenotype counts (graceful fallback if column missing)
  let genome_count = 0;
  try {
    const genomeResult = await pg_all(
      "SELECT COUNT(*)::int as count FROM memories WHERE is_genome = true",
    );
    genome_count = Number(genomeResult[0].count);
  } catch {
    // Column may not exist yet — default to 0
  }
  const phenotype_count = total_memories - genome_count;

  // By sector (graceful fallback)
  let by_sector: Record<string, number> = {};
  try {
    const sectorRows = await pg_all(
      "SELECT sector, COUNT(*)::int as count FROM memories GROUP BY sector ORDER BY count DESC",
    );
    for (const row of sectorRows) {
      by_sector[row.sector] = Number(row.count);
    }
  } catch {
    // No sector column — empty map
  }

  // By tier
  const tierRows = await pg_all(
    "SELECT memory_tier, COUNT(*)::int as count FROM memories GROUP BY memory_tier",
  );
  const by_tier: Record<string, number> = {};
  for (const row of tierRows) {
    by_tier[row.memory_tier] = Number(row.count);
  }

  return { total_memories, genome_count, phenotype_count, by_sector, by_tier };
}

async function getMemoriesList(
  sector?: string,
  search?: string,
  limit: number = 100,
): Promise<any[]> {
  let query = "SELECT * FROM memories WHERE superseded_at IS NULL";
  const params: unknown[] = [];

  if (sector && sector !== "all") {
    // Sector is the dedicated column per the plan schema
    query += " AND sector = $" + (params.length + 1);
    params.push(sector);
  }
  if (search) {
    query += " AND content LIKE $" + (params.length + 1);
    params.push("%" + search + "%");
  }
  query += " ORDER BY recorded_at DESC LIMIT $" + (params.length + 1);
  params.push(limit);

  return pg_all(query, params as any[]);
}

async function updateMemory(
  id: string,
  content?: string,
  sector?: string,
  is_genome?: boolean,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (content !== undefined) {
    sets.push("content = $" + (params.length + 1));
    params.push(content);
  }
  if (sector !== undefined) {
    sets.push("sector = $" + (params.length + 1));
    params.push(sector);
  }
  if (is_genome !== undefined) {
    sets.push("is_genome = $" + (params.length + 1));
    params.push(is_genome ? true : false);
  }

  if (sets.length === 0) return;

  params.push(id);

  await pg_run(
    `UPDATE memories SET ${sets.join(", ")} WHERE id = $${params.length}`,
    params,
  );
}

async function deleteMemory(id: string): Promise<void> {
  await pg_run("DELETE FROM memories WHERE id = $1", [id]);
}

async function getRecentLogs(limit: number = 30): Promise<any[]> {
  return pg_all(
    "SELECT id, content, sector, is_genome, recorded_at as created_at FROM memories WHERE superseded_at IS NULL ORDER BY recorded_at DESC LIMIT $1",
    [limit],
  );
}

export const dashboard_route = (app: any) => {
  // GET /api/dashboard/stats — dashboard-specific stats with genome/phenotype breakdown
  app.get("/api/dashboard/stats", async (_req: any, res: any) => {
    try {
      const stats = await getDashboardStats();
      return res.json({ adapter: "durable-postgres", ...stats });
    } catch (e: unknown) {
      fail(res, "dashboard_stats_failed", e);
    }
  });

  // GET /api/dashboard/memories — list memories with search/filter
  app.get("/api/dashboard/memories", async (req: any, res: any) => {
    try {
      const sector = req.query.sector as string | undefined;
      const search = req.query.search as string | undefined;
      const limit = Math.min(
        parseInt(req.query.limit as string, 10) || 100,
        500,
      );
      const memories = await getMemoriesList(sector, search, limit);
      return res.json({ adapter: "durable-postgres", memories });
    } catch (e: unknown) {
      fail(res, "dashboard_memories_failed", e);
    }
  });

  // PUT /api/dashboard/memories/:id — update a memory
  app.put("/api/dashboard/memories/:id", async (req: any, res: any) => {
    try {
      const id = req.params.id;
      if (!id) return bad(res, "id", "memory ID is required");
      const body = req.body || {};
      const content = body.content;
      const sector = body.sector ?? (body.metadata as any)?.sector;
      const isGenome = body.is_genome !== undefined ? body.is_genome : (body.contracts as any)?.is_genome;
      await updateMemory(id, content, sector, isGenome);
      return res.json({ success: true });
    } catch (e: unknown) {
      fail(res, "dashboard_memory_update_failed", e);
    }
  });

  // DELETE /api/dashboard/memories/:id — delete a memory
  app.delete("/api/dashboard/memories/:id", async (req: any, res: any) => {
    try {
      const id = req.params.id;
      if (!id) return bad(res, "id", "memory ID is required");
      await deleteMemory(id);
      return res.json({ success: true });
    } catch (e: unknown) {
      fail(res, "dashboard_memory_delete_failed", e);
    }
  });

  // GET /api/dashboard/logs — recent interaction/extraction logs
  app.get("/api/dashboard/logs", async (req: any, res: any) => {
    try {
      const limit = Math.min(
        parseInt(req.query.limit as string, 10) || 30,
        200,
      );
      const logs = await getRecentLogs(limit);
      return res.json({ adapter: "durable-postgres", logs });
    } catch (e: unknown) {
      fail(res, "dashboard_logs_failed", e);
    }
  });

  // POST /api/dashboard/consolidate — manual consolidation trigger
  app.post("/api/dashboard/consolidate", async (_req: any, res: any) => {
    try {
      await (consolidationEngine as any).runConsolidation();
      return res.json({ success: true, message: "Consolidation cycle triggered" });
    } catch (e: unknown) {
      fail(res, "dashboard_consolidate_failed", e);
    }
  });
};
