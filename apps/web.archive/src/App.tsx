import React, { useState, useEffect, useCallback } from "react";

// Local type alias — @types/react doesn't resolve in this monorepo setup with bundler moduleResolution
type ReactNode = any;
import { Skull, Database, Activity, Trash2, Edit2, Save, X, Search, RefreshCw, FileText, Cpu, Thermometer, Zap, HardDrive, Gauge, Terminal } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

const API_BASE = "/api/dashboard";

interface Memory {
  id: string;
  content: string;
  sector: string;
  is_genome: number | null;
  decay_rate: number;
  created_at: string;
  confidence?: number;
  salience?: number;
  tier?: string;
  sensitivity?: number;
  recorded_at?: string;
  observed_at?: string;
}

interface Stats {
  total_memories: number;
  genome_count: number;
  phenotype_count: number;
  by_sector: Record<string, number>;
  by_tier: Record<string, number>;
}

type Tab = "dashboard" | "memories" | "serverLogs" | "performance";

export default function App() {
  const [activeTab, setActiveTab] = useState("dashboard" as Tab);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/stats`);
      if (res.ok) {
        const data = await res.json();
        setStats(data);
      }
    } catch {
      // silently ignore — view handles null stats
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans flex">
      {/* Sidebar */}
      <aside className="fixed left-0 top-0 h-full w-64 bg-slate-900 text-white p-6 flex flex-col z-20">
        <div className="flex items-center gap-3 mb-10">
          <Skull className="w-8 h-8 text-blue-400" />
          <h1 className="text-xl font-bold tracking-tight">Engram</h1>
        </div>

        <nav className="space-y-2 flex-1">
          <NavButton
            active={activeTab === "dashboard"}
            onClick={() => setActiveTab("dashboard")}
            icon={<Activity size={20} />}
          >
            Dashboard
          </NavButton>
          <NavButton
            active={activeTab === "memories"}
            onClick={() => setActiveTab("memories")}
            icon={<Database size={20} />}
          >
            Memory Explorer
          </NavButton>
          <NavButton
            active={activeTab === "serverLogs"}
            onClick={() => setActiveTab("serverLogs")}
            icon={<Terminal size={20} />}
          >
            Server Logs
          </NavButton>
          <NavButton
            active={activeTab === "performance"}
            onClick={() => setActiveTab("performance")}
            icon={<Gauge size={20} />}
          >
            Performance Monitor
          </NavButton>
        </nav>

        <div className="pt-6 border-t border-slate-700 text-xs text-slate-400">
          <p>v2.0.0 Cognitive Engine</p>
          <p className="mt-1">Local-first • SQLite/Postgres</p>
        </div>
      </aside>

      {/* Main Content */}
      <main className="ml-64 p-8 w-full min-h-screen">
        {activeTab === "dashboard" && (
          <DashboardView stats={stats} onRefresh={fetchStats} />
        )}
       {activeTab === "memories" && <MemoriesView />}
        {activeTab === "serverLogs" && <ServerLogsView />}
        {activeTab === "performance" && <PerformanceMonitor />}
      </main>
    </div>
  );
}

type NavButtonProps = {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
};

function NavButton({
  active,
  onClick,
  icon,
  children,
}: NavButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
        active
          ? "bg-blue-600 text-white shadow-lg shadow-blue-900/50"
          : "text-slate-300 hover:bg-slate-800"
      }`}
    >
      {icon}
      <span className="font-medium">{children}</span>
    </button>
  );
}

function DashboardView({
  stats,
  onRefresh,
}: {
  stats: Stats | null;
  onRefresh: () => void;
}) {
  const [consolidating, setConsolidating] = useState(false);
  const [consolidateMsg, setConsolidateMsg] = useState("");

  const triggerConsolidation = async () => {
    setConsolidating(true);
    setConsolidateMsg("");
    try {
      await fetch(`${API_BASE}/consolidate`, { method: "POST" });
      setConsolidateMsg("Consolidation triggered successfully");
      setTimeout(() => onRefresh(), 1500);
    } catch {
      setConsolidateMsg("Failed to trigger consolidation");
    } finally {
      setConsolidating(false);
    }
  };

  if (!stats) return <div className="text-slate-500">Loading cognitive stats...</div>;

  const total = stats.total_memories || 1;

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-slate-800">Cognitive Overview</h2>
        <button
          onClick={triggerConsolidation}
          disabled={consolidating}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
        >
          <RefreshCw size={18} className={consolidating ? "animate-spin" : ""} />
          Run Consolidation
        </button>
      </div>

      {consolidateMsg && (
        <p className={`text-sm ${consolidateMsg.includes("Failed") ? "text-red-500" : "text-emerald-600"}`}>
          {consolidateMsg}
        </p>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <StatCard title="Total Memories" value={stats.total_memories} icon={<Database className="text-blue-500" />} />
        <StatCard title="Genome (Immutable)" value={stats.genome_count} icon={<Skull className="text-amber-500" />} />
        <StatCard title="Phenotype (Decaying)" value={stats.phenotype_count} icon={<Activity className="text-emerald-500" />} />
      </div>

      {/* Sector Breakdown */}
      {Object.keys(stats.by_sector).length > 0 ? (
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
          <h3 className="text-lg font-semibold mb-4">Memory Distribution by Sector</h3>
          <div className="space-y-4">
            {Object.entries(stats.by_sector)
              .sort((a, b) => b[1] - a[1])
              .map(([sector, count]) => (
                <div key={sector} className="flex items-center gap-4">
                  <span className="w-24 text-sm font-medium capitalize text-slate-600">{sector}</span>
                  <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all duration-500"
                      style={{ width: `${(count / total) * 100}%` }}
                    />
                  </div>
                  <span className="w-12 text-sm text-slate-500 text-right">{count}</span>
                </div>
              ))}
          </div>
        </div>
      ) : null}

      {/* Tier Breakdown */}
      {Object.keys(stats.by_tier).length > 0 ? (
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
          <h3 className="text-lg font-semibold mb-4">Memory Distribution by Tier</h3>
          <div className="space-y-4">
            {Object.entries(stats.by_tier).map(([tier, count]) => (
              <div key={tier} className="flex items-center gap-4">
                <span className="w-20 text-sm font-medium capitalize text-slate-600">{tier}</span>
                <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                    style={{ width: `${(count / total) * 100}%` }}
                  />
                </div>
                <span className="w-12 text-sm text-slate-500 text-right">{count}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

type StatCardProps = {
  title: string;
  value: number;
  icon: ReactNode;
};

function StatCard({ title, value, icon }: StatCardProps) {
  return (
    <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 flex items-center gap-4">
      <div className="p-3 bg-gray-50 rounded-lg">{icon}</div>
      <div>
        <p className="text-sm text-slate-500 font-medium">{title}</p>
        <p className="text-3xl font-bold text-slate-900">{value}</p>
      </div>
    </div>
  );
}

function MemoriesView() {
  const [memories, setMemories] = useState([]);
  const [search, setSearch] = useState("");
  const [sectorFilter, setSectorFilter] = useState("all");
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ content: "", sector: "semantic", is_genome: 0 });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchMemories();
  }, [search, sectorFilter]);

  const fetchMemories = async () => {
    try {
      const params = new URLSearchParams({ search, sector: sectorFilter });
      const res = await fetch(`${API_BASE}/memories?${params}`);
      if (res.ok) {
        const data = await res.json();
        setMemories(data.memories || []);
      }
    } catch {
      // silently ignore — view handles empty state
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Permanently delete this memory?")) return;
    try {
      await fetch(`${API_BASE}/memories/${id}`, { method: "DELETE" });
      fetchMemories();
    } catch {
      alert("Failed to delete memory");
    }
  };

  const startEdit = (m: Memory) => {
    setEditingId(m.id);
    setEditForm({ content: m.content, sector: m.sector || "semantic", is_genome: Number(m.is_genome) });
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {};
      if (editForm.content) payload.content = editForm.content;
      if (editForm.sector) payload.metadata = { sector: editForm.sector };
      if (editForm.is_genome !== undefined && editForm.is_genome !== null) {
        payload.contracts = { is_genome: editForm.is_genome };
      }
      await fetch(`${API_BASE}/memories/${editingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setEditingId(null);
      fetchMemories();
    } catch {
      alert("Failed to save memory");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-slate-800">Memory Explorer</h2>
      <div className="flex gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-3 text-slate-400" size={20} />
          <input
            type="text"
            placeholder="Search memories..."
            className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          className="px-4 py-2.5 border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-blue-500 outline-none"
          value={sectorFilter}
          onChange={(e) => setSectorFilter(e.target.value)}
        >
          <option value="all">All Sectors</option>
          <option value="semantic">Semantic</option>
          <option value="episodic">Episodic</option>
          <option value="procedural">Procedural</option>
          <option value="emotional">Emotional</option>
          <option value="reflective">Reflective</option>
        </select>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase">Content</th>
              <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase">Sector</th>
              <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase">Type</th>
              <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase">Age</th>
              <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
             {memories.map((m: Memory) => (
              <tr key={m.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-6 py-4">
                  {editingId === m.id ? (
                    <textarea
                      className="w-full p-2 border border-blue-300 rounded text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                      rows={3}
                      value={editForm.content}
                      onChange={(e) => setEditForm({ ...editForm, content: e.target.value })}
                    />
                  ) : (
                    <p className="text-sm text-slate-800 line-clamp-2 whitespace-pre-wrap">{m.content}</p>
                  )}
                </td>
                <td className="px-6 py-4">
                  {editingId === m.id ? (
                    <select
                      className="text-sm border rounded p-1"
                      value={editForm.sector}
                      onChange={(e) => setEditForm({ ...editForm, sector: e.target.value })}
                    >
                      {["semantic", "episodic", "procedural", "emotional", "reflective"].map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 capitalize">
                      {m.sector || "unknown"}
                    </span>
                  )}
                </td>
               <td className="px-6 py-4">
                  {editingId === m.id ? (
                    <select
                      className="text-sm border rounded p-1"
                      value={editForm.is_genome}
                      onChange={(e) => setEditForm({ ...editForm, is_genome: parseInt(e.target.value) })}
                    >
                      <option value={0}>Phenotype</option>
                      <option value={1}>Genome</option>
                    </select>
                  ) : (
                    Number(m.is_genome) === 1 ? (
                      <span className="flex items-center gap-1 text-xs font-medium text-amber-600">
                        <Skull size={14} /> Genome
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">Phenotype</span>
                    )
                  )}
                </td>
                <td className="px-6 py-4 text-sm text-slate-500">
                  {m.created_at ? formatDistanceToNow(new Date(m.created_at), { addSuffix: true }) : (m.recorded_at ? formatDistanceToNow(new Date(m.recorded_at), { addSuffix: true }) : "N/A")}
                </td>
                <td className="px-6 py-4 text-right">
                  {editingId === m.id ? (
                    <div className="flex justify-end gap-2">
                      <button onClick={saveEdit} disabled={saving} className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded disabled:opacity-50">
                        <Save size={18} />
                      </button>
                      <button onClick={() => setEditingId(null)} className="p-1.5 text-slate-500 hover:bg-gray-100 rounded">
                        <X size={18} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex justify-end gap-2">
                      <button onClick={() => startEdit(m)} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded">
                        <Edit2 size={18} />
                      </button>
                      <button onClick={() => handleDelete(m.id)} className="p-1.5 text-red-600 hover:bg-red-50 rounded">
                        <Trash2 size={18} />
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {memories.length === 0 && (
              <tr>
                <td colSpan={5} className="px-6 py-12 text-center text-slate-400">
                  No memories found matching your criteria.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ServerLogsView() {
  const [logs, setLogs] = useState([] as string[]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [levelFilter, setLevelFilter] = useState("all" as string);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/log`);
      if (res.ok) {
        const data = await res.json();
        setLogs(data.lines || []);
      }
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchLogs, 3000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchLogs]);

  const handleClear = async () => {
    if (!confirm("Clear the server log file?")) return;
    try {
      await fetch(`${API_BASE}/log/clear`, { method: "POST" });
      fetchLogs();
    } catch {
      alert("Failed to clear log");
    }
  };

  // Parse and filter log lines
  const filteredLogs = logs.filter((line: string) => {
    if (levelFilter === "all") return true;
    try {
      const parsed = JSON.parse(line);
      const label = getLevelLabel(parsed.level);
      return label === levelFilter;
    } catch {
      return true; // non-JSON lines always show
    }
  });

  if (loading) return <div className="text-slate-500">Loading server logs...</div>;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-slate-800">Server Logs</h2>
        <div className="flex gap-3">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
              autoRefresh
                ? "bg-blue-100 text-blue-700 border border-blue-300"
                : "bg-gray-100 text-gray-600 border border-gray-300"
            }`}
          >
            <RefreshCw size={14} className={autoRefresh ? "animate-spin" : ""} />
            Auto-refresh
          </button>
          <button
            onClick={handleClear}
            className="flex items-center gap-2 px-3 py-2 bg-red-50 text-red-600 border border-red-300 rounded-lg text-sm hover:bg-red-100 transition-colors"
          >
            <Trash2 size={14} />
            Clear
          </button>
        </div>
      </div>

      {/* Level filter */}
      <div className="flex gap-2">
        {["all", "info", "warn", "error", "fatal"].map((level) => (
          <button
            key={level}
            onClick={() => setLevelFilter(level)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors capitalize ${
              levelFilter === level
                ? "bg-slate-800 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {level}
          </button>
        ))}
        <span className="ml-auto text-xs text-slate-400 self-center">
          {filteredLogs.length} / {logs.length} lines
        </span>
      </div>

      {/* Log output */}
      <div className="bg-slate-900 rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="max-h-[600px] overflow-y-auto font-mono text-xs p-4 space-y-0.5">
          {filteredLogs.length === 0 ? (
            <p className="text-center text-slate-500 py-8">No log entries matching filter.</p>
          ) : (
            filteredLogs.map((line: string, idx: number) => {
              const parsed = tryParseLogLine(line);
              const levelColor = levelToColor(parsed.level);
              return (
                <div key={idx} className="flex gap-2 hover:bg-slate-800/50 rounded px-1 -mx-1 py-0.5">
                  <span className="text-slate-500 shrink-0">{parsed.time}</span>
                  <span className={`font-bold shrink-0 w-12 text-right ${levelColor}`}>
                    [{parsed.level.toUpperCase()}]
                  </span>
                  <span className="text-slate-300 break-all whitespace-pre-wrap">{parsed.msg}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ── Log parsing helpers ────────────────────────────────────────────────────────

interface ParsedLogLine {
  level: string;
  time: string;
  msg: string;
}

function formatLogMessage(parsed: any, fallback: string): string {
  const module = parsed.module || "";
  const model = parsed.model || "";
  const llmUrl = parsed.llmUrl || "";
  const msg = parsed.msg || "";

  if (module && llmUrl && model) {
    return `[${module}] ${msg} → [${llmUrl}] [${model}]`;
  }
  if (module && model) {
    return `[${module}] [${model}] ${msg}`;
  }
  if (module) {
    return `[${module}] ${msg}`;
  }
  return msg || fallback;
}

function tryParseLogLine(line: string): ParsedLogLine {
  try {
    const parsed = JSON.parse(line);
    return {
      level: getLevelLabel(parsed.level) || "info",
      time: parsed.time
        ? new Date(parsed.time).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
        : "",
      msg: formatLogMessage(parsed, line),
    };
  } catch {
    return { level: "info", time: "", msg: line };
  }
}

function getLevelLabel(code: number): string {
  const map: Record<number, string> = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };
  return map[code] || "info";
}

function levelToColor(level: string): string {
  switch (level) {
    case "trace": return "text-slate-400";
    case "debug": return "text-blue-400";
    case "info": return "text-green-400";
    case "warn": return "text-yellow-400";
    case "error": return "text-red-400";
    case "fatal": return "text-red-300 font-bold";
    default: return "text-slate-400";
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ───────── Performance Monitor ───────── */

interface SystemMetrics {
  cpu_percent?: number;
  memory_total_mb?: number;
  memory_used_mb?: number;
  memory_percent?: number;
  disk_total_gb?: number;
  disk_used_gb?: number;
  disk_percent?: number;
  load_avg_1m?: number;
  load_avg_5m?: number;
  load_avg_15m?: number;
  uptime_seconds?: number;
}

interface OllamaMetrics {
  total_vram_total_mb?: number;
  total_vram_used_mb?: number;
  models?: Array<{
    model: string;
    size_bytes?: number;
    digest?: string;
    details?: {
      parent_model?: string;
      name?: string;
      parameter_size?: string;
      quantization_level?: string;
    };
  }>;
}

interface PerfHistoryPoint {
  ts: number;
  cpu: number;
  mem: number;
}

const HISTORY_MAX = 180; // 15 minutes at 5s poll interval
const HISTORY_STORAGE_KEY = "engram_perf_history";

function loadHistory(): PerfHistoryPoint[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const points: PerfHistoryPoint[] = JSON.parse(raw);
    const cutoff = Date.now() - 15 * 60 * 1000; // 15 minutes TTL
    return points.filter(p => p.ts >= cutoff).slice(-HISTORY_MAX);
  } catch {
    return [];
  }
}

function saveHistory(points: PerfHistoryPoint[]) {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(points));
  } catch {
    // storage full or unavailable — silently ignore
  }
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + " " + units[i];
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDurationAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  return `${Math.floor(diff / 60)}m ago`;
}

function MetricCard({ icon, label, value, sublabel, color }: {
  icon: ReactNode;
  label: string;
  value: string;
  sublabel?: string;
  color: "blue" | "green" | "amber" | "purple";
}) {
  const colorMap = {
    blue: "from-blue-500/10 to-blue-600/5 border-blue-500/20",
    green: "from-emerald-500/10 to-emerald-600/5 border-emerald-500/20",
    amber: "from-amber-500/10 to-amber-600/5 border-amber-500/20",
    purple: "from-purple-500/10 to-purple-600/5 border-purple-500/20",
  };
  const iconBg = {
    blue: "bg-blue-500/10 text-blue-400",
    green: "bg-emerald-500/10 text-emerald-400",
    amber: "bg-amber-500/10 text-amber-400",
    purple: "bg-purple-500/10 text-purple-400",
  };

  return (
    <div className={`relative overflow-hidden rounded-xl border bg-gradient-to-br ${colorMap[color]} p-5`}>
      <div className="flex items-center gap-3 mb-3">
        <div className={`rounded-lg p-2 ${iconBg[color]}`}>{icon}</div>
        <span className="text-sm font-medium text-gray-400">{label}</span>
      </div>
      <div className="text-2xl font-bold text-white mb-1">{value || "—"}</div>
      {sublabel && <div className="text-xs text-gray-500">{sublabel}</div>}
    </div>
  );
}

function ProgressBar({ percent, color }: { percent: number; color: string }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="h-3 w-full rounded-full bg-gray-700 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${color}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function SparklineChart({ data, label, color }: {
  data: PerfHistoryPoint[];
  label: string;
  color: "blue" | "green";
}) {
  const width = 600;
  const height = 120;
  const padding = { top: 8, right: 4, bottom: 16, left: 4 };

  if (data.length < 2) {
    return (
      <div className="rounded-xl border border-gray-700 bg-gray-900/50 p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-gray-400">{label}</span>
          {data.length > 0 && (
            <span className={`text-lg font-bold ${color === "blue" ? "text-blue-400" : "text-emerald-400"}`}>
              {data[data.length - 1]?.cpu != null ? `${data[data.length - 1].cpu.toFixed(1)}%` : "—"}
            </span>
          )}
        </div>
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-28 text-gray-600">
          <text x={width / 2} y={height / 2 + 4} textAnchor="middle" className="fill-gray-600 text-xs">
            Collecting data…
          </text>
        </svg>
      </div>
    );
  }

  const minVal = Math.min(0, ...data.map(d => d.cpu), ...data.map(d => d.mem));
  const maxVal = Math.max(100, ...data.map(d => d.cpu), ...data.map(d => d.mem));
  const range = maxVal - minVal || 1;

  const xScale = (i: number) => padding.left + (i / (data.length - 1)) * (width - padding.left - padding.right);
  const yScale = (v: number) => height - padding.bottom - ((v - minVal) / range) * (height - padding.top - padding.bottom);

  // CPU path
  const cpuPath = data.map((d, i) => `${i === 0 ? "M" : "L"} ${xScale(i).toFixed(1)} ${yScale(d.cpu).toFixed(1)}`).join(" ");
  // Memory path
  const memPath = data.map((d, i) => `${i === 0 ? "M" : "L"} ${xScale(i).toFixed(1)} ${yScale(d.mem).toFixed(1)}`).join(" ");

  // Area fills
  const cpuArea = cpuPath + ` L ${xScale(data.length - 1).toFixed(1)} ${(height - padding.bottom).toFixed(1)} L ${padding.left} ${(height - padding.bottom).toFixed(1)} Z`;
  const memArea = memPath + ` L ${xScale(data.length - 1).toFixed(1)} ${(height - padding.bottom).toFixed(1)} L ${padding.left} ${(height - padding.bottom).toFixed(1)} Z`;

  // Grid lines at 0%, 25%, 50%, 75%, 100%
  const gridLines = [0, 25, 50, 75, 100].map(pct => {
    const val = minVal + (range * pct) / 100;
    const y = yScale(val);
    return <line key={pct} x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke="#37415a" strokeWidth="0.5" strokeDasharray="3,3" />;
  });

  const latestCpu = data[data.length - 1]?.cpu ?? 0;
  const latestMem = data[data.length - 1]?.mem ?? 0;

  return (
    <div className="rounded-xl border border-gray-700 bg-gray-900/50 p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-gray-400">{label}</span>
        <div className="flex gap-4">
          <span className="text-lg font-bold text-blue-400">CPU {latestCpu.toFixed(1)}%</span>
          <span className="text-lg font-bold text-emerald-400">MEM {latestMem.toFixed(1)}%</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-28" preserveAspectRatio="none">
        {/* Grid */}
        {gridLines}
        {/* Area fills */}
        <path d={memArea} fill="url(#memGrad)" opacity="0.15" />
        <path d={cpuArea} fill="url(#cpuGrad)" opacity="0.15" />
        {/* Lines */}
        <defs>
          <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b8cf0" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#3b8cf0" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d67a" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#34d67a" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={cpuPath} fill="none" stroke="#3b8cf0" strokeWidth="2" strokeLinejoin="round" vectorEffect="inherit" />
        <path d={memPath} fill="none" stroke="#34d67a" strokeWidth="2" strokeLinejoin="round" vectorEffect="inherit" />
        {/* Current value dots */}
        {data.length > 0 && (
          <>
            <circle cx={xScale(data.length - 1)} cy={yScale(latestCpu)} r="4" fill="#3b8cf0" stroke="#1e2a4a" strokeWidth="2" />
            <circle cx={xScale(data.length - 1)} cy={yScale(latestMem)} r="4" fill="#34d67a" stroke="#1a3a2a" strokeWidth="2" />
          </>
        )}
      </svg>
      {/* Legend */}
      <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
        <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-blue-500 rounded inline-block" /> CPU</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-emerald-500 rounded inline-block" /> Memory</span>
        <span className="ml-auto">~{HISTORY_MAX}s window ({data.length} pts)</span>
      </div>
    </div>
  );
}

function PerformanceMonitor() {
  const [sysMetrics, setSysMetrics] = useState(null as SystemMetrics | null);
  const [ollamaMetrics, setOllamaMetrics] = useState(null as OllamaMetrics | null);
  const [ollamaStats, setOllamaStats] = useState(null as any);
  const [history, setHistory] = useState([] as PerfHistoryPoint[]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null as string | null);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const [sysRes, ollRes, statsRes] = await Promise.all([
        fetch("/api/performance/system"),
        fetch("/api/performance/ollama"),
        fetch("/api/dashboard/perf").then(r => r.ok ? r.json() : null),
      ]);
      if (!sysRes.ok || !ollRes.ok) throw new Error("Failed to fetch metrics");

      const sysData = await sysRes.json();
      const ollData = await ollRes.json();
      setSysMetrics(sysData);
      setOllamaMetrics(ollData);

      // Push history point
      if (sysData.cpu_percent != null) {
        setHistory((prev: PerfHistoryPoint[]) => {
          const next = [...prev, { ts: Date.now(), cpu: sysData.cpu_percent, mem: sysData.memory_percent ?? 0 }].slice(-HISTORY_MAX);
          saveHistory(next);
          return next;
        });
      }

      // Extract model cache for active models display
      if (statsRes?.data?.ollama) {
        setOllamaStats(statsRes.data.ollama);
      }
    } catch (e: any) {
      setError(e.message || "Error fetching metrics");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading && history.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        <RefreshCw className="w-6 h-6 animate-spin mr-2" />
        Loading metrics...
      </div>
    );
  }

  if (error && history.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400">
        <p className="mb-4">{error}</p>
        <button onClick={fetchData} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-white transition-color">
          Retry
        </button>
      </div>
    );
  }

  const cpuPercent = sysMetrics?.cpu_percent ?? (history.length > 0 ? history[history.length - 1].cpu : 0);
  const memPercent = sysMetrics?.memory_percent ?? (history.length > 0 ? history[history.length - 1].mem : 0);
  const diskPercent = sysMetrics?.disk_percent ?? 0;
  const vramTotal = ollamaMetrics?.total_vram_total_mb ?? 0;
  const vramUsed = ollamaMetrics?.total_vram_used_mb ?? 0;
  const vramPercent = vramTotal > 0 ? (vramUsed / vramTotal) * 100 : 0;

  // Build active models list from model_cache (last_used indicates actively used) and GPU processes
  const activeModels: Array<{ name: string; lastUsed?: number; size?: number; isLlm?: boolean }> = [];
  const seenActive = new Set<string>();

  if (ollamaStats?.model_cache) {
    for (const mc of ollamaStats.model_cache as any[]) {
      const key = mc.model || mc.key;
      if (!key) continue;
      // Only show models that are actively used (last_used within last hour) or have GPU processes
      const isRecent = mc.last_used && (Date.now() - mc.last_used) < 3600000;
      if (isRecent || seenActive.has(key)) {
        activeModels.push({ name: key, lastUsed: mc.last_used, size: mc.size, isLlm: mc.llm });
      } else if (!seenActive.has(key)) {
        // Also include all cached models for completeness
        activeModels.push({ name: key, lastUsed: mc.last_used, size: mc.size, isLlm: mc.llm });
        seenActive.add(key);
      }
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Performance Monitor</h2>
          <p className="text-sm text-gray-500 mt-1">
            Live system &amp; Ollama metrics • Auto-refresh every 5s
          </p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-white transition-color disabled:opacity-50"
        >
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {/* CPU + Memory Sparkline Chart */}
      <SparklineChart data={history} label="CPU &amp; Memory (15 min window)" color="blue" />

      {/* System Metrics */}
      <h3 className="text-lg font-semibold text-white mb-4">System</h3>
      <div className="grid grid-cols-2 gap-4 mb-8">
        {/* CPU Usage */}
        <MetricCard
          icon={<Cpu size={18} />}
          label="CPU Usage"
          value={`${cpuPercent.toFixed(1)}%`}
          color="blue"
        />
        {/* Memory */}
        <MetricCard
          icon={<Zap size={18} />}
          label="Memory"
          value={`${memPercent.toFixed(1)}%`}
          sublabel={`${formatBytes(sysMetrics?.memory_used_mb ? sysMetrics.memory_used_mb * 1024 * 1024 : 0)} / ${formatBytes(sysMetrics?.memory_total_mb ? sysMetrics.memory_total_mb * 1024 * 1024 : 0)}`}
          color="green"
        />
        {/* Disk */}
        <MetricCard
          icon={<HardDrive size={18} />}
          label="Disk Usage"
          value={`${diskPercent.toFixed(1)}%`}
          sublabel={`${formatBytes(sysMetrics?.disk_used_gb ? sysMetrics.disk_used_gb * 1024 ** 3 : 0)} / ${formatBytes(sysMetrics?.disk_total_gb ? sysMetrics.disk_total_gb * 1024 ** 3 : 0)}`}
          color="amber"
        />
        {/* Load Average */}
        <MetricCard
          icon={<Activity size={18} />}
          label="Load Average"
          value={`${sysMetrics?.load_avg_1m?.toFixed(2) ?? "—"}`}
          sublabel={`1m: ${sysMetrics?.load_avg_1m?.toFixed(2)} • 5m: ${sysMetrics?.load_avg_5m?.toFixed(2)} • 15m: ${sysMetrics?.load_avg_15m?.toFixed(2)}`}
          color="purple"
        />
      </div>

      {/* Progress Bars */}
      <div className="grid grid-cols-4 gap-6 mb-8">
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span className="text-gray-400">CPU</span>
            <span className="text-white">{cpuPercent.toFixed(1)}%</span>
          </div>
          <ProgressBar
            percent={cpuPercent}
            color={cpuPercent > 90 ? "bg-red-500" : cpuPercent > 70 ? "bg-amber-500" : "bg-blue-500"}
          />
        </div>
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span className="text-gray-400">Memory</span>
            <span className="text-white">{memPercent.toFixed(1)}%</span>
          </div>
          <ProgressBar
            percent={memPercent}
            color={memPercent > 90 ? "bg-red-500" : memPercent > 70 ? "bg-amber-500" : "bg-emerald-500"}
          />
        </div>
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span className="text-gray-400">Disk</span>
            <span className="text-white">{diskPercent.toFixed(1)}%</span>
          </div>
          <ProgressBar
            percent={diskPercent}
            color={diskPercent > 90 ? "bg-red-500" : diskPercent > 70 ? "bg-amber-500" : "bg-purple-500"}
          />
        </div>
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span className="text-gray-400">GPU VRAM</span>
            <span className="text-white">{vramPercent.toFixed(1)}%</span>
          </div>
          <ProgressBar
            percent={vramPercent}
            color={vramPercent > 90 ? "bg-red-500" : vramPercent > 70 ? "bg-amber-500" : "bg-cyan-500"}
          />
        </div>
      </div>

      {/* Ollama Section */}
      <h3 className="text-lg font-semibold text-white mb-4">Ollama</h3>
      <div className="grid grid-cols-2 gap-4 mb-8">
        <MetricCard
          icon={<Cpu size={18} />}
          label="GPU VRAM"
          value={`${vramPercent.toFixed(1)}%`}
          sublabel={`${formatBytes(vramUsed * 1024 * 1024)} / ${formatBytes(vramTotal * 1024 * 1024)}`}
          color="blue"
        />
        <MetricCard
          icon={<Database size={18} />}
          label="Loaded Models"
          value={`${(ollamaMetrics?.models ?? []).length}`}
          sublabel={
            ((ollamaMetrics?.models as NonNullable<typeof ollamaMetrics.models>) ?? [])
              .filter((m: any) => m.details?.name)
              .map((m: any) => m.details!.name!)
              .join(", ") || "None"
          }
          color="green"
        />
      </div>

      {/* Active Ollama Models */}
      {activeModels.length > 0 && (
        <>
          <h3 className="text-lg font-semibold text-white mb-4">Active Models</h3>
          <div className="rounded-xl border border-gray-700 bg-gray-900/50 overflow-x-auto mb-8">
            <table className="w-full text-sm">
              <thead className="bg-gray-800/50 sticky top-0">
                <tr className="text-left text-gray-400">
                  <th className="px-4 py-3 font-medium">Model</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Size</th>
                  <th className="px-4 py-3 font-medium">Last Used</th>
                </tr>
              </thead>
              <tbody>
                {activeModels.map((model, idx) => (
                  <tr key={idx} className="border-t border-gray-700/50 hover:bg-gray-800/30">
                    <td className="px-4 py-3 text-white font-mono">{model.name}</td>
                    <td className="px-4 py-3">
                      {model.isLlm ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-900/40 text-purple-300">LLM</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-cyan-900/40 text-cyan-300">Embedding</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-300">{model.size ? formatBytes(model.size) : "—"}</td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {model.lastUsed ? formatDurationAgo(model.lastUsed) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Model Details */}
      {(ollamaMetrics?.models ?? []).length > 0 && (
        <>
          <h3 className="text-lg font-semibold text-white mb-4">All Models</h3>
          <div className="rounded-xl border border-gray-700 bg-gray-900/50 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-800/50 sticky top-0">
                <tr className="text-left text-gray-400">
                  <th className="px-4 py-3 font-medium">Model</th>
                  <th className="px-4 py-3 font-medium">Size</th>
                  <th className="px-4 py-3 font-medium">Parameters</th>
                  <th className="px-4 py-3 font-medium">Quantization</th>
                </tr>
              </thead>
              <tbody>
                {(ollamaMetrics.models as NonNullable<typeof ollamaMetrics.models>).map((model: any, idx: number) => (
                  <tr key={idx} className="border-t border-gray-700/50 hover:bg-gray-800/30">
                    <td className="px-4 py-3 text-white font-mono">{model.details?.name || model.model}</td>
                    <td className="px-4 py-3 text-gray-300">
                      {formatBytes(model.size_bytes ?? 0)}
                    </td>
                    <td className="px-4 py-3 text-gray-300">{model.details?.parameter_size || "—"}</td>
                    <td className="px-4 py-3 text-gray-300">{model.details?.quantization_level || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* System Details */}
      <h3 className="text-lg font-semibold text-white mb-4">System Details</h3>
      <div className="grid grid-cols-2 gap-6">
        <div className="space-y-2 rounded-xl border border-gray-700 bg-gray-900/50 p-5">
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Uptime</span>
            <span className="text-white">{formatUptime(sysMetrics?.uptime_seconds ?? 0)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}