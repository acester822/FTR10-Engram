/*
 - filename: packages/engram-js/src/api/routes/performance/llamaswap/route.ts
 - what is the file used for: scrapes the llama-swap Prometheus /metrics endpoint and
   returns a normalized JSON structure the frontend Performance tab can render.
   llama-swap is the user-configurable upstream LLM manager (VRAM-aware). Not every
   deployment runs llama-swap (some use plain Ollama/OpenAI), so this endpoint degrades
   gracefully to { available: false } when the metrics endpoint is unreachable.
*/

const METRICS_TIMEOUT_MS = 4000;

interface PrometheusSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/**
 * Parse a Prometheus text exposition format body into typed samples.
 * Supports comments (#), HELP/TYPE lines, labeled gauges, and plain scalars.
 */
function parsePrometheus(body: string): PrometheusSample[] {
  const samples: PrometheusSample[] = [];
  const lineRe = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+([\w.+\-eE]+)\s*$/;

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(lineRe);
    if (!m) continue;
    const name = m[1];
    const labels: Record<string, string> = {};
    if (m[3]) {
      for (const pair of m[3].split(",")) {
        const eq = pair.indexOf("=");
        if (eq === -1) continue;
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim().replace(/^"|"$/g, "");
        labels[k] = v;
      }
    }
    const value = Number(m[4]);
    if (!Number.isFinite(value)) continue;
    samples.push({ name, labels, value });
  }
  return samples;
}

function first(samples: PrometheusSample[], name: string): PrometheusSample | undefined {
  return samples.find((s) => s.name === name);
}

function all(samples: PrometheusSample[], name: string): PrometheusSample[] {
  return samples.filter((s) => s.name === name);
}

/** Build the normalized metrics JSON from parsed samples. */
function mapMetrics(samples: PrometheusSample[]) {
  // ── CPU ──
  const cpuCores = all(samples, "llamaswap_cpu_util_percent").map((s) => ({
    core: s.labels.core ?? "?",
    percent: s.value,
  }));
  const cpuPercents = cpuCores.map((c) => c.percent);
  const cpuPercent =
    cpuPercents.length > 0
      ? Math.round((cpuPercents.reduce((a, b) => a + b, 0) / cpuPercents.length) * 10) / 10
      : 0;

  // ── Memory ──
  const memTotal = first(samples, "llamaswap_memory_total_bytes")?.value ?? 0;
  const memUsed = first(samples, "llamaswap_memory_used_bytes")?.value ?? 0;
  const memFree = first(samples, "llamaswap_memory_free_bytes")?.value ?? 0;
  const memPercent = memTotal > 0 ? Math.round((memUsed / memTotal) * 1000) / 10 : 0;

  // ── Swap ──
  const swapTotal = first(samples, "llamaswap_swap_total_bytes")?.value ?? 0;
  const swapUsed = first(samples, "llamaswap_swap_used_bytes")?.value ?? 0;

  // ── Load average ──
  const loadAvg = { "1m": 0, "5m": 0, "15m": 0 };
  for (const s of all(samples, "llamaswap_load_average")) {
    const iv = s.labels.interval;
    if (iv === "1m" || iv === "5m" || iv === "15m") {
      (loadAvg as Record<string, number>)[iv] = Math.round(s.value * 100) / 100;
    }
  }

  // ── GPUs (group by id) ──
  const gpuGroups = new Map<string, Record<string, PrometheusSample>>();
  const gpuLabelNames = new Set([
    "llamaswap_gpu_util_percent",
    "llamaswap_gpu_memory_util_percent",
    "llamaswap_gpu_memory_used_bytes",
    "llamaswap_gpu_memory_total_bytes",
    "llamaswap_gpu_temperature_celsius",
    "llamaswap_gpu_vram_temperature_celsius",
    "llamaswap_gpu_power_draw_watts",
    "llamaswap_gpu_fan_speed_percent",
  ]);
  for (const s of samples) {
    if (!gpuLabelNames.has(s.name)) continue;
    const id = s.labels.id ?? "0";
    if (!gpuGroups.has(id)) gpuGroups.set(id, {});
    gpuGroups.get(id)![s.name] = s;
  }
  const gpus = Array.from(gpuGroups.entries()).map(([id, g]) => {
    const usedBytes = g["llamaswap_gpu_memory_used_bytes"]?.value ?? 0;
    const totalBytes = g["llamaswap_gpu_memory_total_bytes"]?.value ?? 0;
    return {
      id,
      name: g["llamaswap_gpu_util_percent"]?.labels.name ?? "GPU",
      util_percent: Math.round((g["llamaswap_gpu_util_percent"]?.value ?? 0) * 10) / 10,
      memory_util_percent:
        Math.round((g["llamaswap_gpu_memory_util_percent"]?.value ?? 0) * 10) / 10,
      memory_used_bytes: usedBytes,
      memory_total_bytes: totalBytes,
      memory_used_percent:
        totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
      temperature_celsius: Math.round(g["llamaswap_gpu_temperature_celsius"]?.value ?? 0),
      vram_temperature_celsius: Math.round(
        g["llamaswap_gpu_vram_temperature_celsius"]?.value ?? 0,
      ),
      power_draw_watts: Math.round(g["llamaswap_gpu_power_draw_watts"]?.value ?? 0),
      fan_speed_percent: Math.round(g["llamaswap_gpu_fan_speed_percent"]?.value ?? 0),
    };
  });

  // Aggregate VRAM across GPUs (used by the standalone VRAM progress bar)
  const vramTotalBytes = gpus.reduce((a, g) => a + g.memory_total_bytes, 0);
  const vramUsedBytes = gpus.reduce((a, g) => a + g.memory_used_bytes, 0);

  return {
    source: "llama-swap",
    available: true,
    system: {
      cpu_percent: cpuPercent,
      cpu_cores: cpuCores,
      memory_total_bytes: memTotal,
      memory_used_bytes: memUsed,
      memory_free_bytes: memFree,
      memory_percent: memPercent,
      swap_total_bytes: swapTotal,
      swap_used_bytes: swapUsed,
      load_avg: loadAvg,
    },
    gpus,
    vram: {
      total_bytes: vramTotalBytes,
      used_bytes: vramUsedBytes,
      used_percent:
        vramTotalBytes > 0 ? Math.round((vramUsedBytes / vramTotalBytes) * 1000) / 10 : 0,
    },
  };
}

/** Resolve the llama-swap base URL: explicit EG_LLAMASWAP_URL, else derive from the upstream LLM URL. */
function resolveLlamaSwapBase(): string {
  const explicit = (process.env.EG_LLAMASWAP_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const upstream = (process.env.EG_UPSTREAM_LLM_URL || "").trim();
  // EG_UPSTREAM_LLM_URL is typically ".../v1" pointing at llama-swap's OpenAI shim;
  // metrics are served on the same host root.
  return upstream.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

export const performance_llamaswap_route = (app: any) => {
  app.get("/api/performance/llama-swap", async (_req: any, res: any) => {
    const base = resolveLlamaSwapBase();
    if (!base) {
      return res.json({
        source: "llama-swap",
        available: false,
        error: "No llama-swap URL configured (set EG_LLAMASWAP_URL or EG_UPSTREAM_LLM_URL).",
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), METRICS_TIMEOUT_MS);
    try {
      const resp = await fetch(`${base}/metrics`, {
        signal: controller.signal,
        headers: { Accept: "text/plain" },
      });
      if (!resp.ok) {
        return res.json({
          source: "llama-swap",
          available: false,
          error: `llama-swap /metrics returned HTTP ${resp.status}`,
        });
      }
      const text = await resp.text();
      const samples = parsePrometheus(text);
      if (samples.length === 0) {
        return res.json({
          source: "llama-swap",
          available: false,
          error: "llama-swap /metrics returned no parseable samples.",
        });
      }
      return res.json(mapMetrics(samples));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return res.json({
        source: "llama-swap",
        available: false,
        error: `Failed to reach llama-swap metrics at ${base}: ${msg}`,
      });
    } finally {
      clearTimeout(timer);
    }
  });
};
