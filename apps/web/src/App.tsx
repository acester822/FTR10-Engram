import React, { useState, useEffect, useCallback, useRef } from "react";

// Local type alias — @types/react doesn't resolve in this monorepo setup with bundler moduleResolution
type ReactNode = any;
import { Skull, Database, Activity, Trash2, Edit2, Save, X, Search, RefreshCw, FileText, Cpu, Thermometer, Zap, HardDrive, Gauge, Terminal, Sun, Moon, ChevronDown, Settings as SettingsIcon, FlaskConical, Share2, Download, ClipboardList, Flag, AlertTriangle } from "lucide-react";
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
  importance_tier?: string;
  importance_score?: number;
}

interface RecallResult {
  id: string;
  content: string;
  score: number;
  sector?: string;
  confidence?: number;
  salience?: number;
}

interface Stats {
  total_memories: number;
  genome_count: number;
  phenotype_count: number;
  by_sector: Record<string, number>;
  by_tier: Record<string, number>;
}

type Tab = "dashboard" | "memories" | "serverLogs" | "performance" | "recall" | "activity" | "settings" | "mindmap" | "traces" | "governance";

export default function App() {
  const [activeTab, setActiveTab] = useState("dashboard" as Tab);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dark, setDark] = useState(
    () => localStorage.getItem("engram-theme") === "dark",
  );

  useEffect(() => {
    const root = document.documentElement;
    if (dark) root.classList.add("dark");
    else root.classList.remove("dark");
    localStorage.setItem("engram-theme", dark ? "dark" : "light");
  }, [dark]);

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
          <NavButton
            active={activeTab === "recall"}
            onClick={() => setActiveTab("recall")}
            icon={<Search size={20} />}
          >
            Memory Recall
          </NavButton>
          <NavButton
            active={activeTab === "activity"}
            onClick={() => setActiveTab("activity")}
            icon={<Activity size={20} />}
          >
            Activity
          </NavButton>
          <NavButton
            active={activeTab === "mindmap"}
            onClick={() => setActiveTab("mindmap")}
            icon={<Share2 size={20} />}
          >
            Mind Map
          </NavButton>
          <NavButton
            active={activeTab === "traces"}
            onClick={() => setActiveTab("traces")}
            icon={<FileText size={20} />}
          >
            Traces
          </NavButton>
          <NavButton
            active={activeTab === "governance"}
            onClick={() => setActiveTab("governance")}
            icon={<ClipboardList size={20} />}
          >
            Governance
          </NavButton>
          <NavButton
            active={activeTab === "settings"}
            onClick={() => setActiveTab("settings")}
            icon={<SettingsIcon size={20} />}
          >
            Settings
          </NavButton>
        </nav>

        <div className="pt-6 border-t border-slate-700 text-xs text-slate-400">
          <button
            onClick={() => setDark((d: boolean) => !d)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-300 hover:bg-slate-800 transition-colors mb-3"
          >
            {dark ? <Sun size={16} /> : <Moon size={16} />}
            {dark ? "Light mode" : "Dark mode"}
          </button>
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
        {activeTab === "recall" && <RecallView />}
        {activeTab === "activity" && <ActivityView />}
        {activeTab === "mindmap" && <MemoryGraphView />}
        {activeTab === "traces" && <TracesView />}
        {activeTab === "governance" && <GovernanceView />}
        {activeTab === "settings" && <SettingsView />}
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
  const [consolidating, setConsolidating] = useState("" as string);
  const [consolidateMsg, setConsolidateMsg] = useState("");

  const triggerConsolidation = async (tier: string) => {
    setConsolidating(tier);
    setConsolidateMsg("");
    try {
      await fetch(`${API_BASE}/consolidate?tier=${tier}`, { method: "POST" });
      setConsolidateMsg(`${tier} consolidation triggered successfully`);
      setTimeout(() => onRefresh(), 1500);
    } catch {
      setConsolidateMsg(`Failed to trigger ${tier} consolidation`);
    } finally {
      setConsolidating("");
    }
  };

  if (!stats) return <div className="text-slate-500">Loading cognitive stats...</div>;

  const total = stats.total_memories || 1;

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-slate-800">Cognitive Overview</h2>
        <div className="flex gap-2">
          <button
            onClick={() => triggerConsolidation("recent")}
            disabled={!!consolidating}
            title="Recent tier: last 7 days (scheduled every 4h)"
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw size={18} className={consolidating === "recent" ? "animate-spin" : ""} />
            Recent
          </button>
          <button
            onClick={() => triggerConsolidation("deep")}
            disabled={!!consolidating}
            title="Deep tier: memories 7–30 days old (scheduled every 24h)"
            className="flex items-center gap-2 bg-slate-700 hover:bg-slate-800 text-white px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw size={18} className={consolidating === "deep" ? "animate-spin" : ""} />
            Deep
          </button>
        </div>
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

const IMPORTANCE_STYLES: Record<string, string> = {
  critical: "bg-red-100 text-red-700",
  high: "bg-orange-100 text-orange-700",
  medium: "bg-slate-200 text-slate-600",
  low: "bg-gray-100 text-gray-500",
};

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
              <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase">Importance</th>
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
                <td className="px-6 py-4">
                  <span
                    className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${
                      IMPORTANCE_STYLES[m.importance_tier || "medium"] ||
                      IMPORTANCE_STYLES.medium
                    }`}
                    title={`Importance tier: ${m.importance_tier || "medium"}${
                      m.importance_score != null
                        ? ` (${m.importance_score.toFixed(2)})`
                        : ""
                    }`}
                  >
                    {m.importance_tier || "medium"}
                    {m.importance_score != null && (
                      <span className="opacity-70">{m.importance_score.toFixed(2)}</span>
                    )}
                  </span>
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
                <td colSpan={6} className="px-6 py-12 text-center text-slate-400">
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

function RecallView() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("associative");
  const [limit, setLimit] = useState(10);
  const [results, setResults] = useState([] as RecallResult[]);
  const [timings, setTimings] = useState(null as null | Record<string, number>);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [empty, setEmpty] = useState(false);

  const runRecall = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError("");
    setEmpty(false);
    try {
      const res = await fetch(`${API_BASE}/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim(), mode, limit }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.msg || `Recall failed (${res.status})`);
      }
      const data = await res.json();
      const rows = data.results || [];
      setResults(rows);
      setTimings(data.timings || null);
      setEmpty(rows.length === 0);
    } catch (e: any) {
      setError(e?.message || "Recall request failed");
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-slate-800">Memory Recall</h2>
        <span className="text-xs text-slate-400">
          Semantic similarity search across all stored memories (pgvector)
        </span>
      </div>

      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-3 text-slate-400" size={20} />
          <input
            type="text"
            placeholder="Ask a question or describe what you want to recall..."
            className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runRecall(); }}
          />
        </div>

        <div className="flex flex-wrap gap-4 items-center">
          <div className="flex items-center gap-2">
            <label className="text-sm text-slate-500">Mode</label>
            <select
              className="px-3 py-2 border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-blue-500 outline-none"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              <option value="associative">Associative</option>
              <option value="strict">Strict</option>
              <option value="historical">Historical</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-sm text-slate-500">Limit</label>
            <select
              className="px-3 py-2 border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-blue-500 outline-none"
              value={limit}
              onChange={(e) => setLimit(parseInt(e.target.value))}
            >
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
            </select>
          </div>

          <button
            onClick={runRecall}
            disabled={loading || !query.trim()}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-lg transition-colors disabled:opacity-50"
          >
            <Search size={18} />
            {loading ? "Recalling..." : "Recall"}
          </button>
        </div>

        {timings && (
          <p className="text-xs text-slate-400">
            embed {timings.embedding_ms ?? 0}ms · retrieve {timings.retrieval_ms ?? 0}ms · total {timings.total_ms ?? 0}ms
          </p>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-600 text-sm px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {empty && !loading && (
        <div className="bg-white border border-gray-200 rounded-xl px-6 py-12 text-center text-slate-400">
          No memories matched this query.
        </div>
      )}

      <div className="space-y-3">
        {results.map((r: RecallResult) => (
          <div
            key={r.id}
            className="bg-white p-5 rounded-xl shadow-sm border border-gray-200 hover:border-blue-300 transition-colors"
          >
            <div className="flex items-start justify-between gap-4">
              <p className="text-sm text-slate-800 whitespace-pre-wrap leading-relaxed flex-1">
                {r.content}
              </p>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 capitalize">
                  {r.sector || "unknown"}
                </span>
                <span
                  className={`text-xs font-semibold ${
                    r.score >= 0.7
                      ? "text-emerald-600"
                      : r.score >= 0.5
                        ? "text-amber-600"
                        : "text-slate-400"
                  }`}
                >
                  {(r.score * 100).toFixed(0)}% match
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActivityView() {
  const [entries, setEntries] = useState([] as any[]);
  const [incoming, setIncoming] = useState(0);
  const [outgoing, setOutgoing] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null as null | Date);
  const [filter, setFilter] = useState("all" as "all" | "in" | "out");
  const [clearing, setClearing] = useState(false);
  const [expanded, setExpanded] = useState(new Set() as Set<number>);

  const toggle = (idx: number) =>
    setExpanded((prev: Set<number>) => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });

  const fetchActivity = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/activity`);
      if (res.ok) {
        const data = await res.json();
        setEntries(data.entries || []);
        setIncoming(data.incoming || 0);
        setOutgoing(data.outgoing || 0);
        setLastUpdated(new Date());
      }
    } catch {
      // silently ignore — view handles empty state
    }
  }, []);

  useEffect(() => {
    fetchActivity();
  }, [fetchActivity]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchActivity, 2500);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchActivity]);

  const handleClear = async () => {
    if (!confirm("Clear the in-memory activity buffer?")) return;
    setClearing(true);
    try {
      await fetch(`${API_BASE}/activity/clear`, { method: "POST" });
      fetchActivity();
    } catch {
      alert("Failed to clear activity");
    } finally {
      setClearing(false);
    }
  };

  const visible = entries.filter((e: any) =>
    filter === "all" ? true : e.direction === filter,
  );

  const dirBadge = (e: any) =>
    e.direction === "in"
      ? "bg-emerald-100 text-emerald-700"
      : "bg-blue-100 text-blue-700";
  const dirLabel = (e: any) => (e.direction === "in" ? "IN" : "OUT");

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Memory Activity</h2>
          <p className="text-sm text-slate-500 mt-1">
            Live inbound/outbound memory traffic — proves a connected client (Hermes) is actually using memory.
          </p>
        </div>
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
            disabled={clearing}
            className="flex items-center gap-2 px-3 py-2 bg-red-50 text-red-600 border border-red-300 rounded-lg text-sm hover:bg-red-100 transition-colors disabled:opacity-50"
          >
            <Trash2 size={14} />
            Clear
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
          <p className="text-sm text-slate-500 font-medium">Total events</p>
          <p className="text-3xl font-bold text-slate-900">{entries.length}</p>
        </div>
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
          <p className="text-sm text-slate-500 font-medium">Incoming (saved)</p>
          <p className="text-3xl font-bold text-emerald-600">{incoming}</p>
        </div>
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
          <p className="text-sm text-slate-500 font-medium">Outgoing (retrieved)</p>
          <p className="text-3xl font-bold text-blue-600">{outgoing}</p>
        </div>
      </div>

      {/* Filter */}
      <div className="flex gap-2 items-center">
        {["all", "in", "out"].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f as any)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors capitalize ${
              filter === f
                ? "bg-slate-800 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {f === "in" ? "Incoming" : f === "out" ? "Outgoing" : "All"}
          </button>
        ))}
        <span className="ml-auto text-xs text-slate-400 self-center">
          {lastUpdated ? `updated ${lastUpdated.toLocaleTimeString()}` : "loading..."}
        </span>
      </div>

      {/* Activity stream */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="max-h-[600px] overflow-y-auto divide-y divide-gray-100">
          {visible.length === 0 ? (
            <div className="px-6 py-12 text-center text-slate-400">
              No memory traffic captured yet. Trigger a write (e.g. save a memory) or a recall to see it here.
            </div>
          ) : (
            visible.map((e: any, idx: number) => {
              const isOpen = expanded.has(idx);
              const detail = e.payload || e.summary;
              return (
                <div key={idx} className="border-b border-gray-100 last:border-0">
                  <button
                    type="button"
                    onClick={() => toggle(idx)}
                    className="w-full flex items-start gap-4 px-6 py-3 hover:bg-gray-50 transition-colors text-left"
                  >
                    <ChevronDown
                      size={16}
                      className={`shrink-0 mt-1 text-slate-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
                    />
                    <span className={`shrink-0 mt-0.5 inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${dirBadge(e)}`}>
                      {dirLabel(e)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-800 whitespace-pre-wrap break-words">
                        {e.summary || <span className="text-slate-400 italic">(empty body)</span>}
                      </p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {e.label} · {e.route} · {e.status} · {e.ms}ms
                        {e.count != null ? ` · ${e.count} returned` : ""}
                        {e.user_id ? ` · user:${e.user_id}` : ""}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-slate-400">
                      {e.ts ? new Date(e.ts).toLocaleTimeString() : ""}
                    </span>
                  </button>
                  {isOpen && detail && (
                    <div className="px-6 pb-4 pl-14">
                      <div className="bg-slate-50 border border-gray-200 rounded-lg p-4">
                        <p className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold mb-2">
                          {e.kind === "write" ? "Saved memory" : "Retrieved memory"}
                        </p>
                        <pre className="text-sm text-slate-700 whitespace-pre-wrap break-words font-sans leading-relaxed">
                          {detail}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

const settingsInputCls = "w-full px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500";
const settingsLabelCls = "block text-xs font-medium text-slate-500 mb-1";

function SettingsField({ label, value, onChange, placeholder }: any) {
  return (
    <div>
      <label className={settingsLabelCls}>{label}</label>
      <input
        className={settingsInputCls}
        value={value}
        placeholder={placeholder || ""}
        onChange={(e: any) => onChange(e.target.value)}
      />
    </div>
  );
}

function SettingsResultBadge({ result }: any) {
  if (!result) return null;
  return (
    <div
      className={`mt-3 px-3 py-2 rounded-lg text-sm ${
        result.ok ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
      }`}
    >
      {result.ok ? (
        <>✓ Test passed — {result.model} @ {result.providerUrl} ({result.latencyMs}ms{result.dims ? `, ${result.dims} dims` : ""})</>
      ) : (
        <>✗ Test failed — {result.error || "unknown error"}{result.latencyMs ? ` (${result.latencyMs}ms)` : ""}</>
      )}
    </div>
  );
}

function GeneralField({ label, type, value, onChange }: any) {
  if (type === "bool") {
    return (
      <div>
        <label className={settingsLabelCls}>{label}</label>
        <select
          className={settingsInputCls}
          value={value}
          onChange={(e: any) => onChange(e.target.value)}
        >
          <option value="">(default)</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      </div>
    );
  }
  return (
    <SettingsField
      label={label}
      value={value}
      onChange={onChange}
      placeholder={type === "number" ? "(default)" : ""}
    />
  );
}

const GENERAL_GROUPS = [
  {
    title: "Server",
    fields: [
      ["vec_dim", "Embedding Dimensions", "number"],
      ["max_payload_size", "Max Payload Size (bytes)", "number"],
      ["require_api_key", "Require API Key", "bool"],
      ["api_key", "API Key", "string"],
    ],
  },
  {
    title: "Embedding",
    fields: [["embed_timeout_ms", "Timeout (ms)", "number"]],
  },
  {
    title: "Rate Limits",
    fields: [
      ["rate_limit_enabled", "Enabled", "bool"],
      ["rate_limit_window_ms", "Window (ms)", "number"],
      ["rate_limit_max_requests", "Max Requests / Window", "number"],
    ],
  },
  {
    title: "Compaction",
    fields: [
      ["compact_trigger", "Trigger (messages)", "number"],
      ["max_raw_turns", "Max Raw Turns", "number"],
      ["compact_max_messages", "Max Messages", "number"],
      ["compact_timeout_sec", "Timeout (s)", "number"],
      ["compact_prompt_max_chars", "Prompt Max Chars", "number"],
      ["compaction_cooldown_ms", "Cooldown (ms)", "number"],
    ],
  },
  {
    title: "Auto-Search",
    fields: [
      ["auto_search_enabled", "Enabled", "bool"],
      ["auto_search_max_results", "Max Results", "number"],
      ["auto_search_min_confidence", "Min Confidence", "number"],
      ["auto_search_max_chars", "Max Chars", "number"],
    ],
  },
  {
    title: "Consolidation",
    fields: [
      ["consol_recent_interval_ms", "Recent Interval (ms)", "number"],
      ["consol_deep_interval_ms", "Deep Interval (ms)", "number"],
      ["consol_recent_max_age_days", "Recent Window (days)", "number"],
      ["consol_deep_max_age_days", "Deep Window (days)", "number"],
      ["consol_recent_min_group", "Recent Min Group", "number"],
      ["consol_deep_min_group", "Deep Min Group", "number"],
    ],
  },
  {
    title: "Traces",
    fields: [
      ["trace_retention_days", "Retention (days)", "number"],
      ["trace_max_body_chars", "Max Body Chars", "number"],
      ["trace_auto_score_rate", "Auto-Score Rate (0=off)", "number"],
    ],
  },
  {
    title: "Policy",
    fields: [
      ["policy_good_threshold", "Good Score Threshold", "number"],
      ["policy_bad_threshold", "Bad Score Threshold", "number"],
    ],
  },
];

const ADVANCED_GROUPS = [
  {
    title: "Database",
    fields: [
      ["pg_host", "Postgres Host", "string"],
      ["pg_port", "Postgres Port", "number"],
      ["pg_db", "Postgres Database", "string"],
      ["pg_user", "Postgres User", "string"],
      ["pg_password", "Postgres Password", "string"],
      ["pg_schema", "Postgres Schema", "string"],
      ["pg_ssl", "Postgres SSL (require/disable)", "string"],
      ["redis_url", "Redis URL", "string"],
    ],
  },
  {
    title: "Provider Keys",
    fields: [
      ["openai_api_key", "OpenAI API Key", "string"],
      ["gemini_key", "Gemini API Key", "string"],
      ["aws_region", "AWS Region", "string"],
      ["aws_access_key_id", "AWS Access Key ID", "string"],
      ["aws_secret_access_key", "AWS Secret Access Key", "string"],
      ["siray_key", "Siray API Key", "string"],
      ["siray_token", "Siray API Token", "string"],
      ["siray_base_url", "Siray Base URL", "string"],
      ["google_credentials_json", "Google Credentials JSON", "string"],
      ["google_service_account_file", "Google Service Account File", "string"],
      ["notion_key", "Notion API Key", "string"],
      ["onedrive_token", "OneDrive Access Token", "string"],
      ["openmemory_key", "OpenMemory API Key", "string"],
      ["openmemory_url", "OpenMemory URL", "string"],
    ],
  },
  {
    title: "Vector Store",
    fields: [
      ["vector_store", "Vector Store", "string"],
      ["vector_url", "Vector Store URL", "string"],
      ["vector_api_key", "Vector Store API Key", "string"],
      ["vector_collection", "Vector Collection", "string"],
      ["vector_timeout_ms", "Vector Timeout (ms)", "number"],
    ],
  },
  {
    title: "Misc",
    fields: [
      ["mode", "Mode (standard/production)", "string"],
      ["storage", "Storage Backend", "string"],
      ["sqlite_path", "SQLite Path", "string"],
      ["http_timeout_ms", "HTTP Timeout (ms)", "number"],
      ["log_auth", "Log Auth", "bool"],
      ["log_dir", "Log Directory", "string"],
      ["log_max_lines", "Log Max Lines", "number"],
      ["telemetry", "Telemetry", "bool"],
      ["internal_api_key", "Internal API Key", "string"],
    ],
  },
];

function ScorePill({ score, label, good = 0.7, bad = 0.4 }: any) {
  const cls =
    score >= good
      ? "bg-emerald-100 text-emerald-700"
      : score >= bad
      ? "bg-yellow-100 text-yellow-700"
      : "bg-red-100 text-red-700";
  return <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${cls}`}>{label !== undefined ? label : score}</span>;
}

function TracesView() {
  const [traces, setTraces] = useState([] as any[]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null as any);
  const [filter, setFilter] = useState({ route: "", direction: "", kind: "", status: "", scored: "", limit: "100" });
  const [dimension, setDimension] = useState("answer_quality" as string);
  const [scoring, setScoring] = useState(false);
  const [scoreMsg, setScoreMsg] = useState(null as any);
  const [scoringAll, setScoringAll] = useState(false);
  const [bulkMsg, setBulkMsg] = useState(null as any);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [report, setReport] = useState(null as any);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportOpts, setReportOpts] = useState({ preset: "7", from: "", to: "", route: "", direction: "", status: "" });
  const [facets, setFacets] = useState({ routes: [] as string[], statuses: [] as string[], policy: { good: 0.7, bad: 0.4 } });
  const reportRef = useRef(null);
  const detailRef = useRef(null);
  const [calOpen, setCalOpen] = useState(false);
  const [calDim, setCalDim] = useState("recall_relevance");
  const [calExp, setCalExp] = useState("0.7");
  const [calNote, setCalNote] = useState("");
  const [calMsg2, setCalMsg2] = useState(null as any);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/traces/facets`);
        if (res.ok) {
          const d = await res.json();
          setFacets({
            routes: d.routes || [],
            statuses: (d.statuses || []).map((s: any) => String(s)),
            policy: d.policy || { good: 0.7, bad: 0.4 },
          });
        }
      } catch {
        // ignore — dropdowns fall back to free text behavior
      }
    })();
  }, []);

  const fetchTraces = useCallback(async (showLoading = false) => {
    // showLoading=true on first load / filter change; background polls pass
    // false so the list doesn't flash "Loading…" every 2.5s.
    if (showLoading) setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter.route) params.set("route", filter.route);
      if (filter.direction) params.set("direction", filter.direction);
      if (filter.kind) params.set("kind", filter.kind);
      if (filter.status) params.set("status", filter.status);
      if (filter.scored === "review") params.set("review", "1");
      else if (filter.scored) params.set("scored", filter.scored);
      if (filter.limit) params.set("limit", filter.limit);
      const res = await fetch(`${API_BASE}/traces?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setTraces(data.traces || []);
      }
    } catch {
      // silently ignore — view handles empty state
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchTraces(true);
  }, [fetchTraces]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => fetchTraces(false), 2500);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchTraces]);

  const openDetail = async (id: string) => {
    setScoreMsg(null); // clear the previous trace's score result when switching
    try {
      const res = await fetch(`${API_BASE}/traces/${id}`);
      if (res.ok) {
        const data = await res.json();
        setSelected(data.trace);
        // Review loop: opening an unreviewed low-scored trace clears its flag.
        if (data.trace && data.trace.needs_review) {
          fetch(`${API_BASE}/traces/${id}/review`, { method: "POST" }).catch(() => {});
          fetchTraces(false);
        }
        // Scroll the detail panel into view — it renders below a long table.
        setTimeout(() => {
          if (detailRef.current) detailRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 60);
      }
    } catch {
      // ignore
    }
  };

  const defaultDimFor = (t: any) =>
    t?.label === "chat" ? "answer_quality" : t?.label === "ingest" || t?.label === "remember" ? "extraction_fidelity" : "recall_relevance";

  const openCalForm = () => {
    if (!selected) return;
    setCalDim(defaultDimFor(selected));
    setCalMsg2(null);
    setCalOpen(!calOpen);
  };

  const addCalForSelected = async () => {
    if (!selected) return;
    setCalMsg2(null);
    try {
      const res = await fetch("/api/dashboard/judge/calibration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trace_id: selected.id,
          dimension: calDim,
          expected_score: Number(calExp),
          note: calNote || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setCalOpen(false);
        setCalNote("");
        setCalMsg2({ ok: true, text: "Added to the calibration set." });
      } else {
        setCalMsg2({ ok: false, text: (data && (data.msg || data.error)) || "Add failed" });
      }
    } catch (e: any) {
      setCalMsg2({ ok: false, text: String(e) });
    }
  };

  const copyId = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.id);
      setScoreMsg({ ok: true, text: "Trace id copied to clipboard" });
    } catch {
      // ignore
    }
  };

  const handleDeleteTrace = async () => {
    if (!selected) return;
    if (!confirm("Delete this trace permanently? Its calibration entries (if any) are removed too.")) return;
    try {
      const res = await fetch(`${API_BASE}/traces/${selected.id}`, { method: "DELETE" });
      if (res.ok) {
        setSelected(null);
        setScoreMsg(null);
        fetchTraces(false);
      } else {
        alert("Delete failed");
      }
    } catch {
      alert("Delete failed");
    }
  };

  const doScore = async () => {
    if (!selected) return;
    setScoring(true);
    setScoreMsg(null);
    try {
      const res = await fetch(`${API_BASE}/traces/${selected.id}/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dimension }),
      });
      const data = await res.json();
      if (res.ok) setScoreMsg({ ok: true, text: `Scored ${data.score} — ${data.reason}` });
      else setScoreMsg({ ok: false, text: (data && (data.msg || data.error)) || "Score failed" });
      openDetail(selected.id);
    } catch (e: any) {
      setScoreMsg({ ok: false, text: String(e) });
    } finally {
      setScoring(false);
    }
  };

  const handleClear = async () => {
    if (!confirm("Delete ALL traces? This is permanent.")) return;
    try {
      await fetch(`${API_BASE}/traces`, { method: "DELETE" });
      setSelected(null);
      fetchTraces();
    } catch {
      alert("Failed to clear traces");
    }
  };

  const handlePrune = async () => {
    if (!confirm("Prune traces older than the retention window? (default 30 days)")) return;
    try {
      await fetch(`${API_BASE}/traces/prune`, { method: "DELETE" });
      fetchTraces();
    } catch {
      alert("Failed to prune traces");
    }
  };

  const handleScoreAll = async () => {
    setScoringAll(true);
    setBulkMsg(null);
    try {
      const res = await fetch(`${API_BASE}/traces/score-unscored?limit=25`, { method: "POST" });
      const data = await res.json();
      if (res.ok)
        setBulkMsg({
          ok: true,
          text: `Scored ${data.scored} (${data.failed} failed, ${data.skipped} skipped) — ${data.remaining} unscored remaining`,
        });
      else setBulkMsg({ ok: false, text: (data && (data.msg || data.error)) || "Bulk score failed" });
      fetchTraces();
    } catch (e: any) {
      setBulkMsg({ ok: false, text: String(e) });
    } finally {
      setScoringAll(false);
    }
  };

  const generateReport = async () => {
    setReportOpen(false);
    setReportLoading(true);
    try {
      const p = new URLSearchParams();
      if (reportOpts.preset === "custom") {
        p.set("days", "365"); // wide default; from/to bound the window
        if (reportOpts.from) p.set("from", `${reportOpts.from}T00:00:00`);
        if (reportOpts.to) p.set("to", `${reportOpts.to}T23:59:59`);
      } else {
        p.set("days", reportOpts.preset);
      }
      if (reportOpts.route) p.set("route", reportOpts.route);
      if (reportOpts.direction) p.set("direction", reportOpts.direction);
      if (reportOpts.status) p.set("status", reportOpts.status);
      p.set("limit", "10");
      const res = await fetch(`${API_BASE}/traces/report?${p.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setReport(data.report);
      } else {
        setReport(null);
      }
    } catch {
      setReport(null);
    } finally {
      setReportLoading(false);
    }
  };

  // ── PDF download: capture the RENDERED report panel with html2canvas and
  //    embed it in a jsPDF (pixel-identical to the GUI). Both libs vendored at
  //    public/vendor — local-first, no CDN at runtime. ──
  const ensureJsPDF = () =>
    new Promise((resolve) => {
      const w = window as any;
      if (w.jspdf) return resolve(w.jspdf);
      const s = document.createElement("script");
      s.src = "/vendor/jspdf.umd.min.js";
      s.onload = () => resolve(w.jspdf);
      document.head.appendChild(s);
    });

  const ensureHtml2Canvas = () =>
    new Promise((resolve) => {
      const w = window as any;
      if (w.html2canvas) return resolve(w.html2canvas);
      const s = document.createElement("script");
      s.src = "/vendor/html2canvas.min.js";
      s.onload = () => resolve(w.html2canvas);
      document.head.appendChild(s);
    });

  const downloadReport = async () => {
    if (!report || !reportRef.current) return;
    try {
      const [jspdfMod, html2canvasFn]: any[] = await Promise.all([ensureJsPDF(), ensureHtml2Canvas()]);
      const { jsPDF } = jspdfMod;
      // Render the actual report DOM node at 2x for crisp text.
      const canvas = await html2canvasFn(reportRef.current, {
        scale: 2,
        backgroundColor: "#f8fafc", // slate-50 (same as page bg behind the card)
        useCORS: true,
        logging: false,
      });
      const imgData = canvas.toDataURL("image/jpeg", 0.92);
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      // Full-bleed, full-width render — identical to the GUI, just longer.
      // No margins, no scaling: the report is screen-viewed, not printed.
      const imgH = (canvas.height * pageW) / canvas.width;
      let heightLeft = imgH;
      let position = 0;
      pdf.addImage(imgData, "JPEG", 0, position, pageW, imgH);
      heightLeft -= pageH;
      while (heightLeft > 0) {
        position = heightLeft - imgH;
        pdf.addPage();
        pdf.addImage(imgData, "JPEG", 0, position, pageW, imgH);
        heightLeft -= pageH;
      }
      pdf.save(`engram-report-${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (e: any) {
      alert(`PDF download failed: ${e?.message || e}`);
    }
  };

  const fmtTs = (ts: string) => {
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return ts;
    }
  };

  const scoreBadge = (s: any[]) => {
    if (!s || !s.length) return <span className="text-xs text-slate-400">unscored</span>;
    return (
      <span className="inline-flex flex-wrap gap-1">
        {s.map((x: any, i: number) => (
          <ScorePill key={i} score={x.score} label={`${x.dimension.replace("_", " ")}: ${x.score}`} good={facets.policy.good} bad={facets.policy.bad} />
        ))}
      </span>
    );
  };

  const dirBadge = (d: string) =>
    d === "in" ? "bg-emerald-100 text-emerald-700" : d === "out" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700";

  const jsonBlock = (v: any) => {
    if (v === null || v === undefined) return <span className="text-xs text-slate-400">—</span>;
    let text: string;
    try {
      text = typeof v === "string" ? v : JSON.stringify(v, null, 2);
    } catch {
      text = String(v);
    }
    if (text.length > 60000) text = text.slice(0, 60000) + "\n… (truncated)";
    return (
      <pre className="text-xs text-slate-700 bg-slate-50 border border-gray-200 rounded-lg p-3 max-h-96 overflow-auto whitespace-pre-wrap break-all">
        {text}
      </pre>
    );
  };

  const setF = (k: string, v: string) => setFilter((prev: any) => ({ ...prev, [k]: v }));

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Traces</h2>
          <p className="text-sm text-slate-500 mt-1">
            Persistent request history for the memory/agent loop — full bodies (secrets redacted), genome/phenotype breakdown, and judge scores.
          </p>
        </div>
        <div className="flex gap-3 items-center">
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
            onClick={() => setReportOpen(true)}
            disabled={reportLoading}
            className="px-3 py-2 bg-slate-800 text-white rounded-lg text-sm hover:bg-slate-900 disabled:opacity-50"
          >
            {reportLoading ? "Generating..." : "Generate Report"}
          </button>
          <button
            onClick={handleScoreAll}
            disabled={scoringAll}
            className="px-3 py-2 bg-blue-50 text-blue-700 border border-blue-300 rounded-lg text-sm hover:bg-blue-100 transition-colors disabled:opacity-50"
          >
            {scoringAll ? "Scoring..." : "Score unscored"}
          </button>
          <button
            onClick={handlePrune}
            className="px-3 py-2 bg-amber-50 text-amber-700 border border-amber-300 rounded-lg text-sm hover:bg-amber-100 transition-colors"
          >
            Prune old
          </button>
          <button
            onClick={handleClear}
            className="px-3 py-2 bg-red-50 text-red-600 border border-red-300 rounded-lg text-sm hover:bg-red-100 transition-colors"
          >
            Clear all
          </button>
        </div>
      </div>

      {/* Report generator modal */}
      {reportOpen && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
          onClick={() => setReportOpen(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl p-6 w-96 space-y-4"
            onClick={(e: any) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-slate-800">Generate Report</h3>
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase block mb-1">Date range</label>
              <select
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                value={reportOpts.preset}
                onChange={(e: any) => setReportOpts({ ...reportOpts, preset: e.target.value })}
              >
                <option value="1">Last 24 hours</option>
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
                <option value="custom">Custom range</option>
              </select>
            </div>
            {reportOpts.preset === "custom" && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase block mb-1">From</label>
                  <input
                    type="date"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    value={reportOpts.from}
                    onChange={(e: any) => setReportOpts({ ...reportOpts, from: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase block mb-1">To</label>
                  <input
                    type="date"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    value={reportOpts.to}
                    onChange={(e: any) => setReportOpts({ ...reportOpts, to: e.target.value })}
                  />
                </div>
              </div>
            )}
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase block mb-1">
                Route (optional)
              </label>
              <select
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                value={reportOpts.route}
                onChange={(e: any) => setReportOpts({ ...reportOpts, route: e.target.value })}
              >
                <option value="">All routes</option>
                {facets.routes.map((r: string) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase block mb-1">
                Status (optional)
              </label>
              <select
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                value={reportOpts.status}
                onChange={(e: any) => setReportOpts({ ...reportOpts, status: e.target.value })}
              >
                <option value="">All statuses</option>
                {facets.statuses.map((s: string) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase block mb-1">
                Direction (optional)
              </label>
              <select
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                value={reportOpts.direction}
                onChange={(e: any) => setReportOpts({ ...reportOpts, direction: e.target.value })}
              >
                <option value="">All</option>
                <option value="in">IN (writes)</option>
                <option value="out">OUT (reads)</option>
                <option value="chat">Chat</option>
                <option value="system">System</option>
              </select>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setReportOpen(false)}
                className="px-4 py-2 bg-gray-100 text-gray-600 border border-gray-300 rounded-lg text-sm hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={generateReport}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
              >
                Generate
              </button>
            </div>
          </div>
        </div>
      )}

      {bulkMsg && (
        <div
          className={`px-3 py-2 rounded-lg text-sm ${
            bulkMsg.ok ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
          }`}
        >
          {bulkMsg.ok ? "✓ " : "✗ "}
          {bulkMsg.text}
        </div>
      )}

      {/* Report */}
      {report && (
        <div
          ref={reportRef}
          className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 space-y-5"
        >
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold text-slate-800">
              Report —{" "}
              {report.from && report.to
                ? `${report.from.slice(0, 10)} → ${report.to.slice(0, 10)}`
                : `last ${report.window_days} day${report.window_days === 1 ? "" : "s"}`}
              <span className="ml-2 text-xs font-normal text-slate-400">
                judge: {(report.judge_models || []).join(", ") || "—"}
              </span>
            </h3>
            <div className="flex gap-2">
              <button
                onClick={downloadReport}
                title="Download report as PDF"
                className="flex items-center gap-2 px-3 py-2 bg-blue-50 text-blue-700 border border-blue-300 rounded-lg text-sm hover:bg-blue-100 transition-colors"
              >
                <Download size={16} /> PDF
              </button>
              <button
                onClick={() => setReport(null)}
                className="px-3 py-2 bg-gray-100 text-gray-600 border border-gray-300 rounded-lg text-sm hover:bg-gray-200"
              >
                Close
              </button>
            </div>
          </div>

          {/* Policy alerts (governance surface for "something is not right") */}
          {report.policy_alerts && report.policy_alerts.length > 0 && (
            <div className="space-y-2">
              {report.policy_alerts.map((a: any, i: number) => (
                <div
                  key={i}
                  className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-sm ${
                    a.severity === "high" ? "bg-red-50 border-red-200" : "bg-yellow-50 border-yellow-200"
                  }`}
                >
                  <AlertTriangle size={14} className={a.severity === "high" ? "text-red-500 mt-0.5" : "text-yellow-500 mt-0.5"} />
                  <div>
                    <span className="font-semibold text-slate-800 text-xs">Policy alert</span>
                    {a.dimension && (
                      <span className="ml-1 text-[10px] uppercase text-slate-400 bg-white px-1.5 py-0.5 rounded border border-gray-200">
                        {a.dimension}
                      </span>
                    )}
                    <p className="text-xs text-slate-600 mt-0.5">{a.message}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-4 gap-3">
            <div className="bg-slate-50 border border-gray-200 rounded-lg p-3">
              <div className="text-xs text-slate-500 uppercase">Traces</div>
              <div className="text-2xl font-bold text-slate-800">{report.total}</div>
            </div>
            <div className="bg-slate-50 border border-gray-200 rounded-lg p-3">
              <div className="text-xs text-slate-500 uppercase">Errors (≥400)</div>
              <div className={`text-2xl font-bold ${report.errors ? "text-red-600" : "text-slate-800"}`}>{report.errors}</div>
            </div>
            <div className="bg-slate-50 border border-gray-200 rounded-lg p-3">
              <div className="text-xs text-slate-500 uppercase">Avg latency</div>
              <div className="text-2xl font-bold text-slate-800">{report.avg_ms !== null ? `${report.avg_ms} ms` : "—"}</div>
            </div>
            <div className="bg-slate-50 border border-gray-200 rounded-lg p-3">
              <div className="text-xs text-slate-500 uppercase">Genome / Phenotype</div>
              <div className="text-2xl font-bold text-slate-800">
                🧬{report.breakdown_totals.genome} / 🧠{report.breakdown_totals.phenotype}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <h4 className="text-xs font-semibold text-slate-500 mb-1 uppercase">By route</h4>
              {Object.entries((report.by_route || {}) as any).map(([k, v]: any) => (
                <div key={k} className="flex justify-between border-b border-gray-100 py-1">
                  <span className="font-mono text-xs text-blue-600">{k}</span>
                  <span className="text-xs">{v}</span>
                </div>
              ))}
            </div>
            <div>
              <h4 className="text-xs font-semibold text-slate-500 mb-1 uppercase">By label</h4>
              {Object.entries((report.by_label || {}) as any).map(([k, v]: any) => (
                <div key={k} className="flex justify-between border-b border-gray-100 py-1">
                  <span className="text-xs">{k}</span>
                  <span className="text-xs">{v}</span>
                </div>
              ))}
            </div>
            <div>
              <h4 className="text-xs font-semibold text-slate-500 mb-1 uppercase">Sectors</h4>
              {Object.entries((report.breakdown_totals.sectors || {}) as any).map(([k, v]: any) => (
                <div key={k} className="flex justify-between border-b border-gray-100 py-1">
                  <span className="text-xs">{k}</span>
                  <span className="text-xs">{v}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-slate-500 mb-2 uppercase">Scores by dimension</h4>
            {Object.keys(report.score_stats || {}).length === 0 ? (
              <p className="text-xs text-slate-400">No scores in this window.</p>
            ) : (
              <div className="space-y-1">
                {Object.entries(report.score_stats).map(([dim, st]: any) => (
                  <div key={dim} className="flex items-center gap-3 border-b border-gray-100 py-1 text-sm">
                    <span className="font-mono text-xs text-slate-600 w-44">{dim}</span>
                    <ScorePill score={st.avg} good={facets.policy.good} bad={facets.policy.bad} />
                    <span className="text-xs text-slate-500">
                      avg · n={st.count} · min {st.min} · max {st.max}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-2 text-xs">
            <span className="px-2 py-1 rounded bg-emerald-100 text-emerald-700">good ≥ 0.7: {report.score_distribution.good}</span>
            <span className="px-2 py-1 rounded bg-yellow-100 text-yellow-700">medium 0.4–0.7: {report.score_distribution.medium}</span>
            <span className="px-2 py-1 rounded bg-red-100 text-red-700">bad &lt; 0.4: {report.score_distribution.bad}</span>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-slate-500 mb-2 uppercase">Lowest-scored traces (actionable)</h4>
            {report.worst.length === 0 ? (
              <p className="text-xs text-slate-400">None — no trace scored below 0.4 in this window.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-gray-200">
                    <th className="pb-2 pr-3">Time</th>
                    <th className="pb-2 pr-3">Route</th>
                    <th className="pb-2 pr-3">Dimension</th>
                    <th className="pb-2 pr-3">Score</th>
                    <th className="pb-2">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {report.worst.map((w: any, i: number) => (
                    <tr key={i} className="border-t border-gray-100">
                      <td className="py-2 pr-3 text-xs text-slate-500 whitespace-nowrap">{fmtTs(w.ts)}</td>
                      <td className="py-2 pr-3 font-mono text-xs text-blue-600">{w.route}</td>
                      <td className="py-2 pr-3 text-xs">{w.dimension}</td>
                      <td className="py-2 pr-3">
                        <ScorePill score={w.score} good={facets.policy.good} bad={facets.policy.bad} />
                      </td>
                      <td className="py-2 text-xs text-slate-600">{w.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Suggestions (deterministic remediation, grounded in report + live store health) */}
          {report.suggestions && report.suggestions.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-slate-500 mb-2 uppercase">Suggestions</h4>
              <div className="space-y-2">
                {report.suggestions.map((s: any, i: number) => (
                  <div
                    key={i}
                    className={`px-3 py-2 rounded-lg border text-sm ${
                      s.severity === "high"
                        ? "bg-red-50 border-red-200"
                        : s.severity === "medium"
                        ? "bg-yellow-50 border-yellow-200"
                        : "bg-blue-50 border-blue-200"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-800 text-xs">{s.title}</span>
                      {s.dimension && (
                        <span className="text-[10px] uppercase text-slate-400 bg-white px-1.5 py-0.5 rounded border border-gray-200">
                          {s.dimension}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-600 mt-1">{s.detail}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="grid grid-cols-6 gap-3 bg-white p-4 rounded-xl shadow-sm border border-gray-200">
        <select
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          value={filter.route}
          onChange={(e: any) => setF("route", e.target.value)}
        >
          <option value="">All routes</option>
          {facets.routes.map((r: string) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select className="px-3 py-2 border border-gray-300 rounded-lg text-sm" value={filter.direction} onChange={(e: any) => setF("direction", e.target.value)}>
          <option value="">All directions</option>
          <option value="in">IN (writes)</option>
          <option value="out">OUT (reads)</option>
          <option value="chat">Chat</option>
          <option value="system">System</option>
        </select>
        <select className="px-3 py-2 border border-gray-300 rounded-lg text-sm" value={filter.kind} onChange={(e: any) => setF("kind", e.target.value)}>
          <option value="">All kinds</option>
          <option value="write">write</option>
          <option value="read">read</option>
          <option value="chat">chat</option>
          <option value="action">action</option>
        </select>
        <select
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          value={filter.status}
          onChange={(e: any) => setF("status", e.target.value)}
        >
          <option value="">All statuses</option>
          {facets.statuses.map((s: string) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select className="px-3 py-2 border border-gray-300 rounded-lg text-sm" value={filter.scored} onChange={(e: any) => setF("scored", e.target.value)}>
          <option value="">All traces</option>
          <option value="true">Scored only</option>
          <option value="review">Needs review</option>
        </select>
        <select className="px-3 py-2 border border-gray-300 rounded-lg text-sm" value={filter.limit} onChange={(e: any) => setF("limit", e.target.value)}>
          <option value="50">50 rows</option>
          <option value="100">100 rows</option>
          <option value="250">250 rows</option>
          <option value="500">500 rows</option>
        </select>
      </div>

      {/* List */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
        {loading ? (
          <div className="text-sm text-slate-500">Loading traces...</div>
        ) : traces.length === 0 ? (
          <div className="text-sm text-slate-500">
            No traces match — memory traffic will appear here as Hermes / CLI / chat requests arrive.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-gray-200">
                <th className="pb-2 pr-3">Time</th>
                <th className="pb-2 pr-3">Route</th>
                <th className="pb-2 pr-3">Dir</th>
                <th className="pb-2 pr-3">Status</th>
                <th className="pb-2 pr-3">ms</th>
                <th className="pb-2 pr-3">Breakdown</th>
                <th className="pb-2 pr-3">Scores</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {traces.map((t: any) => (
                <tr
                  key={t.id}
                  onClick={() => openDetail(t.id)}
                  title="Click to view the full trace — score, delete, or add it to the calibration set"
                  className="border-t border-gray-100 cursor-pointer hover:bg-slate-50"
                >
                  <td className="py-2 pr-3 text-xs text-slate-500 whitespace-nowrap">{fmtTs(t.ts)}</td>
                  <td className="py-2 pr-3">
                    <span className="font-mono text-xs text-blue-600">{t.route}</span>
                    <span className="ml-2 text-xs text-slate-400">{t.label}</span>
                  </td>
                  <td className="py-2 pr-3">
                    <span className={`px-1.5 py-0.5 rounded text-xs ${dirBadge(t.direction)}`}>{t.direction.toUpperCase()}</span>
                  </td>
                  <td className="py-2 pr-3 text-xs">{t.status}</td>
                  <td className="py-2 pr-3 text-xs text-slate-500">{t.ms}</td>
                  <td className="py-2 pr-3 text-xs text-slate-600">
                    {t.breakdown
                      ? `🧬${t.breakdown.genome ?? 0} 🧠${t.breakdown.phenotype ?? 0}${
                          t.breakdown.sectors && Object.keys(t.breakdown.sectors).length
                            ? ` · ${Object.entries(t.breakdown.sectors)
                                .map(([k, v]) => `${k}:${v}`)
                                .join(" ")}`
                            : ""
                        }`
                      : t.injection
                      ? `inject ${t.injection.genome}/${t.injection.phenotype}`
                      : "—"}
                  </td>
                  <td className="py-2">
                    {scoreBadge(t.scores)}
                    {t.needs_review && (
                      <span className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-xs font-semibold">
                        <Flag size={10} /> needs review
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-2 text-slate-300 text-right">›</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Detail */}
      {selected && (
        <div ref={detailRef} className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold text-slate-800">
              Trace {selected.route}{" "}
              <span className="text-sm font-normal text-slate-400">({fmtTs(selected.ts)})</span>
            </h3>
            <div className="flex items-center gap-3">
              <select
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
                value={dimension}
                onChange={(e: any) => setDimension(e.target.value)}
              >
                <option value="recall_relevance">recall_relevance</option>
                <option value="extraction_fidelity">extraction_fidelity</option>
                <option value="answer_quality">answer_quality</option>
              </select>
              <button
                onClick={doScore}
                disabled={scoring}
                className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {scoring ? "Scoring..." : "Score now"}
              </button>
              <button
                onClick={() => setSelected(null)}
                className="px-3 py-2 bg-gray-100 text-gray-600 border border-gray-300 rounded-lg text-sm hover:bg-gray-200"
              >
                Close
              </button>
            </div>
          </div>

          {/* Trace actions: id, copy, delete, add-to-calibration */}
          <div className="flex items-center gap-2 flex-wrap bg-slate-50 border border-gray-200 rounded-lg px-3 py-2">
            <code className="text-xs text-slate-500 font-mono">{selected.id}</code>
            <button onClick={copyId} className="px-2 py-1 bg-white border border-gray-300 rounded text-xs text-slate-600 hover:bg-gray-100">
              Copy id
            </button>
            <button
              onClick={openCalForm}
              className={`px-2 py-1 rounded text-xs border ${
                calOpen ? "bg-blue-100 text-blue-700 border-blue-300" : "bg-white text-blue-600 border-blue-300 hover:bg-blue-50"
              }`}
            >
              Add to calibration
            </button>
            <button
              onClick={handleDeleteTrace}
              className="px-2 py-1 bg-red-50 text-red-600 border border-red-300 rounded text-xs hover:bg-red-100 ml-auto"
            >
              Delete trace
            </button>
          </div>

          {calOpen && (
            <div className="grid grid-cols-4 gap-2 bg-blue-50 border border-blue-200 rounded-lg p-3">
              <select className="px-2 py-2 border border-gray-300 rounded-lg text-sm" value={calDim} onChange={(e: any) => setCalDim(e.target.value)}>
                <option value="recall_relevance">recall_relevance</option>
                <option value="extraction_fidelity">extraction_fidelity</option>
                <option value="answer_quality">answer_quality</option>
              </select>
              <input
                className="px-2 py-2 border border-gray-300 rounded-lg text-sm"
                placeholder="Expected (0-1)"
                value={calExp}
                onChange={(e: any) => setCalExp(e.target.value)}
              />
              <input
                className="px-2 py-2 border border-gray-300 rounded-lg text-sm"
                placeholder="Note (why this label)"
                value={calNote}
                onChange={(e: any) => setCalNote(e.target.value)}
              />
              <button onClick={addCalForSelected} className="px-2 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
                Add
              </button>
            </div>
          )}
          {calMsg2 && (
            <div className={`px-3 py-2 rounded-lg text-sm ${calMsg2.ok ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
              {calMsg2.ok ? "✓ " : "✗ "}
              {calMsg2.text}
            </div>
          )}
          {scoreMsg && (
            <div
              className={`px-3 py-2 rounded-lg text-sm ${
                scoreMsg.ok ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
              }`}
            >
              {scoreMsg.ok ? "✓ " : "✗ "}
              {scoreMsg.text}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <h4 className="text-xs font-semibold text-slate-500 mb-1 uppercase">Request</h4>
              {jsonBlock(selected.request_body)}
            </div>
            <div>
              <h4 className="text-xs font-semibold text-slate-500 mb-1 uppercase">Response</h4>
              {jsonBlock(selected.response_body)}
            </div>
          </div>
          {selected.breakdown && (
            <div>
              <h4 className="text-xs font-semibold text-slate-500 mb-1 uppercase">Breakdown</h4>
              {jsonBlock(selected.breakdown)}
            </div>
          )}
          {selected.injection && (
            <div>
              <h4 className="text-xs font-semibold text-slate-500 mb-1 uppercase">Injection</h4>
              {jsonBlock(selected.injection)}
            </div>
          )}
          {selected.scores && selected.scores.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-slate-500 mb-1 uppercase">Scores</h4>
              <div className="space-y-2">
                {selected.scores.map((x: any, i: number) => (
                  <div key={i} className="flex items-start gap-3 bg-slate-50 border border-gray-200 rounded-lg p-3 text-xs">
                    <ScorePill score={x.score} good={facets.policy.good} bad={facets.policy.bad} />
                    <div>
                      <span className="font-semibold text-slate-700">{x.dimension}</span>
                      <span className="text-slate-400 ml-2">
                        {x.judge_model} · {fmtTs(x.ts)}
                      </span>
                      <p className="text-slate-600 mt-0.5">{x.reason}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {selected.error && (
            <div>
              <h4 className="text-xs font-semibold text-slate-500 mb-1 uppercase">Error</h4>
              <pre className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-3 overflow-auto">{selected.error}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GovernanceView() {
  // ── Calibration ──
  const [calEntries, setCalEntries] = useState([] as any[]);
  const [calLoading, setCalLoading] = useState(true);
  const [calForm, setCalForm] = useState({ trace_id: "", dimension: "recall_relevance", expected_score: "0.7", note: "" });
  const [calResult, setCalResult] = useState(null as any);
  const [calRunning, setCalRunning] = useState(false);
  const [calMsg, setCalMsg] = useState(null as any);
  // ── Consistency ──
  const [consistency, setConsistency] = useState(null as any);
  const [consistencyRunning, setConsistencyRunning] = useState(false);
  const [consSamples, setConsSamples] = useState("5");
  const [consRepeats, setConsRepeats] = useState("3");
  // ── Review queue ──
  const [reviewQueue, setReviewQueue] = useState([] as any[]);
  const [reviewLoading, setReviewLoading] = useState(true);
  // ── Inline trace viewer (click a row to open the trace) ──
  const [expanded, setExpanded] = useState(null as any); // {kind, id}
  const [expandedTrace, setExpandedTrace] = useState(null as any);
  const [expanding, setExpanding] = useState(false);

  const jsonBlock = (v: any) => {
    if (v === null || v === undefined) return <span className="text-xs text-slate-400">—</span>;
    let text: string;
    try {
      text = typeof v === "string" ? v : JSON.stringify(v, null, 2);
    } catch {
      text = String(v);
    }
    if (text.length > 60000) text = text.slice(0, 60000) + "\n… (truncated)";
    return (
      <pre className="text-xs text-slate-700 bg-slate-50 border border-gray-200 rounded-lg p-3 max-h-96 overflow-auto whitespace-pre-wrap break-all">
        {text}
      </pre>
    );
  };

  const toggleExpand = async (kind: string, id: string) => {
    if (expanded && expanded.kind === kind && expanded.id === id) {
      setExpanded(null);
      setExpandedTrace(null);
      return;
    }
    setExpanded({ kind, id });
    setExpanding(true);
    setExpandedTrace(null);
    try {
      const res = await fetch(`${API_BASE}/traces/${id}`);
      if (res.ok) {
        const d = await res.json();
        setExpandedTrace(d.trace);
      }
    } catch {
      // ignore
    } finally {
      setExpanding(false);
    }
  };

  const copyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      // ignore
    }
  };

  const loadCalibration = useCallback(async () => {
    setCalLoading(true);
    try {
      const res = await fetch("/api/dashboard/judge/calibration");
      if (res.ok) {
        const d = await res.json();
        setCalEntries(d.entries || []);
      }
    } catch {
      // ignore
    } finally {
      setCalLoading(false);
    }
  }, []);

  const loadReviewQueue = useCallback(async () => {
    setReviewLoading(true);
    try {
      const res = await fetch(`${API_BASE}/traces?review=1&limit=20`);
      if (res.ok) {
        const d = await res.json();
        setReviewQueue(d.traces || []);
      }
    } catch {
      // ignore
    } finally {
      setReviewLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCalibration();
    loadReviewQueue();
  }, [loadCalibration, loadReviewQueue]);

  const addCal = async () => {
    setCalMsg(null);
    try {
      const res = await fetch("/api/dashboard/judge/calibration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trace_id: calForm.trace_id.trim(),
          dimension: calForm.dimension,
          expected_score: Number(calForm.expected_score),
          note: calForm.note || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setCalForm({ trace_id: "", dimension: "recall_relevance", expected_score: "0.7", note: "" });
        setCalMsg({ ok: true, text: "Calibration entry added." });
        loadCalibration();
      } else {
        setCalMsg({ ok: false, text: (data && (data.msg || data.error)) || "Add failed" });
      }
    } catch (e: any) {
      setCalMsg({ ok: false, text: String(e) });
    }
  };

  const delCal = async (id: string) => {
    try {
      await fetch(`/api/dashboard/judge/calibration/${id}`, { method: "DELETE" });
      loadCalibration();
    } catch {
      // ignore
    }
  };

  const runCal = async () => {
    setCalRunning(true);
    setCalResult(null);
    try {
      const res = await fetch("/api/dashboard/judge/run-calibration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tolerance: 0.15 }),
      });
      if (res.ok) setCalResult(await res.json());
    } catch {
      // ignore
    } finally {
      setCalRunning(false);
    }
  };

  const runCons = async () => {
    setConsistencyRunning(true);
    setConsistency(null);
    try {
      const res = await fetch("/api/dashboard/judge/consistency", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ samples: Number(consSamples) || 5, repeats: Number(consRepeats) || 3 }),
      });
      if (res.ok) setConsistency(await res.json());
    } catch {
      // ignore
    } finally {
      setConsistencyRunning(false);
    }
  };

  const reviewOne = async (id: string) => {
    try {
      await fetch(`${API_BASE}/traces/${id}/review`, { method: "POST" });
      loadReviewQueue();
    } catch {
      // ignore
    }
  };

  const fmtTs = (ts: string) => {
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return ts;
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-800">Judge Governance</h2>
        <p className="text-sm text-slate-500 mt-1">
          The "trust the judge" checkpoint — calibration vs human labels, score stability, and the review queue. No
          score should drive an action (auto-heal, repair, delete) until these are green.
        </p>
      </div>

      {/* Calibration */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 space-y-4">
        <div className="flex justify-between items-center">
          <h3 className="text-lg font-semibold text-slate-800">Judge Calibration</h3>
          <button
            onClick={runCal}
            disabled={calRunning || calEntries.length === 0}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {calRunning ? "Scoring..." : "Run calibration"}
          </button>
        </div>
        <p className="text-xs text-slate-400">
          Curated traces with HUMAN-LABELED expected scores. Running calibration re-scores each entry (fresh judge
          call, not persisted) and reports agreement within a 0.15 tolerance.
        </p>

        {calResult && (
          <div className="flex flex-wrap gap-3">
            <div className="px-3 py-2 rounded-lg bg-slate-50 border border-gray-200 text-sm">
              <span className="text-xs text-slate-500 uppercase block">Agreement</span>
              <span className={`text-xl font-bold ${calResult.agree_rate !== null && calResult.agree_rate >= 0.8 ? "text-emerald-600" : "text-red-600"}`}>
                {calResult.agree_rate !== null ? `${Math.round(calResult.agree_rate * 100)}%` : "—"}
              </span>
              <span className="text-xs text-slate-500 ml-1">({calResult.agree}/{calResult.checked})</span>
            </div>
            <div className="px-3 py-2 rounded-lg bg-slate-50 border border-gray-200 text-sm">
              <span className="text-xs text-slate-500 uppercase block">Avg abs error</span>
              <span className="text-xl font-bold text-slate-800">{calResult.avg_abs_error ?? "—"}</span>
            </div>
          </div>
        )}

        {/* Add form */}
        <div className="grid grid-cols-6 gap-3 bg-slate-50 border border-gray-200 rounded-lg p-3">
          <input
            className="col-span-2 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
            placeholder="Trace id (uuid)"
            value={calForm.trace_id}
            onChange={(e: any) => setCalForm({ ...calForm, trace_id: e.target.value })}
          />
          <select
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            value={calForm.dimension}
            onChange={(e: any) => setCalForm({ ...calForm, dimension: e.target.value })}
          >
            <option value="recall_relevance">recall_relevance</option>
            <option value="extraction_fidelity">extraction_fidelity</option>
            <option value="answer_quality">answer_quality</option>
          </select>
          <input
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            placeholder="Expected (0-1)"
            value={calForm.expected_score}
            onChange={(e: any) => setCalForm({ ...calForm, expected_score: e.target.value })}
          />
          <input
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            placeholder="Note (why this label)"
            value={calForm.note}
            onChange={(e: any) => setCalForm({ ...calForm, note: e.target.value })}
          />
          <button
            onClick={addCal}
            className="px-3 py-2 bg-slate-800 text-white rounded-lg text-sm hover:bg-slate-900"
          >
            Add
          </button>
        </div>
        {calMsg && (
          <div className={`px-3 py-2 rounded-lg text-sm ${calMsg.ok ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
            {calMsg.ok ? "✓ " : "✗ "}
            {calMsg.text}
          </div>
        )}

        {/* Calibration list */}
        {calLoading ? (
          <div className="text-sm text-slate-500">Loading calibration set...</div>
        ) : calEntries.length === 0 ? (
          <div className="text-sm text-slate-500">
            No calibration entries yet — add traces with your human-labeled expected scores. Pick traces from the
            Traces tab (copy the id from the detail view) that represent clearly good and clearly bad outcomes.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-gray-200">
                <th className="pb-2 pr-3">Trace</th>
                <th className="pb-2 pr-3">Dimension</th>
                <th className="pb-2 pr-3">Expected</th>
                <th className="pb-2 pr-3">Last actual</th>
                <th className="pb-2 pr-3">Note</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {calEntries.map((e: any) => {
                const last = (e.scores || []).filter((s: any) => s.dimension === e.dimension).pop();
                const match = last && Math.abs(last.score - e.expected_score) <= 0.15;
                return (
                  <tr key={e.id} className="border-t border-gray-100">
                    <td className="py-2 pr-3">
                      <button
                        onClick={() => toggleExpand("cal", e.trace_id)}
                        className="font-mono text-xs text-blue-600 hover:underline text-left"
                        title="Click to view the trace"
                      >
                        {e.route || "deleted trace"}
                      </button>
                      <button
                        onClick={() => copyId(e.trace_id)}
                        title="Copy trace id"
                        className="ml-2 text-[10px] text-slate-400 hover:text-slate-600 font-mono"
                      >
                        {e.trace_id.slice(0, 8)}…⧉
                      </button>
                      <span className="ml-2 text-xs text-slate-400">{fmtTs(e.ts)}</span>
                    </td>
                    <td className="py-2 pr-3 text-xs">{e.dimension}</td>
                    <td className="py-2 pr-3">
                      <ScorePill score={e.expected_score} />
                    </td>
                    <td className="py-2 pr-3">
                      {last ? (
                        <span className={`text-xs font-semibold ${match ? "text-emerald-600" : "text-red-600"}`}>
                          {last.score} {match ? "✓" : "✗"}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-500">{e.note || ""}</td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => delCal(e.id)}
                        className="text-xs text-red-500 hover:text-red-700"
                        title="Remove from calibration set"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Consistency */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 space-y-4">
        <div className="flex justify-between items-center">
          <h3 className="text-lg font-semibold text-slate-800">Score Consistency</h3>
          <div className="flex items-center gap-2">
            <input
              className="w-16 px-2 py-2 border border-gray-300 rounded-lg text-sm text-center"
              title="Sample size"
              value={consSamples}
              onChange={(e: any) => setConsSamples(e.target.value)}
            />
            <span className="text-xs text-slate-400">traces ×</span>
            <input
              className="w-14 px-2 py-2 border border-gray-300 rounded-lg text-sm text-center"
              title="Repeats"
              value={consRepeats}
              onChange={(e: any) => setConsRepeats(e.target.value)}
            />
            <span className="text-xs text-slate-400">repeats</span>
            <button
              onClick={runCons}
              disabled={consistencyRunning}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {consistencyRunning ? "Scoring..." : "Run consistency"}
            </button>
          </div>
        </div>
        <p className="text-xs text-slate-400">
          Re-scores a random sample N times (non-persisting). Low mean absolute deviation (MAD) = stable judge.
        </p>
        {consistency && (
          <div className="space-y-3">
            <div className="px-3 py-2 rounded-lg bg-slate-50 border border-gray-200 text-sm inline-block">
              <span className="text-xs text-slate-500 uppercase block">Overall MAD (mean abs dev)</span>
              <span className={`text-xl font-bold ${consistency.overall_mean_abs_dev !== null && consistency.overall_mean_abs_dev <= 0.1 ? "text-emerald-600" : consistency.overall_mean_abs_dev !== null && consistency.overall_mean_abs_dev <= 0.2 ? "text-yellow-600" : "text-red-600"}`}>
                {consistency.overall_mean_abs_dev ?? "—"}
              </span>
              <span className="text-xs text-slate-500 ml-1">({consistency.checked} traces × {consistency.repeats})</span>
            </div>
            {consistency.per_trace && consistency.per_trace.length > 0 && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-gray-200">
                    <th className="pb-2 pr-3">Route</th>
                    <th className="pb-2 pr-3">Dimension</th>
                    <th className="pb-2 pr-3">Scores</th>
                    <th className="pb-2 pr-3">Mean</th>
                    <th className="pb-2">MAD</th>
                  </tr>
                </thead>
                <tbody>
                  {consistency.per_trace.map((t: any, i: number) => (
                    <tr key={i} className="border-t border-gray-100">
                      <td className="py-2 pr-3 font-mono text-xs text-blue-600">{t.route}</td>
                      <td className="py-2 pr-3 text-xs">{t.dimension}</td>
                      <td className="py-2 pr-3 text-xs text-slate-600">{[...t.scores].sort((a, b) => a - b).join(", ")}</td>
                      <td className="py-2 pr-3 text-xs">{t.mean}</td>
                      <td className="py-2 text-xs font-semibold">{t.mad}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Review queue */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 space-y-3">
        <h3 className="text-lg font-semibold text-slate-800">
          Needs Review{" "}
          <span className="text-sm font-normal text-slate-400">(unreviewed traces scored below the bad threshold)</span>
        </h3>
        {reviewLoading ? (
          <div className="text-sm text-slate-500">Loading...</div>
        ) : reviewQueue.length === 0 ? (
          <div className="text-sm text-slate-500">Nothing pending — every low-scored trace has been reviewed.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-gray-200">
                <th className="pb-2 pr-3">Time</th>
                <th className="pb-2 pr-3">Route</th>
                <th className="pb-2 pr-3">Lowest score</th>
                <th className="pb-2 pr-3">Reason</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {reviewQueue.map((t: any) => {
                const low = (t.scores || []).reduce((a: any, b: any) => (b.score < a.score ? b : a), { score: 1 });
                return (
                  <tr key={t.id} className="border-t border-gray-100">
                    <td className="py-2 pr-3 text-xs text-slate-500 whitespace-nowrap">{fmtTs(t.ts)}</td>
                    <td className="py-2 pr-3">
                      <button
                        onClick={() => toggleExpand("review", t.id)}
                        className="font-mono text-xs text-blue-600 hover:underline text-left"
                        title="Click to view the trace"
                      >
                        {t.route}
                      </button>
                    </td>
                    <td className="py-2 pr-3">
                      <ScorePill score={low.score} />
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-600">{(low.reason || "").slice(0, 90)}</td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => reviewOne(t.id)}
                        className="px-3 py-1.5 bg-blue-50 text-blue-700 border border-blue-300 rounded-lg text-xs hover:bg-blue-100"
                      >
                        Mark reviewed
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="text-xs text-slate-400">
          Opening a flagged trace in the Traces tab also clears its flag automatically.
        </p>
      </div>

      {/* Inline trace viewer — click any route link above to open the trace here */}
      {expanding && <div className="text-sm text-slate-500">Loading trace...</div>}
      {expanded && expandedTrace && (
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 space-y-3">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold text-slate-800">Trace {expandedTrace.route}</h3>
            <button
              onClick={() => {
                setExpanded(null);
                setExpandedTrace(null);
              }}
              className="px-3 py-2 bg-gray-100 text-gray-600 border border-gray-300 rounded-lg text-sm hover:bg-gray-200"
            >
              Close
            </button>
          </div>
          <div className="text-xs text-slate-500">
            <code className="font-mono">{expandedTrace.id}</code> · {fmtTs(expandedTrace.ts)} · {expandedTrace.label} ·
            status {expandedTrace.status} · {expandedTrace.ms}ms
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <h4 className="text-xs font-semibold text-slate-500 mb-1 uppercase">Request</h4>
              {jsonBlock(expandedTrace.request_body)}
            </div>
            <div>
              <h4 className="text-xs font-semibold text-slate-500 mb-1 uppercase">Response</h4>
              {jsonBlock(expandedTrace.response_body)}
            </div>
          </div>
          {expandedTrace.breakdown && (
            <div>
              <h4 className="text-xs font-semibold text-slate-500 mb-1 uppercase">Breakdown</h4>
              {jsonBlock(expandedTrace.breakdown)}
            </div>
          )}
          {expandedTrace.scores && expandedTrace.scores.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-slate-500 mb-1 uppercase">Scores</h4>
              <div className="space-y-2">
                {expandedTrace.scores.map((x: any, i: number) => (
                  <div key={i} className="flex items-start gap-3 bg-slate-50 border border-gray-200 rounded-lg p-3 text-xs">
                    <ScorePill score={x.score} />
                    <div>
                      <span className="font-semibold text-slate-700">{x.dimension}</span>
                      <span className="text-slate-400 ml-2">
                        {x.judge_model} · {fmtTs(x.ts)}
                      </span>
                      <p className="text-slate-600 mt-0.5">{x.reason}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SettingsView() {
  const emptyForm = () => ({
    provider: { type: "openai-compatible", host: "", port: "" },
    generative: {
      provider: { host: "", port: "" },
      model: "",
      extraction: "",
      compaction: "",
      consolidation: "",
    },
    embedding: {
      provider: { host: "", port: "" },
      model: "",
      episodic: "",
      semantic: "",
      procedural: "",
      emotional: "",
      reflective: "",
    },
    judge: {
      provider: { type: "openai-compatible", host: "", port: "" },
      model: "",
      api_key: "",
    },
    general: {},
    advanced: {},
  });

  const [form, setForm] = useState(emptyForm() as any);
  const [resolved, setResolved] = useState(null as any);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState("" as string);
  const [testResult, setTestResult] = useState(null as any);
  const [genOverride, setGenOverride] = useState(false);
  const [embOverride, setEmbOverride] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null as any);

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = await res.json();
        setForm(data.settings);
        setResolved(data.resolved);
        setGenOverride(!!data.settings.generative.provider.host);
        setEmbOverride(!!data.settings.embedding.provider.host);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const set = (path: string[], value: string) => {
    setForm((prev: any) => {
      const next = JSON.parse(JSON.stringify(prev));
      let cur = next;
      for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
      cur[path[path.length - 1]] = value;
      return next;
    });
  };

  const baseUrlPreview = (host: string, port: string) =>
    host ? `http://${host}${port ? `:${port}` : ""}/v1` : "http://<host>:<port>/v1";

  const runTest = async (section: string) => {
    setTesting(section);
    setTestResult(null);
    try {
      const settingsBody = JSON.parse(JSON.stringify(form));
      delete settingsBody.advanced; // advanced is read-only display
      const res = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section, settings: settingsBody }),
      });
      const data = await res.json();
      setTestResult({ section, ...data });
      loadSettings();
    } catch (e: any) {
      setTestResult({ section, ok: false, error: String(e) });
    } finally {
      setTesting("");
    }
  };

  const saveAll = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const body = JSON.parse(JSON.stringify(form));
      delete body.advanced; // advanced is read-only display
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setSaveMsg({ ok: true, text: "Settings saved — applied now where runtime-read, fully at next restart." });
        loadSettings();
      } else {
        setSaveMsg({ ok: false, text: (data && (data.error || data.message)) || "Save failed" });
      }
    } catch (e: any) {
      setSaveMsg({ ok: false, text: String(e) });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-slate-500">Loading settings...</div>;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-slate-800">Settings</h2>
      <p className="text-sm text-slate-500 -mt-3">
        Single source of truth for providers and models — no defaults, no fallbacks, nothing hardcoded.
        Test &amp; Save validates a section with a live request and applies changes immediately.
      </p>

      {/* Provider Settings */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
        <h3 className="text-lg font-semibold text-slate-800 mb-4">Provider Settings</h3>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className={settingsLabelCls}>Provider Type</label>
            <select
              className={settingsInputCls}
              value={form.provider.type}
              onChange={(e: any) => set(["provider", "type"], e.target.value)}
            >
              <option value="openai-compatible">OpenAI Compatible</option>
            </select>
          </div>
          <SettingsField
            label="URL (IP or hostname)"
            value={form.provider.host}
            onChange={(v: string) => set(["provider", "host"], v)}
            placeholder="10.10.10.41"
          />
          <SettingsField
            label="Port"
            value={form.provider.port}
            onChange={(v: string) => set(["provider", "port"], v)}
            placeholder="8080"
          />
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Base URL: <code className="text-blue-600">{baseUrlPreview(form.provider.host, form.provider.port)}</code>
        </p>
      </div>

      {/* Generative Models */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-slate-800">Generative Models</h3>
          <button
            onClick={() => runTest("generative")}
            disabled={!!testing}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            <FlaskConical size={16} /> {testing === "generative" ? "Testing..." : "Test & Save"}
          </button>
        </div>
        <p className="text-xs text-slate-400 mb-4">
          Setting the master <b>Generative Model</b> populates the function models below; per-function values override it.
          {resolved?.generative
            ? ` Currently resolving: ${resolved.generative.model || "— unset —"} @ ${resolved.providerUrl || "— unset —"}`
            : ""}
        </p>
        <div className="grid grid-cols-2 gap-4">
          <SettingsField
            label="Generative Model"
            value={form.generative.model}
            onChange={(v: string) => set(["generative", "model"], v)}
            placeholder="e.g. Gemma-4-12B-no-thinking"
          />
          <SettingsField
            label="Extraction Model"
            value={form.generative.extraction}
            onChange={(v: string) => set(["generative", "extraction"], v)}
            placeholder="(uses master if empty)"
          />
          <SettingsField
            label="Compaction Model"
            value={form.generative.compaction}
            onChange={(v: string) => set(["generative", "compaction"], v)}
            placeholder="(uses master if empty)"
          />
          <SettingsField
            label="Consolidation Model"
            value={form.generative.consolidation}
            onChange={(v: string) => set(["generative", "consolidation"], v)}
            placeholder="(uses master if empty)"
          />
        </div>
        <div className="mt-4">
          <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
            <input type="checkbox" checked={genOverride} onChange={(e: any) => setGenOverride(e.target.checked)} />
            Use a different provider for Generative models
          </label>
          {genOverride && (
            <div className="grid grid-cols-2 gap-4 mt-3">
              <SettingsField
                label="Gen Provider URL"
                value={form.generative.provider.host}
                onChange={(v: string) => set(["generative", "provider", "host"], v)}
                placeholder="10.10.10.41"
              />
              <SettingsField
                label="Gen Provider Port"
                value={form.generative.provider.port}
                onChange={(v: string) => set(["generative", "provider", "port"], v)}
                placeholder="8080"
              />
            </div>
          )}
        </div>
        <SettingsResultBadge result={testResult && testResult.section === "generative" ? testResult : null} />
      </div>

      {/* Embedding Models */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-slate-800">Embedding Models</h3>
          <button
            onClick={() => runTest("embedding")}
            disabled={!!testing}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            <FlaskConical size={16} /> {testing === "embedding" ? "Testing..." : "Test & Save"}
          </button>
        </div>
        <p className="text-xs text-slate-400 mb-4">
          Setting the master <b>Embedding Model</b> populates all facets; per-facet values override it.
          {resolved?.embedding
            ? ` Currently resolving: ${resolved.embedding.model || "— unset —"} @ ${resolved.providerUrl || "— unset —"}`
            : ""}
        </p>
        <div className="grid grid-cols-2 gap-4">
          <SettingsField
            label="Embedding Model"
            value={form.embedding.model}
            onChange={(v: string) => set(["embedding", "model"], v)}
            placeholder="e.g. Nomic-Embed-Text-v1.5"
          />
          <SettingsField
            label="Episodic Model"
            value={form.embedding.episodic}
            onChange={(v: string) => set(["embedding", "episodic"], v)}
            placeholder="(uses master if empty)"
          />
          <SettingsField
            label="Semantic Model"
            value={form.embedding.semantic}
            onChange={(v: string) => set(["embedding", "semantic"], v)}
            placeholder="(uses master if empty)"
          />
          <SettingsField
            label="Procedural Model"
            value={form.embedding.procedural}
            onChange={(v: string) => set(["embedding", "procedural"], v)}
            placeholder="(uses master if empty)"
          />
          <SettingsField
            label="Emotional Model"
            value={form.embedding.emotional}
            onChange={(v: string) => set(["embedding", "emotional"], v)}
            placeholder="(uses master if empty)"
          />
          <SettingsField
            label="Reflective Model"
            value={form.embedding.reflective}
            onChange={(v: string) => set(["embedding", "reflective"], v)}
            placeholder="(uses master if empty)"
          />
        </div>
        <div className="mt-4">
          <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
            <input type="checkbox" checked={embOverride} onChange={(e: any) => setEmbOverride(e.target.checked)} />
            Use a different provider for Embedding models
          </label>
          {embOverride && (
            <div className="grid grid-cols-2 gap-4 mt-3">
              <SettingsField
                label="Emb Provider URL"
                value={form.embedding.provider.host}
                onChange={(v: string) => set(["embedding", "provider", "host"], v)}
                placeholder="10.10.10.41"
              />
              <SettingsField
                label="Emb Provider Port"
                value={form.embedding.provider.port}
                onChange={(v: string) => set(["embedding", "provider", "port"], v)}
                placeholder="8080"
              />
            </div>
          )}
        </div>
        <SettingsResultBadge result={testResult && testResult.section === "embedding" ? testResult : null} />
      </div>

      {/* Judge Model (trace scoring) — fully independent provider */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-slate-800">Judge Model (trace scoring)</h3>
          <button
            onClick={() => runTest("judge")}
            disabled={!!testing}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            <FlaskConical size={16} /> {testing === "judge" ? "Testing..." : "Test & Save"}
          </button>
        </div>
        <p className="text-xs text-slate-400 mb-4">
          Fully independent model/provider for scoring traces — deliberately NOT tied to the generative chain, so judging never
          contends with the active chat's generative model. Point it at a separate llama-swap box if you have one.
          {resolved?.judge
            ? ` Currently resolving: ${resolved.judge.model || "— unset —"} @ ${resolved.judge.providerUrl || "— unset —"}`
            : ""}
        </p>
        <div className="grid grid-cols-2 gap-4">
          <SettingsField
            label="Judge Model"
            value={form.judge.model}
            onChange={(v: string) => set(["judge", "model"], v)}
            placeholder="e.g. Gemma-4-26B-A4B-MTP"
          />
          <SettingsField
            label="API Key (optional)"
            value={form.judge.api_key}
            onChange={(v: string) => set(["judge", "api_key"], v)}
            placeholder="(empty if no key needed)"
          />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4">
          <SettingsField
            label="Judge Provider URL"
            value={form.judge.provider.host}
            onChange={(v: string) => set(["judge", "provider", "host"], v)}
            placeholder="10.10.10.41"
          />
          <SettingsField
            label="Judge Provider Port"
            value={form.judge.provider.port}
            onChange={(v: string) => set(["judge", "provider", "port"], v)}
            placeholder="8080"
          />
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Base URL: <code className="text-blue-600">{baseUrlPreview(form.judge.provider.host, form.judge.provider.port)}</code>
        </p>
        <SettingsResultBadge result={testResult && testResult.section === "judge" ? testResult : null} />
      </div>

      {/* General Settings */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
        <div className="flex justify-between items-center mb-2">
          <h3 className="text-lg font-semibold text-slate-800">General Settings</h3>
          <button
            onClick={saveAll}
            disabled={saving}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            <Save size={16} /> {saving ? "Saving..." : "Save"}
          </button>
        </div>
        <p className="text-xs text-slate-400 mb-4">
          Operational knobs once set via .env. Empty = engine default. Saved to the settings store and
          applied at boot (and immediately for runtime-read values).
        </p>
        <div className="grid grid-cols-2 gap-x-8 gap-y-5">
          {GENERAL_GROUPS.map((g: any) => (
            <div key={g.title}>
              <h4 className="text-sm font-semibold text-slate-700 mb-2 border-b border-gray-100 pb-1">
                {g.title}
              </h4>
              <div className="space-y-3">
                {g.fields.map((f: any) => (
                  <GeneralField
                    key={f[0]}
                    label={f[1]}
                    type={f[2]}
                    value={form.general[f[0]] || ""}
                    onChange={(v: string) => set(["general", f[0]], v)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        {saveMsg && (
          <div
            className={`mt-4 px-3 py-2 rounded-lg text-sm ${
              saveMsg.ok ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
            }`}
          >
            {saveMsg.ok ? "✓ " : "✗ "}
            {saveMsg.text}
          </div>
        )}

        {/* Advanced Settings */}
        <div className="mt-6 pt-4 border-t border-gray-100">
          <h4 className="text-sm font-semibold text-slate-700 mb-2">Advanced Settings</h4>
          <div className="mb-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs">
            ⚠️ <b>Advanced settings</b> — shown for visibility only; they are read from the .env /
            container environment and <b>cannot be edited here</b>. Do not change these unless
            necessary. Database/Redis values are read at startup, before the settings store is
            available — change them in .env / docker-compose and recreate the container.
          </div>
          <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
            <tbody>
              {ADVANCED_GROUPS.map((g: any) => (
                <React.Fragment key={g.title}>
                  <tr className="bg-gray-50">
                    <td colSpan={2} className="px-3 py-2 text-xs font-semibold text-slate-600">
                      {g.title}
                    </td>
                  </tr>
                  {g.fields.map((f: any) => (
                    <tr key={f[0]} className="border-t border-gray-100">
                      <td className="px-3 py-1.5 text-xs text-slate-500 w-1/2">{f[1]}</td>
                      <td className="px-3 py-1.5">
                        <code className="text-xs text-slate-700 break-all">
                          {form.advanced[f[0]] || "—"}
                        </code>
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
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

  // Newest logs at the top (the log file is oldest-first)
  const displayLogs = [...filteredLogs].reverse();

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
            displayLogs.map((line: string, idx: number) => {
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


/* ───────── llama-swap perf shapes (Ollama kept below for future selectable source) ───────── */

interface LlamaSwapGpu {
  id: string;
  name: string;
  util_percent: number;
  memory_util_percent: number;
  memory_used_bytes: number;
  memory_total_bytes: number;
  memory_used_percent: number;
  temperature_celsius: number;
  vram_temperature_celsius: number;
  power_draw_watts: number;
  fan_speed_percent: number;
}

interface LlamaSwapMetrics {
  source: string;
  available: boolean;
  error?: string;
  system?: {
    cpu_percent: number;
    memory_percent: number;
    memory_total_bytes: number;
    memory_used_bytes: number;
    load_avg?: { "1m": number; "5m": number; "15m": number };
  };
  gpus?: LlamaSwapGpu[];
  vram?: { total_bytes: number; used_bytes: number; used_percent: number };
}

/* ───────── Ollama perf shapes (DORMANT — kept for future user-selectable source) ─────────
   Some deployments run plain Ollama instead of llama-swap. The Performance tab is wired to
   llama-swap today; when a "metrics source" selector is added, this interface and the
   /api/performance/ollama endpoint (whitelisted in auth.ts) can back it. Left here
   intentionally so the switch is a wiring change, not a rewrite.
*/

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

/* ───────── Performance Monitor (llama-swap source) ─────────
   Metrics are pulled from the Engram backend's /api/performance/llama-swap
   endpoint, which scrapes the llama-swap Prometheus /metrics endpoint.
   Not every deployment runs llama-swap (some use Ollama/OpenAI directly),
   so when llama-swap is unavailable we degrade gracefully: system CPU/RAM/Disk
   still come from the Engram host (/api/performance/system) and a notice is shown.
   The OllamaMetrics interface and the commented ollama branch below are left in
   place so a future "source" selector can re-enable an Ollama path without
   rewriting the component.
*/

function PerformanceMonitor() {
  const [sysMetrics, setSysMetrics] = useState(null as any);
  const [lsMetrics, setLsMetrics] = useState(null as LlamaSwapMetrics | null);
  const [history, setHistory] = useState([] as PerfHistoryPoint[]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null as string | null);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const [sysRes, lsRes] = await Promise.all([
        fetch("/api/performance/system"),
        fetch("/api/performance/llama-swap"),
      ]);
      if (!sysRes.ok) throw new Error("Failed to fetch system metrics");
      const sysData = await sysRes.json();
      setSysMetrics(sysData);

      // ── Future: user-selectable source. Example ollama branch (left dormant):
      // const ollRes = await fetch("/api/performance/ollama");
      // if (ollRes.ok) setOllamaMetrics(await ollRes.json());

      if (lsRes.ok) {
        const lsData = await lsRes.json();
        setLsMetrics(lsData);
        if (lsData.available && lsData.system) {
          setHistory((prev: PerfHistoryPoint[]) =>
            [...prev, {
              ts: Date.now(),
              cpu: lsData.system.cpu_percent,
              mem: lsData.system.memory_percent,
            }].slice(-HISTORY_MAX),
          );
        }
      } else {
        setLsMetrics({ source: "llama-swap", available: false, error: "HTTP " + lsRes.status });
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

  if (error && history.length === 0 && !lsMetrics) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400">
        <p className="mb-4">{error}</p>
        <button onClick={fetchData} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-white transition-color">
          Retry
        </button>
      </div>
    );
  }

  const cpuPercent = sysMetrics?.cpu_percent ?? (history.length ? history[history.length - 1].cpu : 0);
  const memPercent = sysMetrics?.memory_percent ?? (history.length ? history[history.length - 1].mem : 0);
  const diskPercent = sysMetrics?.disk_percent ?? 0;
  const load1 = sysMetrics?.load_avg_1m ?? 0;
  const load5 = sysMetrics?.load_avg_5m ?? 0;
  const load15 = sysMetrics?.load_avg_15m ?? 0;
  const vramTotal = lsMetrics?.vram?.total_bytes ?? 0;
  const vramUsed = lsMetrics?.vram?.used_bytes ?? 0;
  const vramPercent = lsMetrics?.vram?.used_percent ?? 0;
  const gpus = lsMetrics?.gpus ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Performance Monitor</h2>
          <p className="text-sm text-gray-500 mt-1">
            Live system &amp; GPU metrics &bull; Source: llama-swap &bull; Auto-refresh every 5s
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

      {lsMetrics && !lsMetrics.available && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-300">
          llama-swap metrics unavailable: {lsMetrics.error || "unknown error"}. The server could not reach the
          llama-swap /metrics endpoint. CPU/RAM/Disk above come from the Engram host.
        </div>
      )}

      <SparklineChart data={history} label="CPU &amp; Memory (llama-swap)" color="blue" />

      <h3 className="text-lg font-semibold text-white mb-4">System</h3>
      <div className="grid grid-cols-2 gap-4 mb-8">
        <MetricCard icon={<Cpu size={18} />} label="CPU Usage" value={cpuPercent.toFixed(1) + "%"} color="blue" />
        <MetricCard
          icon={<Zap size={18} />}
          label="Memory"
          value={memPercent.toFixed(1) + "%"}
          sublabel={formatBytes(sysMetrics?.memory_used_mb ? sysMetrics.memory_used_mb * 1024 * 1024 : 0) + " / " + formatBytes(sysMetrics?.memory_total_mb ? sysMetrics.memory_total_mb * 1024 * 1024 : 0)}
          color="green"
        />
        <MetricCard
          icon={<HardDrive size={18} />}
          label="Disk Usage"
          value={diskPercent.toFixed(1) + "%"}
          sublabel={formatBytes(sysMetrics?.disk_used_gb ? sysMetrics.disk_used_gb * 1024 ** 3 : 0) + " / " + formatBytes(sysMetrics?.disk_total_gb ? sysMetrics.disk_total_gb * 1024 ** 3 : 0)}
          color="amber"
        />
        <MetricCard
          icon={<Activity size={18} />}
          label="Load Average"
          value={load1.toFixed(2)}
          sublabel={"1m: " + load1.toFixed(2) + " • 5m: " + load5.toFixed(2) + " • 15m: " + load15.toFixed(2)}
          color="purple"
        />
      </div>

      <div className="grid grid-cols-4 gap-6 mb-8">
        <div>
          <div className="flex justify-between text-sm mb-1"><span className="text-gray-400">CPU</span><span className="text-white">{cpuPercent.toFixed(1)}%</span></div>
          <ProgressBar percent={cpuPercent} color={cpuPercent > 90 ? "bg-red-500" : cpuPercent > 70 ? "bg-amber-500" : "bg-blue-500"} />
        </div>
        <div>
          <div className="flex justify-between text-sm mb-1"><span className="text-gray-400">Memory</span><span className="text-white">{memPercent.toFixed(1)}%</span></div>
          <ProgressBar percent={memPercent} color={memPercent > 90 ? "bg-red-500" : memPercent > 70 ? "bg-amber-500" : "bg-emerald-500"} />
        </div>
        <div>
          <div className="flex justify-between text-sm mb-1"><span className="text-gray-400">Disk</span><span className="text-white">{diskPercent.toFixed(1)}%</span></div>
          <ProgressBar percent={diskPercent} color={diskPercent > 90 ? "bg-red-500" : diskPercent > 70 ? "bg-amber-500" : "bg-purple-500"} />
        </div>
        <div>
          <div className="flex justify-between text-sm mb-1"><span className="text-gray-400">GPU VRAM</span><span className="text-white">{vramPercent.toFixed(1)}%</span></div>
          <ProgressBar percent={vramPercent} color={vramPercent > 90 ? "bg-red-500" : vramPercent > 70 ? "bg-amber-500" : "bg-cyan-500"} />
        </div>
      </div>

      <h3 className="text-lg font-semibold text-white mb-4">GPUs (llama-swap)</h3>
      {gpus.length === 0 ? (
        <p className="text-sm text-slate-400">No GPU telemetry reported by llama-swap.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
          {gpus.map((g: LlamaSwapGpu) => (
            <div key={g.id} className="rounded-xl border border-gray-700 bg-gray-900/50 p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-medium text-white">{g.name}</span>
                <span className="text-xs text-gray-400">{g.id}</span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-gray-400">GPU Util</span><div className="text-white">{g.util_percent.toFixed(1)}%</div></div>
                <div><span className="text-gray-400">Mem Util</span><div className="text-white">{g.memory_util_percent.toFixed(1)}%</div></div>
                <div><span className="text-gray-400">VRAM</span><div className="text-white">{formatBytes(g.memory_used_bytes)} / {formatBytes(g.memory_total_bytes)} ({g.memory_used_percent.toFixed(1)}%)</div></div>
                <div><span className="text-gray-400">Temp</span><div className="text-white">{g.temperature_celsius}&deg;C</div></div>
                <div><span className="text-gray-400">VRAM Temp</span><div className="text-white">{g.vram_temperature_celsius}&deg;C</div></div>
                <div><span className="text-gray-400">Power</span><div className="text-white">{g.power_draw_watts} W</div></div>
                <div><span className="text-gray-400">Fan</span><div className="text-white">{g.fan_speed_percent}%</div></div>
              </div>
            </div>
          ))}
        </div>
      )}

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

// ─── Mind Map (read-only semantic proximity view) ───────────────────────────────
const SECTOR_COLORS: Record<string, string> = {
  semantic: "#3b82f6",
  procedural: "#10b981",
  episodic: "#f59e0b",
  emotional: "#ef4444",
  reflective: "#a855f7",
  unknown: "#94a3b8",
};

function MemoryGraphView() {
  const canvasRef = useRef(null);
  const [graph, setGraph] = useState(null as { nodes: any[]; edges: any[] } | null);
  const [loading, setLoading] = useState(false);
  const [minSim, setMinSim] = useState(0.7);
  const [limit, setLimit] = useState(120);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ min_sim: String(minSim), limit: String(limit) });
      const res = await fetch(`/api/memory-graph?${params}`);
      if (res.ok) {
        const data = await res.json();
        setGraph({ nodes: data.nodes || [], edges: data.edges || [] });
      }
    } catch {
      // ignore — empty state handles it
    } finally {
      setLoading(false);
    }
  }, [minSim, limit]);

  useEffect(() => { load(); }, [load]);

  // Force-directed layout on a canvas (self-contained, no d3).
  useEffect(() => {
    if (!graph || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx2d = canvas.getContext("2d");
    const W = canvas.width = 900;
    const H = canvas.height = 600;
    const nodes = graph.nodes.map((n: any, i: number) => ({
      ...n,
      x: W / 2 + Math.cos((i / graph.nodes.length) * Math.PI * 2) * 200,
      y: H / 2 + Math.sin((i / graph.nodes.length) * Math.PI * 2) * 200,
      vx: 0, vy: 0,
    }));
    const idIndex = new Map(nodes.map((n: any, i: number) => [n.id, i]));
    const edges = graph.edges
      .filter((e: any) => idIndex.has(e.source) && idIndex.has(e.target))
      .map((e: any) => ({ s: idIndex.get(e.source)!, t: idIndex.get(e.target)!, w: e.similarity }));

    let raf = 0;
    let frame = 0;
    const step = () => {
      frame++;
      // repulsion
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const d2 = dx * dx + dy * dy + 0.01;
          const f = 1200 / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          nodes[i].vx += fx; nodes[i].vy += fy;
          nodes[j].vx -= fx; nodes[j].vy -= fy;
        }
      }
      // attraction along edges
      for (const e of edges) {
        const a = nodes[e.s], b = nodes[e.t];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
        const f = (d - 80) * 0.02 * (0.5 + e.w);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
      // gravity to center + integrate
      for (const n of nodes) {
        n.vx += (W / 2 - n.x) * 0.005;
        n.vy += (H / 2 - n.y) * 0.005;
        n.vx *= 0.85; n.vy *= 0.85;
        n.x += n.vx; n.y += n.vy;
        n.x = Math.max(20, Math.min(W - 20, n.x));
        n.y = Math.max(20, Math.min(H - 20, n.y));
      }
      // draw
      ctx2d.clearRect(0, 0, W, H);
      ctx2d.fillStyle = "#0f172a";
      ctx2d.fillRect(0, 0, W, H);
      for (const e of edges) {
        const a = nodes[e.s], b = nodes[e.t];
        ctx2d.strokeStyle = `rgba(148,163,184,${0.15 + e.w * 0.5})`;
        ctx2d.lineWidth = 0.5 + e.w * 2;
        ctx2d.beginPath();
        ctx2d.moveTo(a.x, a.y);
        ctx2d.lineTo(b.x, b.y);
        ctx2d.stroke();
      }
      for (const n of nodes) {
        const r = 4 + n.importance_score * 12;
        const color = SECTOR_COLORS[n.sector] || SECTOR_COLORS.unknown;
        ctx2d.globalAlpha = n.superseded ? 0.35 : 1;
        ctx2d.fillStyle = color;
        ctx2d.beginPath();
        ctx2d.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.globalAlpha = 1;
        if (n === hoverNode) {
          ctx2d.fillStyle = "#e2e8f0";
          ctx2d.font = "11px sans-serif";
          ctx2d.fillText(n.label, n.x + r + 4, n.y + 3);
        }
      }
      // stop settling after a while
      if (frame < 400) raf = requestAnimationFrame(step);
    };
    let hoverNode: any = null;
    canvas.onmousemove = (ev: any) => {
      const rect = canvas.getBoundingClientRect();
      const mx = (ev.clientX - rect.left) * (W / rect.width);
      const my = (ev.clientY - rect.top) * (H / rect.height);
      hoverNode = nodes.find((n: any) => Math.hypot(n.x - mx, n.y - my) < 12 + n.importance_score * 12) || null;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [graph]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-100">Memory Mind Map</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Semantic proximity &mdash; edges are cosine similarity between memory embeddings, not inferred relationships.
            Faded nodes were superseded. For show; no writes.
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-100 hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors"
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      <div className="flex items-center gap-6 mb-4 flex-wrap">
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          Min similarity: {minSim.toFixed(2)}
          <input type="range" min={0.4} max={0.95} step={0.05} value={minSim}
            onChange={(e) => setMinSim(Number(e.target.value))} />
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          Max nodes: {limit}
          <input type="range" min={30} max={200} step={10} value={limit}
            onChange={(e) => setLimit(Number(e.target.value))} />
        </label>
        <div className="flex items-center gap-3 text-xs">
          {Object.entries(SECTOR_COLORS).map(([s, c]) => (
            <span key={s} className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full" style={{ background: c }} />
              <span className="capitalize text-slate-500 dark:text-slate-400">{s}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700">
        <canvas ref={canvasRef} className="w-full block" style={{ maxHeight: 600 }} />
      </div>

      {loading && <p className="text-sm text-slate-400 mt-2">Loading graph&hellip;</p>}
      {!loading && graph && graph.nodes.length === 0 && (
        <p className="text-sm text-slate-400 mt-2">No memories with embeddings found.</p>
      )}
      {!loading && graph && graph.edges.length === 0 && graph.nodes.length > 0 && (
        <p className="text-sm text-slate-400 mt-2">
          {graph.nodes.length} memories loaded, but no edges above the similarity threshold &mdash; lower &ldquo;Min similarity&rdquo; to connect them.
        </p>
      )}
    </div>
  );
}
