import React, { useState, useEffect, useCallback } from "react";
import { Skull, Database, Activity, Trash2, Edit2, Save, X, Search, RefreshCw, FileText } from "lucide-react";
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

type Tab = "dashboard" | "memories" | "logs";

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
          <h1 className="text-xl font-bold tracking-tight">CodeCortex</h1>
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
            active={activeTab === "logs"}
            onClick={() => setActiveTab("logs")}
            icon={<FileText size={20} />}
          >
            Interaction Logs
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
        {activeTab === "logs" && <LogsView />}
      </main>
    </div>
  );
}

type NavButtonProps = {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
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
  icon: React.ReactNode;
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
                    <p className="text-sm text-slate-800 line-clamp-2 whitespace-pre-wrap">{escapeHtml(m.content)}</p>
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

function LogsView() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/logs`)
      .then((res) => res.json())
      .then((data) => {
        setLogs(data.logs || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-slate-500">Loading interaction logs...</div>;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-slate-800">Interaction & Extraction Logs</h2>
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        {logs.length === 0 ? (
          <p className="text-center text-slate-400 py-8">No interaction logs available.</p>
        ) : (
          <div className="space-y-6">
            {logs.map((log: Memory, idx: number) => (
              <div key={log.id} className="flex gap-4 relative pb-6 last:pb-0">
                {/* Timeline connector */}
                {idx !== logs.length - 1 && (
                  <div className="absolute left-3.5 top-8 bottom-[-24px] w-0.5 bg-gray-200" />
                )}

                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 z-10 ${
                    log.is_genome === 1 ? "bg-amber-100 text-amber-600" : "bg-blue-100 text-blue-600"
                  }`}
                >
                  {log.is_genome === 1 ? <Skull size={14} /> : <Activity size={14} />}
                </div>

                <div className="flex-1">
                  <div className="flex justify-between items-start mb-1">
                    <span className="text-sm font-semibold text-slate-800 capitalize">
                      {log.sector || "unknown"} Memory{" "}
                      {log.is_genome === 1 ? "(Genome)" : "(Phenotype)"}
                    </span>
                    <span className="text-xs text-slate-400">
                      {log.created_at ? formatDistanceToNow(new Date(log.created_at), { addSuffix: true }) : (log.recorded_at ? formatDistanceToNow(new Date(log.recorded_at), { addSuffix: true }) : "N/A")}
                    </span>
                  </div>
                  <p className="text-sm text-slate-600 bg-gray-50 p-3 rounded-lg border border-gray-100 whitespace-pre-wrap">
                    {escapeHtml(log.content)}
                  </p>
                  <p className="text-xs text-slate-400 mt-1">ID: {log.id}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}