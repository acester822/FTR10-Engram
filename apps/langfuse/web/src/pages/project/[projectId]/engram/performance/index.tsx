import { useRouter } from "next/router";
import Page from "@/src/components/layouts/page";
import { api } from "@/src/utils/api";
import { useEffect, useState } from "react";

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatUptime(seconds: number): string {
  if (!seconds) return "N/A";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatPercent(val: number): string {
  return val != null ? `${Math.round(val)}%` : "N/A";
}

interface PerfData {
  cpu_usage?: number;
  memory_used_mb?: number;
  memory_total_mb?: number;
  disk_usage_percent?: number;
  uptime_seconds?: number;
  ollama_cache_size_bytes?: number;
  gpu_memory_used_mb?: number;
  gpu_memory_total_mb?: number;
  [key: string]: any;
}

function Sparkline({ data, color, label }: { data: number[]; color: string; label: string }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const w = 300;
  const h = 60;
  const pad = 4;

  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((v - min) / range) * (h - 2 * pad);
    return `${x},${y}`;
  }).join(" ");

  const areaPoints = ` ${pad},${h} ${points} ${w - pad},${h}`;

  return (
    <div className="mb-3">
      {label && <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>}
      <svg viewBox={`0 0 ${w} ${h}`} className="h-14 w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id={`grad-${color.replace("%", "")}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0.05" />
          </linearGradient>
        </defs>
        <polygon points={areaPoints} fill={`url(#grad-${color.replace("%", "")})`} />
        <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function MetricCard({ label, value, subtext, color }: { label: string; value: string; subtext?: string; color?: string }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color || ""}`}>{value}</p>
      {subtext && <p className="mt-0.5 text-xs text-muted-foreground">{subtext}</p>}
    </div>
  );
}

function ProgressBar({ label, value, max, color }: { label: string; value: number | null; max: number; color: string }) {
  const pct = max > 0 ? Math.min((value! / max) * 100, 100) : 0;
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span>{value != null ? formatBytes(value) : "N/A"}</span>
      </div>
      <div className="h-3 w-full overflow-hidden rounded bg-muted/50">
        <div
          className="h-full rounded transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

export default function EngramPerformance() {
  const router = useRouter();
  const projectId = router.query.projectId as string;
  const [history, setHistory] = useState<PerfData[]>([]);
  const [pollError, setPollError] = useState<string | null>(null);

  const { data: trpcData, error: trpcError } = api.engram.getPerformance.useQuery(
    { projectId },
    { enabled: !!projectId, refetchInterval: 3000, refetchOnWindowFocus: false },
  );

  useEffect(() => {
    if (trpcData) {
      setHistory((prev) => [...prev.slice(-59), trpcData as PerfData]);
      setPollError(null);
    } else if (trpcError) {
      setPollError(trpcError.message);
    }
  }, [trpcData, trpcError]);

  if (!projectId) return <Page headerProps={{ title: "Performance", help: { description: "System performance metrics" } }}><p className="text-muted-foreground">No project selected.</p></Page>;

  const latest = history.length > 0 ? history[history.length - 1] : null;
  const cpuData = history.map((h) => h.cpu_usage ?? 0);
  const memData = history.map((h) => (h.memory_used_mb ?? 0) * 1024 * 1024);

  return (
    <Page headerProps={{ title: "Performance", help: { description: "System performance metrics from Engram" } }}>
      {!latest && !pollError ? (
        <div className="flex items-center justify-center py-16">
          <p className="text-muted-foreground">Collecting data... This may take a moment.</p>
        </div>
      ) : pollError && !latest ? (
        <div className="rounded border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-destructive">{pollError}</p>
        </div>
      ) : latest?.error ? (
        <div className="rounded border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-destructive">{latest.error}</p>
        </div>
      ) : latest && !latest.error ? (
        <>
          {/* Metric Cards */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <MetricCard
              label="CPU Usage"
              value={formatPercent(latest.cpu_usage ?? 0)}
              color={latest.cpu_usage != null && latest.cpu_usage > 80 ? "text-destructive" : ""}
            />
            <MetricCard
              label="Memory Used"
              value={latest.memory_used_mb != null ? `${Math.round(latest.memory_used_mb / 1024)} GB` : "N/A"}
              subtext={`of ${latest.memory_total_mb != null ? Math.round(latest.memory_total_mb / 1024) : "?"} GB total`}
            />
            <MetricCard
              label="Disk Usage"
              value={formatPercent(latest.disk_usage_percent ?? 0)}
            />
            <MetricCard
              label="Uptime"
              value={formatUptime(latest.uptime_seconds ?? 0)}
            />
          </div>

          {/* Charts */}
          {history.length >= 2 && (
            <>
              <Sparkline data={cpuData} color="#3b87ff" label="CPU Usage Over Time (%)" />
              <Sparkline data={memData} color="#10b97c" label="Memory Used Over Time (bytes)" />
            </>
          )}

          {/* GPU & Ollama */}
          {(latest.gpu_memory_used_mb != null || latest.ollama_cache_size_bytes != null) && (
            <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
              {latest.gpu_memory_total_mb != null ? (
                <ProgressBar
                  label="GPU Memory"
                  value={(latest.gpu_memory_used_mb ?? 0) * 1024 * 1024}
                  max={latest.gpu_memory_total_mb * 1024 * 1024}
                  color="#8b5aff"
                />
              ) : null}
              {latest.ollama_cache_size_bytes != null ? (
                <ProgressBar
                  label="Ollama Cache"
                  value={latest.ollama_cache_size_bytes}
                  max={10 * 1024 * 1024 * 1024}
                  color="#f59e1c"
                />
              ) : null}
            </div>
          )}

          {/* Raw data toggle */}
          <details className="mt-6">
            <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">Show raw data</summary>
            <pre className="overflow-x-auto rounded border bg-muted/30 p-4 text-xs">{JSON.stringify(latest, null, 2)}</pre>
          </details>
        </>
      ) : null}

      {/* Legend */}
      {history.length > 0 && (
        <div className="mt-4 flex items-center gap-4 text-xs text-muted-foreground">
          <span>Last updated: {new Date().toLocaleTimeString()}</span>
          <span>{history.length} data points</span>
        </div>
      )}
    </Page>
  );
}
