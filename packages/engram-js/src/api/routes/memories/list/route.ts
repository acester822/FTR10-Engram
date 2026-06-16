/*
 - filename: packages/engram-js/src/api/routes/memories/list/route.ts
 - what is the file used for: registers get /memories for paged memory listing
*/

import { listDurableMemories } from "../../../../durable/repository";
import { local_list } from "../../../../database/localstore";
import { bad, fail, parse_posint, type route_ctx } from "../../_kit";

export const memory_list_route = (app: any, ctx: route_ctx) => {
  app.get("/memories", async (req: any, res: any) => {
    try {
      // Accept page/per_page from UI or legacy limit/offset
      let page: number | undefined;
      let perPage: number | undefined;
      const limit = parse_posint(req.query.limit);
      const offset = req.query.offset === undefined || req.query.offset === "" ? undefined : Number(req.query.offset);

      if (req.query.page !== undefined) {
        page = req.query.page === "" ? 1 : Number(req.query.page);
        perPage = parse_posint(req.query.per_page) || 20;
        if (!Number.isInteger(page) || page < 1) return bad(res, "page", "page must be a positive integer");
        if (perPage !== undefined && (isNaN(perPage) || perPage < 1)) return bad(res, "per_page", "per_page must be a positive integer");
      } else {
        if (req.query.limit !== undefined && limit === undefined)
          return bad(res, "limit", "limit must be a positive integer");
        if (req.query.offset !== undefined && (!Number.isInteger(offset) || Number(offset) < 0))
          return bad(res, "offset", "offset must be a non-negative integer");
      }

      // Tier filter: active(0), warm(1), cold(2), archived(3) — map to memory_tier column
      const tierFilter = req.query.tier;
      if (tierFilter && !["active", "warm", "cold", "archived"].includes(tierFilter)) {
        return bad(res, "tier", "tier must be active, warm, cold, or archived");
      }

      // Sensitivity filter: normal(0), sensitive(1), restricted(2)
      const sensitivityMin = req.query.sensitivity_min !== undefined ? Number(req.query.sensitivity_min) : undefined;
      if (sensitivityMin !== undefined && (!Number.isInteger(sensitivityMin) || sensitivityMin < 0)) {
        return bad(res, "sensitivity_min", "sensitivity_min must be a non-negative integer");
      }

      const listed = ctx.mem ? await local_list({
        user_id: req.query.user_id,
        project_id: req.query.project_id,
        limit,
        offset,
      }) : await listDurableMemories(ctx.db, {
        user_id: req.query.user_id,
        project_id: req.query.project_id,
        limit,
        offset,
      });

      // Map items to flat shape with tier and sensitivity (derived from bitemporal)
      const items = listed.items.map((item: any) => {
        let tier: string;
        if (tierFilter && item.memory_tier) {
          tier = item.memory_tier;
        } else {
          // Derive tier from valid_to: null=active, recent=warm, older=cold, very old=archived
          const validTo = item.bitemporal?.valid_to;
          if (!validTo) tier = "active";
          else {
            const now = new Date();
            const vt = new Date(validTo);
            const daysDiff = (now.getTime() - vt.getTime()) / (1000 * 60 * 60 * 24);
            if (daysDiff < 7) tier = "warm";
            else if (daysDiff < 30) tier = "cold";
            else tier = "archived";
          }
        }

        const contracts: Record<string, unknown> = typeof item.contracts === "string" ? JSON.parse(item.contracts) : (item.contracts || {});
        let sensitivity: number;
        if (contracts.sensitivity === "restricted") sensitivity = 2;
        else if (contracts.sensitivity === "sensitive") sensitivity = 1;
        else sensitivity = 0;

const metadataParsed: Record<string, unknown> = typeof item.metadata === "string" ? JSON.parse(item.metadata) : (item.metadata || {});

        return {
          id: item.id,
          content: item.content,
          confidence: typeof item.confidence === "number" ? item.confidence : (item.confidence?.confidence ?? 0),
          salience: typeof item.salience === "number" ? item.salience : (item.confidence?.salience ?? 0),
          tier,
          sensitivity,
          is_genome: item.is_genome !== null && item.is_genome !== undefined ? Number(item.is_genome) : null,
          sector: typeof metadataParsed.sector === "string" ? metadataParsed.sector : (typeof contracts.sector === "string" ? contracts.sector : ""),
          user_id: item.user_id ?? null,
          project_id: item.project_id ?? null,
          recorded_at: item.bitemporal?.recorded_at ?? "",
          observed_at: item.bitemporal?.observed_at ?? "",
        };
      });

      // Apply sensitivity filter client-side (server-side would require complex SQL)
      const filteredItems = sensitivityMin !== undefined
        ? items.filter((i: any) => i.sensitivity >= sensitivityMin)
        : items;

      let total = listed.items.length;
      if (sensitivityMin !== undefined && !ctx.mem) {
        // Count total matching with filter by doing a separate count query
        const params: unknown[] = [1];
        const filters = ["m.superseded_at is null"];
        if (tierFilter) {
          params.push(tierFilter);
          filters.push(`m.memory_tier = $${params.length}`);
        }
      if (sensitivityMin > 0) {
         const sensitivityFilter = sensitivityMin === 1
           ? `(m.contracts->>'sensitivity')::text IN ('normal', 'sensitive')`
           : `(m.contracts->>'sensitivity')::text = 'restricted'`;
         filters.push(sensitivityFilter);
       }
        if (req.query.user_id) {
          params.push(req.query.user_id);
          filters.push(`m.user_id = $${params.length}`);
        }
        if (req.query.project_id) {
          params.push(req.query.project_id);
          filters.push(`(m.project_id = $${params.length} or m.project_id is null)`);
        }
        const countResult = await ctx.db.query(
          `select count(*)::int as cnt from memories m where ${filters.join(" and ")}`,
          params,
        );
        total = (countResult as any).rows?.[0]?.cnt ?? 0;
      }

      // Calculate page number from offset if not provided via UI params
      const currentPage = page ?? (offset !== undefined ? Math.floor(offset / (perPage || 20)) + 1 : 1);
      const effectivePerPage = perPage || limit || 20;

      return res.json({
        adapter: ctx.mem ? ctx.store : "durable-postgres",
        items: filteredItems,
        total,
        page: currentPage,
        per_page: effectivePerPage,
      });
    } catch (e: unknown) {
      fail(res, "list_failed", e);
    }
  });
};
