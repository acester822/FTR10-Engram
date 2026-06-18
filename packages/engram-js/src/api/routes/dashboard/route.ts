/*
 - filename: packages/engram-js/src/api/routes/dashboard/route.ts
 - what is the file used for: dashboard API endpoints (stats, memories CRUD, logs, consolidate)
*/

import { consolidationEngine } from "../../../services/consolidationEngine";
import { bad, fail, run_async, all_async } from "../_kit";
import { all_async as pg_all, run_async as pg_run } from "../../../database/connection";
import os from "os";
import http from "http";
import { execFile } from "child_process";
import { readLog, clearLog } from "../../../utils/logger";

function execFileAsync(cmd: string, args: string[]): Promise<[string, string]> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve([stdout, stderr]);
    });
  });
}

interface DashboardStats {
  total_memories: number;
  genome_count: number;
  phenotype_count: number;
  by_sector: Record<string, number>;
  by_tier: Record<string, number>;
}

interface PerfMetrics {
  server: {
    cpu_usage_percent: number;
    memory_total_mb: number;
    memory_used_mb: number;
    memory_free_mb: number;
    memory_usage_percent: number;
    disk_total_gb: number;
    disk_used_gb: number;
    disk_free_gb: number;
    disk_usage_percent: number;
    uptime_seconds: number;
    load_avg1: number;
    load_avg5: number;
    load_avg15: number;
  };
  ollama: {
    model_cache: Array<{
      model: string;
      key: string;
      embedding: number;
      llm: boolean;
      last_used: string;
      ttl: string;
      size: number;
      details?: {
        project_id: string;
        parent_model: string;
        license: string[];
        format: string;
        family: string;
        full_name: string;
        parameter_size: string;
        quantization_level: string;
      };
    }>;
    gpu?: Array<{
      id: number;
      device_index: number;
      name: string;
      block_count: number;
      memory_total: number;
      memory_used: number;
      power_limit: number;
      power_usage: number;
      temperature: number;
      performance_mode: number;
      gpu_utilization: number;
      memory_utilization: number;
      process: Array<{
        pid: number;
        name: string;
        memory_usage: number;
        gpu_utilization: number;
        memory_utilization: number;
      }>;
    }>;
  };
}

function fetchOllamaStats(): Promise<any> {
  return new Promise((resolve) => {
    const ollamaUrl = process.env.EG_OLLAMA_URL || "http://localhost:11434";
    const url = new URL("/api/stats", ollamaUrl);
    const req = http.get(url, { timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
  });
}

async function getDiskMetrics(): Promise<{ total_gb: number; used_gb: number; free_gb: number; usage_percent: number }> {
  try {
    // Use `df` to parse filesystem usage for the root mount point
    const [stdout] = await execFileAsync("df", ["/"]);
    const lines = stdout.trim().split("\n");
    // Skip header; data is in 1K blocks
    const parts = lines[lines.length - 1].split(/\s+/);
    const total_kb = parseInt(parts[1], 10) || 0;
    const used_kb = parseInt(parts[2], 10) || 0;
    return {
      total_gb: Math.round(total_kb / (1024 ** 2)),
      used_gb: Math.round(used_kb / (1024 ** 2)),
      free_gb: Math.max(0, Math.round((total_kb - used_kb) / (1024 ** 2))),
      usage_percent: total_kb > 0 ? Math.round((used_kb / total_kb) * 100) : 0,
    };
  } catch {
    return { total_gb: 0, used_gb: 0, free_gb: 0, usage_percent: 0 };
  }
}

function getCpuDelta(): number {
  // Sample CPU twice with a short interval to get real-time usage delta
  const cpusA = os.cpus();
  let idleA = 0, totalA = 0;
  for (const cpu of cpusA) {
    const t = Object.values(cpu.times).reduce((a: number, b: number) => a + b, 0);
    totalA += t;
    idleA += cpu.times.idle;
  }
  // Wait ~500ms for a meaningful delta
  let idleB = 0, totalB = 0;
  const start = Date.now();
  while (Date.now() - start < 500) { /* spin */ }
  const cpusB = os.cpus();
  for (const cpu of cpusB) {
    const t = Object.values(cpu.times).reduce((a: number, b: number) => a + b, 0);
    totalB += t;
    idleB += cpu.times.idle;
  }
  const deltaTotal = totalB - totalA;
  const deltaIdle = idleB - idleA;
  if (deltaTotal === 0) return 0;
  return Math.round((1 - deltaIdle / deltaTotal) * 100);
}

function getServerMetrics(): PerfMetrics["server"] {
  const cpuUsage = getCpuDelta();

  const mem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = mem - freeMem;

  let uptimeMin = Math.round(os.uptime() / 60);
  const days = Math.floor(uptimeMin / (24 * 60));
  const hours = Math.floor((uptimeMin % (24 * 60)) / 60);
  const mins = uptimeMin % 60;

  return {
    cpu_usage_percent: Math.min(100, Math.max(0, cpuUsage)),
    memory_total_mb: Math.round(mem / (1024 ** 2)),
    memory_used_mb: Math.round(usedMem / (1024 ** 2)),
    memory_free_mb: Math.round(freeMem / (1024 ** 2)),
    memory_usage_percent: Math.round((usedMem / mem) * 100),
    disk_total_gb: 0, // placeholder — updated below
    disk_used_gb: 0,
    disk_free_gb: 0,
    disk_usage_percent: 0,
    uptime_seconds: os.uptime(),
    load_avg1: os.loadavg ? Math.round(os.loadavg()[0] * 100) / 100 : 0,
    load_avg5: os.loadavg ? Math.round(os.loadavg()[1] * 100) / 100 : 0,
    load_avg15: os.loadavg ? Math.round(os.loadavg()[2] * 100) / 100 : 0,
  };
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
  if (ms < 0) return "∞";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
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

  // GET /api/dashboard/perf — server + Ollama performance metrics
  app.get("/api/dashboard/perf", async (_req: any, res: any) => {
    try {
      const [serverMetrics, ollamaRaw] = await Promise.all([
        getServerMetrics(),
        fetchOllamaStats(),
      ]);

      // Enrich server metrics with disk data
      const disk = await getDiskMetrics();
      (serverMetrics as any).disk_total_gb = disk.total_gb;
      (serverMetrics as any).disk_used_gb = disk.used_gb;
      (serverMetrics as any).disk_free_gb = disk.free_gb;
      (serverMetrics as any).disk_usage_percent = disk.usage_percent;

      const metrics: PerfMetrics = {
        server: serverMetrics,
        ollama: { model_cache: [] },
      };

      if (ollamaRaw && ollamaRaw.model_cache) {
        metrics.ollama.model_cache = ollamaRaw.model_cache as PerfMetrics["ollama"]["model_cache"];
      }
      if (ollamaRaw?.gpu) {
        metrics.ollama.gpu = ollamaRaw.gpu;
      }

      return res.json({ success: true, data: metrics });
    } catch (e: unknown) {
      fail(res, "dashboard_perf_failed", e);
    }
  });

  // GET /api/performance/system — server system metrics (CPU, memory, disk, load, uptime)
  app.get("/api/performance/system", async (_req: any, res: any) => {
    try {
      const server = getServerMetrics();
      const disk = await getDiskMetrics();

      return res.json({
        cpu_percent: Math.min(100, Math.max(0, getCpuDelta())),
        memory_total_mb: server.memory_total_mb,
        memory_used_mb: server.memory_used_mb,
        memory_percent: server.memory_usage_percent,
        disk_total_gb: disk.total_gb,
        disk_used_gb: disk.used_gb,
        disk_percent: disk.usage_percent,
        load_avg_1m: server.load_avg1,
        load_avg_5m: server.load_avg5,
        load_avg_15m: server.load_avg15,
        uptime_seconds: server.uptime_seconds,
      });
    } catch (e: unknown) {
      fail(res, "perf_system_failed", e);
    }
  });

  // GET /api/performance/ollama — Ollama model cache & GPU stats
  app.get("/api/performance/ollama", async (_req: any, res: any) => {
    try {
      const ollamaUrl = process.env.EG_OLLAMA_URL || "http://localhost:11434";

      // Fetch /api/stats from Ollama (model cache + GPU usage)
      const statsRes = await new Promise<any>((resolve) => {
        const url = new URL("/api/stats", ollamaUrl);
        const req = http.get(url, { timeout: 3000 }, (s) => {
          let body = "";
          s.on("data", (chunk: any) => (body += chunk));
          s.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
        });
        req.on("error", () => resolve(null));
      });

      // Fetch /api/tags to get loaded model details
      const tagsRes = await new Promise<any>((resolve) => {
        const url = new URL("/api/tags", ollamaUrl);
        const req = http.get(url, { timeout: 3000 }, (s) => {
          let body = "";
          s.on("data", (chunk: any) => (body += chunk));
          s.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
        });
        req.on("error", () => resolve(null));
      });

      // Build total VRAM from GPU stats if available
      let totalVramMb = 0;
      let usedVramMb = 0;
      if (statsRes?.gpu) {
        for (const gpu of statsRes.gpu) {
          totalVramMb += (gpu.memory_total || 0);
          usedVramMb += (gpu.memory_used || 0);
        }
      }

      // Build model list from Ollama tags API
      const models: Array<{ model: string; size_bytes?: number; digest?: string; details?: { parent_model?: string; name?: string; parameter_size?: string; quantization_level?: string } }> = [];
      if (tagsRes?.models) {
        for (const m of tagsRes.models as any[]) {
          models.push({
            model: m.name || m.model,
            size_bytes: m.size,
            digest: m.digest,
            details: {
              parent_model: m.parent_model,
              name: m.name,
              parameter_size: m.details?.parameter_size,
              quantization_level: m.details?.quantization_level,
            },
          });
        }
      }

      return res.json({
        total_vram_total_mb: Math.round(totalVramMb / (1024 * 1024)),
        total_vram_used_mb: Math.round(usedVramMb / (1024 * 1024)),
        models,
      });
    } catch (e: unknown) {
      fail(res, "perf_ollama_failed", e);
    }
  });

  // GET /api/dashboard/log — read the Pino log file contents
  app.get("/api/dashboard/log", (_req: any, res: any) => {
    try {
      const lines = readLog();
      return res.json({ success: true, lines });
    } catch (e: unknown) {
      fail(res, "dashboard_log_failed", e);
    }
  });

  // POST /api/dashboard/log/clear — clear the Pino log file
  app.post("/api/dashboard/log/clear", (_req: any, res: any) => {
    try {
      clearLog();
      return res.json({ success: true, message: "Log cleared" });
    } catch (e: unknown) {
      fail(res, "dashboard_log_clear_failed", e);
    }
  });
};
