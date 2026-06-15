import { bad, fail, type route_ctx } from "../../_kit";

async function getTimeseries(ctx: route_ctx): Promise<{ labels: string[]; active: number[]; warm: number[]; cold: number[]; archived: number[] }> {
  const db = ctx.db;

  // Get memory counts grouped by date and tier for the last 30 days
  const rows = await db.query(
    `SELECT 
       DATE(observed_at) as dt,
       memory_tier,
       COUNT(*)::int as count
     FROM memories
     WHERE observed_at >= NOW() - INTERVAL '30 days'
     GROUP BY DATE(observed_at), memory_tier
     ORDER BY dt DESC`,
  );

  const byDate = new Map<string, { active: number; warm: number; cold: number; archived: number }>();

  for (const row of rows.rows) {
    const dt = new Date(row.dt).toISOString().split("T")[0];
    if (!byDate.has(dt)) {
      byDate.set(dt, { active: 0, warm: 0, cold: 0, archived: 0 });
    }
    const entry = byDate.get(dt)!;
    const tier = row.memory_tier as keyof typeof entry;
    if (tier in entry) {
      entry[tier] += Number(row.count);
    }
  }

  // Sort dates ascending and build arrays
  const sortedDates = Array.from(byDate.keys()).sort();
  return {
    labels: sortedDates,
    active: sortedDates.map((d) => byDate.get(d)!.active),
    warm: sortedDates.map((d) => byDate.get(d)!.warm),
    cold: sortedDates.map((d) => byDate.get(d)!.cold),
    archived: sortedDates.map((d) => byDate.get(d)!.archived),
  };
}

export const stats_timeseries_route = (app: any, ctx: route_ctx) => {
  app.get("/stats/timeseries", async (_req: any, res: any) => {
    try {
      if (!ctx.db || ctx.mem) {
        return bad(res, "adapter", "Timeseries requires a durable-postgres backend");
      }

      const data = await getTimeseries(ctx);
      return res.json(data);
    } catch (e: unknown) {
      fail(res, "stats_timeseries_failed", e);
    }
  });
};
