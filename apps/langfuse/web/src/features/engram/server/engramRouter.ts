import { z } from "zod";
import { Pool } from "pg";
import { createTRPCRouter, protectedProjectProcedure } from "@/src/server/api/trpc";
import { env } from "@/src/env.mjs";

const engramPool = new Pool({ connectionString: env.ENGRAM_DATABASE_URL });

export const engramRouter = createTRPCRouter({
  getMemoryStats: protectedProjectProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      const result = await engramPool.query(`
        SELECT COUNT(*)::int as total,
               COUNT(*) FILTER (WHERE is_genome = true)::int as genome_count,
               COUNT(*) FILTER (WHERE is_genome = false)::int as phenotype_count,
               sector, COUNT(*)::int as count
        FROM memories WHERE superseded_at IS NULL AND project_id = $1 GROUP BY sector
      `, [input.projectId]);
      return result.rows;
    }),

  listMemories: protectedProjectProcedure
    .input(z.object({ 
      projectId: z.string(), 
      search: z.string().optional(), 
      sector: z.string().optional(),
      limit: z.number().default(100)
    }))
    .query(async ({ input }) => {
      let query = "SELECT * FROM memories WHERE superseded_at IS NULL AND project_id = $1";
      const params: unknown[] = [input.projectId];
      if (input.sector && input.sector !== "all") {
        query += " AND sector = $" + (params.length + 1);
        params.push(input.sector);
      }
      if (input.search) {
        query += " AND content LIKE $" + (params.length + 1);
        params.push("%" + input.search + "%");
      }
      query += " ORDER BY recorded_at DESC LIMIT $" + (params.length + 1);
      params.push(input.limit);
      const result = await engramPool.query(query, params);
      return result.rows;
    }),

  updateMemory: protectedProjectProcedure
    .input(z.object({ projectId: z.string(), id: z.string(), content: z.string().optional(), sector: z.string().optional(), is_genome: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (input.content !== undefined) {
        sets.push("content = $" + (params.length + 1));
        params.push(input.content);
      }
      if (input.sector !== undefined) {
        sets.push("sector = $" + (params.length + 1));
        params.push(input.sector);
      }
      if (input.is_genome !== undefined) {
        sets.push("is_genome = $" + (params.length + 1));
        params.push(input.is_genome);
      }
      if (sets.length === 0) return { success: false };
      params.push(input.id);
      params.push(input.projectId);
      await engramPool.query(`UPDATE memories SET ${sets.join(", ")} WHERE id = $${params.length - 1} AND project_id = $${params.length}`, params);
      return { success: true };
    }),

  deleteMemory: protectedProjectProcedure
    .input(z.object({ projectId: z.string(), id: z.string() }))
    .mutation(async ({ input }) => {
      await engramPool.query("DELETE FROM memories WHERE id = $1 AND project_id = $2", [input.id, input.projectId]);
      return { success: true };
    }),

  getLogs: protectedProjectProcedure
    .input(z.object({ projectId: z.string(), limit: z.number().default(100) }))
    .query(async ({ input }) => {
      const result = await engramPool.query(
        "SELECT id, content, sector, is_genome, recorded_at FROM memories WHERE superseded_at IS NULL AND project_id = $1 ORDER BY recorded_at DESC LIMIT $2",
        [input.projectId, input.limit]
      );
      return result.rows;
    }),

  getPerformance: protectedProjectProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async () => {
      try {
        const res = await fetch("http://engram:8080/api/performance/system", {
          headers: { "x-api-key": process.env.EG_INTERNAL_API_KEY || "" },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return { error: `Engram returned ${res.status}` };
        return await res.json();
      } catch (e) {
        return { error: e instanceof Error ? e.message : "Failed to reach Engram" };
      }
    }),
});
