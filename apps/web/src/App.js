import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect, useCallback } from "react";
import { Skull, Database, Activity, Trash2, Edit2, Save, X, Search, RefreshCw, Cpu, Zap, HardDrive, Gauge, Terminal, Sun, Moon } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
const API_BASE = "/api/dashboard";
export default function App() {
    const [activeTab, setActiveTab] = useState("dashboard");
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const [dark, setDark] = useState(() => localStorage.getItem("engram-theme") === "dark");
    useEffect(() => {
        const root = document.documentElement;
        if (dark)
            root.classList.add("dark");
        else
            root.classList.remove("dark");
        localStorage.setItem("engram-theme", dark ? "dark" : "light");
    }, [dark]);
    const fetchStats = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/stats`);
            if (res.ok) {
                const data = await res.json();
                setStats(data);
            }
        }
        catch {
            // silently ignore — view handles null stats
        }
        finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => {
        fetchStats();
    }, [fetchStats]);
    return (_jsxs("div", { className: "min-h-screen bg-gray-50 text-gray-900 font-sans flex", children: [_jsxs("aside", { className: "fixed left-0 top-0 h-full w-64 bg-slate-900 text-white p-6 flex flex-col z-20", children: [_jsxs("div", { className: "flex items-center gap-3 mb-10", children: [_jsx(Skull, { className: "w-8 h-8 text-blue-400" }), _jsx("h1", { className: "text-xl font-bold tracking-tight", children: "Engram" })] }), _jsxs("nav", { className: "space-y-2 flex-1", children: [_jsx(NavButton, { active: activeTab === "dashboard", onClick: () => setActiveTab("dashboard"), icon: _jsx(Activity, { size: 20 }), children: "Dashboard" }), _jsx(NavButton, { active: activeTab === "memories", onClick: () => setActiveTab("memories"), icon: _jsx(Database, { size: 20 }), children: "Memory Explorer" }), _jsx(NavButton, { active: activeTab === "serverLogs", onClick: () => setActiveTab("serverLogs"), icon: _jsx(Terminal, { size: 20 }), children: "Server Logs" }), _jsx(NavButton, { active: activeTab === "performance", onClick: () => setActiveTab("performance"), icon: _jsx(Gauge, { size: 20 }), children: "Performance Monitor" }), _jsx(NavButton, { active: activeTab === "recall", onClick: () => setActiveTab("recall"), icon: _jsx(Search, { size: 20 }), children: "Memory Recall" }), _jsx(NavButton, { active: activeTab === "activity", onClick: () => setActiveTab("activity"), icon: _jsx(Activity, { size: 20 }), children: "Activity" })] }), _jsxs("div", { className: "pt-6 border-t border-slate-700 text-xs text-slate-400", children: [_jsxs("button", { onClick: () => setDark((d) => !d), className: "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-300 hover:bg-slate-800 transition-colors mb-3", children: [dark ? _jsx(Sun, { size: 16 }) : _jsx(Moon, { size: 16 }), dark ? "Light mode" : "Dark mode"] }), _jsx("p", { children: "v2.0.0 Cognitive Engine" }), _jsx("p", { className: "mt-1", children: "Local-first \u2022 SQLite/Postgres" })] })] }), _jsxs("main", { className: "ml-64 p-8 w-full min-h-screen", children: [activeTab === "dashboard" && (_jsx(DashboardView, { stats: stats, onRefresh: fetchStats })), activeTab === "memories" && _jsx(MemoriesView, {}), activeTab === "serverLogs" && _jsx(ServerLogsView, {}), activeTab === "performance" && _jsx(PerformanceMonitor, {}), activeTab === "recall" && _jsx(RecallView, {}), activeTab === "activity" && _jsx(ActivityView, {})] })] }));
}
function NavButton({ active, onClick, icon, children, }) {
    return (_jsxs("button", { onClick: onClick, className: `w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${active
            ? "bg-blue-600 text-white shadow-lg shadow-blue-900/50"
            : "text-slate-300 hover:bg-slate-800"}`, children: [icon, _jsx("span", { className: "font-medium", children: children })] }));
}
function DashboardView({ stats, onRefresh, }) {
    const [consolidating, setConsolidating] = useState(false);
    const [consolidateMsg, setConsolidateMsg] = useState("");
    const triggerConsolidation = async () => {
        setConsolidating(true);
        setConsolidateMsg("");
        try {
            await fetch(`${API_BASE}/consolidate`, { method: "POST" });
            setConsolidateMsg("Consolidation triggered successfully");
            setTimeout(() => onRefresh(), 1500);
        }
        catch {
            setConsolidateMsg("Failed to trigger consolidation");
        }
        finally {
            setConsolidating(false);
        }
    };
    if (!stats)
        return _jsx("div", { className: "text-slate-500", children: "Loading cognitive stats..." });
    const total = stats.total_memories || 1;
    return (_jsxs("div", { className: "space-y-8", children: [_jsxs("div", { className: "flex justify-between items-center", children: [_jsx("h2", { className: "text-2xl font-bold text-slate-800", children: "Cognitive Overview" }), _jsxs("button", { onClick: triggerConsolidation, disabled: consolidating, className: "flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg transition-colors disabled:opacity-50", children: [_jsx(RefreshCw, { size: 18, className: consolidating ? "animate-spin" : "" }), "Run Consolidation"] })] }), consolidateMsg && (_jsx("p", { className: `text-sm ${consolidateMsg.includes("Failed") ? "text-red-500" : "text-emerald-600"}`, children: consolidateMsg })), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-3 gap-6", children: [_jsx(StatCard, { title: "Total Memories", value: stats.total_memories, icon: _jsx(Database, { className: "text-blue-500" }) }), _jsx(StatCard, { title: "Genome (Immutable)", value: stats.genome_count, icon: _jsx(Skull, { className: "text-amber-500" }) }), _jsx(StatCard, { title: "Phenotype (Decaying)", value: stats.phenotype_count, icon: _jsx(Activity, { className: "text-emerald-500" }) })] }), Object.keys(stats.by_sector).length > 0 ? (_jsxs("div", { className: "bg-white p-6 rounded-xl shadow-sm border border-gray-200", children: [_jsx("h3", { className: "text-lg font-semibold mb-4", children: "Memory Distribution by Sector" }), _jsx("div", { className: "space-y-4", children: Object.entries(stats.by_sector)
                            .sort((a, b) => b[1] - a[1])
                            .map(([sector, count]) => (_jsxs("div", { className: "flex items-center gap-4", children: [_jsx("span", { className: "w-24 text-sm font-medium capitalize text-slate-600", children: sector }), _jsx("div", { className: "flex-1 h-3 bg-gray-100 rounded-full overflow-hidden", children: _jsx("div", { className: "h-full bg-blue-500 rounded-full transition-all duration-500", style: { width: `${(count / total) * 100}%` } }) }), _jsx("span", { className: "w-12 text-sm text-slate-500 text-right", children: count })] }, sector))) })] })) : null, Object.keys(stats.by_tier).length > 0 ? (_jsxs("div", { className: "bg-white p-6 rounded-xl shadow-sm border border-gray-200", children: [_jsx("h3", { className: "text-lg font-semibold mb-4", children: "Memory Distribution by Tier" }), _jsx("div", { className: "space-y-4", children: Object.entries(stats.by_tier).map(([tier, count]) => (_jsxs("div", { className: "flex items-center gap-4", children: [_jsx("span", { className: "w-20 text-sm font-medium capitalize text-slate-600", children: tier }), _jsx("div", { className: "flex-1 h-3 bg-gray-100 rounded-full overflow-hidden", children: _jsx("div", { className: "h-full bg-indigo-500 rounded-full transition-all duration-500", style: { width: `${(count / total) * 100}%` } }) }), _jsx("span", { className: "w-12 text-sm text-slate-500 text-right", children: count })] }, tier))) })] })) : null] }));
}
function StatCard({ title, value, icon }) {
    return (_jsxs("div", { className: "bg-white p-6 rounded-xl shadow-sm border border-gray-200 flex items-center gap-4", children: [_jsx("div", { className: "p-3 bg-gray-50 rounded-lg", children: icon }), _jsxs("div", { children: [_jsx("p", { className: "text-sm text-slate-500 font-medium", children: title }), _jsx("p", { className: "text-3xl font-bold text-slate-900", children: value })] })] }));
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
        }
        catch {
            // silently ignore — view handles empty state
        }
    };
    const handleDelete = async (id) => {
        if (!confirm("Permanently delete this memory?"))
            return;
        try {
            await fetch(`${API_BASE}/memories/${id}`, { method: "DELETE" });
            fetchMemories();
        }
        catch {
            alert("Failed to delete memory");
        }
    };
    const startEdit = (m) => {
        setEditingId(m.id);
        setEditForm({ content: m.content, sector: m.sector || "semantic", is_genome: Number(m.is_genome) });
    };
    const saveEdit = async () => {
        if (!editingId)
            return;
        setSaving(true);
        try {
            const payload = {};
            if (editForm.content)
                payload.content = editForm.content;
            if (editForm.sector)
                payload.metadata = { sector: editForm.sector };
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
        }
        catch {
            alert("Failed to save memory");
        }
        finally {
            setSaving(false);
        }
    };
    return (_jsxs("div", { className: "space-y-6", children: [_jsx("h2", { className: "text-2xl font-bold text-slate-800", children: "Memory Explorer" }), _jsxs("div", { className: "flex gap-4", children: [_jsxs("div", { className: "relative flex-1", children: [_jsx(Search, { className: "absolute left-3 top-3 text-slate-400", size: 20 }), _jsx("input", { type: "text", placeholder: "Search memories...", className: "w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white", value: search, onChange: (e) => setSearch(e.target.value) })] }), _jsxs("select", { className: "px-4 py-2.5 border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-blue-500 outline-none", value: sectorFilter, onChange: (e) => setSectorFilter(e.target.value), children: [_jsx("option", { value: "all", children: "All Sectors" }), _jsx("option", { value: "semantic", children: "Semantic" }), _jsx("option", { value: "episodic", children: "Episodic" }), _jsx("option", { value: "procedural", children: "Procedural" }), _jsx("option", { value: "emotional", children: "Emotional" }), _jsx("option", { value: "reflective", children: "Reflective" })] })] }), _jsx("div", { className: "bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden", children: _jsxs("table", { className: "w-full text-left", children: [_jsx("thead", { className: "bg-gray-50 border-b border-gray-200", children: _jsxs("tr", { children: [_jsx("th", { className: "px-6 py-4 text-xs font-semibold text-slate-500 uppercase", children: "Content" }), _jsx("th", { className: "px-6 py-4 text-xs font-semibold text-slate-500 uppercase", children: "Sector" }), _jsx("th", { className: "px-6 py-4 text-xs font-semibold text-slate-500 uppercase", children: "Type" }), _jsx("th", { className: "px-6 py-4 text-xs font-semibold text-slate-500 uppercase", children: "Age" }), _jsx("th", { className: "px-6 py-4 text-xs font-semibold text-slate-500 uppercase text-right", children: "Actions" })] }) }), _jsxs("tbody", { className: "divide-y divide-gray-100", children: [memories.map((m) => (_jsxs("tr", { className: "hover:bg-gray-50 transition-colors", children: [_jsx("td", { className: "px-6 py-4", children: editingId === m.id ? (_jsx("textarea", { className: "w-full p-2 border border-blue-300 rounded text-sm focus:ring-2 focus:ring-blue-500 outline-none", rows: 3, value: editForm.content, onChange: (e) => setEditForm({ ...editForm, content: e.target.value }) })) : (_jsx("p", { className: "text-sm text-slate-800 line-clamp-2 whitespace-pre-wrap", children: m.content })) }), _jsx("td", { className: "px-6 py-4", children: editingId === m.id ? (_jsx("select", { className: "text-sm border rounded p-1", value: editForm.sector, onChange: (e) => setEditForm({ ...editForm, sector: e.target.value }), children: ["semantic", "episodic", "procedural", "emotional", "reflective"].map((s) => (_jsx("option", { value: s, children: s }, s))) })) : (_jsx("span", { className: "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 capitalize", children: m.sector || "unknown" })) }), _jsx("td", { className: "px-6 py-4", children: editingId === m.id ? (_jsxs("select", { className: "text-sm border rounded p-1", value: editForm.is_genome, onChange: (e) => setEditForm({ ...editForm, is_genome: parseInt(e.target.value) }), children: [_jsx("option", { value: 0, children: "Phenotype" }), _jsx("option", { value: 1, children: "Genome" })] })) : (Number(m.is_genome) === 1 ? (_jsxs("span", { className: "flex items-center gap-1 text-xs font-medium text-amber-600", children: [_jsx(Skull, { size: 14 }), " Genome"] })) : (_jsx("span", { className: "text-xs text-slate-400", children: "Phenotype" }))) }), _jsx("td", { className: "px-6 py-4 text-sm text-slate-500", children: m.created_at ? formatDistanceToNow(new Date(m.created_at), { addSuffix: true }) : (m.recorded_at ? formatDistanceToNow(new Date(m.recorded_at), { addSuffix: true }) : "N/A") }), _jsx("td", { className: "px-6 py-4 text-right", children: editingId === m.id ? (_jsxs("div", { className: "flex justify-end gap-2", children: [_jsx("button", { onClick: saveEdit, disabled: saving, className: "p-1.5 text-emerald-600 hover:bg-emerald-50 rounded disabled:opacity-50", children: _jsx(Save, { size: 18 }) }), _jsx("button", { onClick: () => setEditingId(null), className: "p-1.5 text-slate-500 hover:bg-gray-100 rounded", children: _jsx(X, { size: 18 }) })] })) : (_jsxs("div", { className: "flex justify-end gap-2", children: [_jsx("button", { onClick: () => startEdit(m), className: "p-1.5 text-blue-600 hover:bg-blue-50 rounded", children: _jsx(Edit2, { size: 18 }) }), _jsx("button", { onClick: () => handleDelete(m.id), className: "p-1.5 text-red-600 hover:bg-red-50 rounded", children: _jsx(Trash2, { size: 18 }) })] })) })] }, m.id))), memories.length === 0 && (_jsx("tr", { children: _jsx("td", { colSpan: 5, className: "px-6 py-12 text-center text-slate-400", children: "No memories found matching your criteria." }) }))] })] }) })] }));
}
function RecallView() {
    const [query, setQuery] = useState("");
    const [mode, setMode] = useState("associative");
    const [limit, setLimit] = useState(10);
    const [results, setResults] = useState([]);
    const [timings, setTimings] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [empty, setEmpty] = useState(false);
    const runRecall = async () => {
        if (!query.trim())
            return;
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
        }
        catch (e) {
            setError(e?.message || "Recall request failed");
            setResults([]);
        }
        finally {
            setLoading(false);
        }
    };
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { className: "flex justify-between items-center", children: [_jsx("h2", { className: "text-2xl font-bold text-slate-800", children: "Memory Recall" }), _jsx("span", { className: "text-xs text-slate-400", children: "Semantic similarity search across all stored memories (pgvector)" })] }), _jsxs("div", { className: "bg-white p-6 rounded-xl shadow-sm border border-gray-200 space-y-4", children: [_jsxs("div", { className: "relative", children: [_jsx(Search, { className: "absolute left-3 top-3 text-slate-400", size: 20 }), _jsx("input", { type: "text", placeholder: "Ask a question or describe what you want to recall...", className: "w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white", value: query, onChange: (e) => setQuery(e.target.value), onKeyDown: (e) => { if (e.key === "Enter")
                                    runRecall(); } })] }), _jsxs("div", { className: "flex flex-wrap gap-4 items-center", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("label", { className: "text-sm text-slate-500", children: "Mode" }), _jsxs("select", { className: "px-3 py-2 border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-blue-500 outline-none", value: mode, onChange: (e) => setMode(e.target.value), children: [_jsx("option", { value: "associative", children: "Associative" }), _jsx("option", { value: "strict", children: "Strict" }), _jsx("option", { value: "historical", children: "Historical" })] })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("label", { className: "text-sm text-slate-500", children: "Limit" }), _jsxs("select", { className: "px-3 py-2 border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-blue-500 outline-none", value: limit, onChange: (e) => setLimit(parseInt(e.target.value)), children: [_jsx("option", { value: 5, children: "5" }), _jsx("option", { value: 10, children: "10" }), _jsx("option", { value: 20, children: "20" }), _jsx("option", { value: 50, children: "50" })] })] }), _jsxs("button", { onClick: runRecall, disabled: loading || !query.trim(), className: "flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-lg transition-colors disabled:opacity-50", children: [_jsx(Search, { size: 18 }), loading ? "Recalling..." : "Recall"] })] }), timings && (_jsxs("p", { className: "text-xs text-slate-400", children: ["embed ", timings.embedding_ms ?? 0, "ms \u00B7 retrieve ", timings.retrieval_ms ?? 0, "ms \u00B7 total ", timings.total_ms ?? 0, "ms"] }))] }), error && (_jsx("div", { className: "bg-red-50 border border-red-200 text-red-600 text-sm px-4 py-3 rounded-lg", children: error })), empty && !loading && (_jsx("div", { className: "bg-white border border-gray-200 rounded-xl px-6 py-12 text-center text-slate-400", children: "No memories matched this query." })), _jsx("div", { className: "space-y-3", children: results.map((r) => (_jsx("div", { className: "bg-white p-5 rounded-xl shadow-sm border border-gray-200 hover:border-blue-300 transition-colors", children: _jsxs("div", { className: "flex items-start justify-between gap-4", children: [_jsx("p", { className: "text-sm text-slate-800 whitespace-pre-wrap leading-relaxed flex-1", children: r.content }), _jsxs("div", { className: "flex flex-col items-end gap-1 shrink-0", children: [_jsx("span", { className: "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 capitalize", children: r.sector || "unknown" }), _jsxs("span", { className: `text-xs font-semibold ${r.score >= 0.7
                                            ? "text-emerald-600"
                                            : r.score >= 0.5
                                                ? "text-amber-600"
                                                : "text-slate-400"}`, children: [(r.score * 100).toFixed(0), "% match"] })] })] }) }, r.id))) })] }));
}
function ActivityView() {
    const [entries, setEntries] = useState([]);
    const [incoming, setIncoming] = useState(0);
    const [outgoing, setOutgoing] = useState(0);
    const [autoRefresh, setAutoRefresh] = useState(true);
    const [lastUpdated, setLastUpdated] = useState(null);
    const [filter, setFilter] = useState("all");
    const [clearing, setClearing] = useState(false);
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
        }
        catch {
            // silently ignore — view handles empty state
        }
    }, []);
    useEffect(() => {
        fetchActivity();
    }, [fetchActivity]);
    useEffect(() => {
        if (!autoRefresh)
            return;
        const interval = setInterval(fetchActivity, 2500);
        return () => clearInterval(interval);
    }, [autoRefresh, fetchActivity]);
    const handleClear = async () => {
        if (!confirm("Clear the in-memory activity buffer?"))
            return;
        setClearing(true);
        try {
            await fetch(`${API_BASE}/activity/clear`, { method: "POST" });
            fetchActivity();
        }
        catch {
            alert("Failed to clear activity");
        }
        finally {
            setClearing(false);
        }
    };
    const visible = entries.filter((e) => filter === "all" ? true : e.direction === filter);
    const dirBadge = (e) => e.direction === "in"
        ? "bg-emerald-100 text-emerald-700"
        : "bg-blue-100 text-blue-700";
    const dirLabel = (e) => (e.direction === "in" ? "IN" : "OUT");
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { className: "flex justify-between items-center", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-2xl font-bold text-slate-800", children: "Memory Activity" }), _jsx("p", { className: "text-sm text-slate-500 mt-1", children: "Live inbound/outbound memory traffic \u2014 proves a connected client (Hermes) is actually using memory." })] }), _jsxs("div", { className: "flex gap-3", children: [_jsxs("button", { onClick: () => setAutoRefresh(!autoRefresh), className: `flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${autoRefresh
                                    ? "bg-blue-100 text-blue-700 border border-blue-300"
                                    : "bg-gray-100 text-gray-600 border border-gray-300"}`, children: [_jsx(RefreshCw, { size: 14, className: autoRefresh ? "animate-spin" : "" }), "Auto-refresh"] }), _jsxs("button", { onClick: handleClear, disabled: clearing, className: "flex items-center gap-2 px-3 py-2 bg-red-50 text-red-600 border border-red-300 rounded-lg text-sm hover:bg-red-100 transition-colors disabled:opacity-50", children: [_jsx(Trash2, { size: 14 }), "Clear"] })] })] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-3 gap-6", children: [_jsxs("div", { className: "bg-white p-6 rounded-xl shadow-sm border border-gray-200", children: [_jsx("p", { className: "text-sm text-slate-500 font-medium", children: "Total events" }), _jsx("p", { className: "text-3xl font-bold text-slate-900", children: entries.length })] }), _jsxs("div", { className: "bg-white p-6 rounded-xl shadow-sm border border-gray-200", children: [_jsx("p", { className: "text-sm text-slate-500 font-medium", children: "Incoming (saved)" }), _jsx("p", { className: "text-3xl font-bold text-emerald-600", children: incoming })] }), _jsxs("div", { className: "bg-white p-6 rounded-xl shadow-sm border border-gray-200", children: [_jsx("p", { className: "text-sm text-slate-500 font-medium", children: "Outgoing (retrieved)" }), _jsx("p", { className: "text-3xl font-bold text-blue-600", children: outgoing })] })] }), _jsxs("div", { className: "flex gap-2 items-center", children: [["all", "in", "out"].map((f) => (_jsx("button", { onClick: () => setFilter(f), className: `px-3 py-1.5 rounded-lg text-xs font-medium transition-colors capitalize ${filter === f
                            ? "bg-slate-800 text-white"
                            : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`, children: f === "in" ? "Incoming" : f === "out" ? "Outgoing" : "All" }, f))), _jsx("span", { className: "ml-auto text-xs text-slate-400 self-center", children: lastUpdated ? `updated ${lastUpdated.toLocaleTimeString()}` : "loading..." })] }), _jsx("div", { className: "bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden", children: _jsx("div", { className: "max-h-[600px] overflow-y-auto divide-y divide-gray-100", children: visible.length === 0 ? (_jsx("div", { className: "px-6 py-12 text-center text-slate-400", children: "No memory traffic captured yet. Trigger a write (e.g. save a memory) or a recall to see it here." })) : (visible.map((e, idx) => (_jsxs("div", { className: "flex items-start gap-4 px-6 py-3 hover:bg-gray-50 transition-colors", children: [_jsx("span", { className: `shrink-0 mt-0.5 inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${dirBadge(e)}`, children: dirLabel(e) }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("p", { className: "text-sm text-slate-800 whitespace-pre-wrap break-words", children: e.summary || _jsx("span", { className: "text-slate-400 italic", children: "(empty body)" }) }), _jsxs("p", { className: "text-xs text-slate-400 mt-0.5", children: [e.label, " \u00B7 ", e.route, " \u00B7 ", e.status, " \u00B7 ", e.ms, "ms", e.user_id ? ` · user:${e.user_id}` : ""] })] }), _jsx("span", { className: "shrink-0 text-xs text-slate-400", children: e.ts ? new Date(e.ts).toLocaleTimeString() : "" })] }, idx)))) }) })] }));
}
function ServerLogsView() {
    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [autoRefresh, setAutoRefresh] = useState(true);
    const [levelFilter, setLevelFilter] = useState("all");
    const fetchLogs = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/log`);
            if (res.ok) {
                const data = await res.json();
                setLogs(data.lines || []);
            }
        }
        catch {
            // silently ignore
        }
        finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => {
        fetchLogs();
    }, [fetchLogs]);
    useEffect(() => {
        if (!autoRefresh)
            return;
        const interval = setInterval(fetchLogs, 3000);
        return () => clearInterval(interval);
    }, [autoRefresh, fetchLogs]);
    const handleClear = async () => {
        if (!confirm("Clear the server log file?"))
            return;
        try {
            await fetch(`${API_BASE}/log/clear`, { method: "POST" });
            fetchLogs();
        }
        catch {
            alert("Failed to clear log");
        }
    };
    // Parse and filter log lines
    const filteredLogs = logs.filter((line) => {
        if (levelFilter === "all")
            return true;
        try {
            const parsed = JSON.parse(line);
            const label = getLevelLabel(parsed.level);
            return label === levelFilter;
        }
        catch {
            return true; // non-JSON lines always show
        }
    });
    if (loading)
        return _jsx("div", { className: "text-slate-500", children: "Loading server logs..." });
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { className: "flex justify-between items-center", children: [_jsx("h2", { className: "text-2xl font-bold text-slate-800", children: "Server Logs" }), _jsxs("div", { className: "flex gap-3", children: [_jsxs("button", { onClick: () => setAutoRefresh(!autoRefresh), className: `flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${autoRefresh
                                    ? "bg-blue-100 text-blue-700 border border-blue-300"
                                    : "bg-gray-100 text-gray-600 border border-gray-300"}`, children: [_jsx(RefreshCw, { size: 14, className: autoRefresh ? "animate-spin" : "" }), "Auto-refresh"] }), _jsxs("button", { onClick: handleClear, className: "flex items-center gap-2 px-3 py-2 bg-red-50 text-red-600 border border-red-300 rounded-lg text-sm hover:bg-red-100 transition-colors", children: [_jsx(Trash2, { size: 14 }), "Clear"] })] })] }), _jsxs("div", { className: "flex gap-2", children: [["all", "info", "warn", "error", "fatal"].map((level) => (_jsx("button", { onClick: () => setLevelFilter(level), className: `px-3 py-1.5 rounded-lg text-xs font-medium transition-colors capitalize ${levelFilter === level
                            ? "bg-slate-800 text-white"
                            : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`, children: level }, level))), _jsxs("span", { className: "ml-auto text-xs text-slate-400 self-center", children: [filteredLogs.length, " / ", logs.length, " lines"] })] }), _jsx("div", { className: "bg-slate-900 rounded-xl shadow-sm border border-gray-200 overflow-hidden", children: _jsx("div", { className: "max-h-[600px] overflow-y-auto font-mono text-xs p-4 space-y-0.5", children: filteredLogs.length === 0 ? (_jsx("p", { className: "text-center text-slate-500 py-8", children: "No log entries matching filter." })) : (filteredLogs.map((line, idx) => {
                        const parsed = tryParseLogLine(line);
                        const levelColor = levelToColor(parsed.level);
                        return (_jsxs("div", { className: "flex gap-2 hover:bg-slate-800/50 rounded px-1 -mx-1 py-0.5", children: [_jsx("span", { className: "text-slate-500 shrink-0", children: parsed.time }), _jsxs("span", { className: `font-bold shrink-0 w-12 text-right ${levelColor}`, children: ["[", parsed.level.toUpperCase(), "]"] }), _jsx("span", { className: "text-slate-300 break-all whitespace-pre-wrap", children: parsed.msg })] }, idx));
                    })) }) })] }));
}
function formatLogMessage(parsed, fallback) {
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
function tryParseLogLine(line) {
    try {
        const parsed = JSON.parse(line);
        return {
            level: getLevelLabel(parsed.level) || "info",
            time: parsed.time
                ? new Date(parsed.time).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
                : "",
            msg: formatLogMessage(parsed, line),
        };
    }
    catch {
        return { level: "info", time: "", msg: line };
    }
}
function getLevelLabel(code) {
    const map = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };
    return map[code] || "info";
}
function levelToColor(level) {
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
function escapeHtml(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
const HISTORY_MAX = 180; // 15 minutes at 5s poll interval
const HISTORY_STORAGE_KEY = "engram_perf_history";
function loadHistory() {
    try {
        const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
        if (!raw)
            return [];
        const points = JSON.parse(raw);
        const cutoff = Date.now() - 15 * 60 * 1000; // 15 minutes TTL
        return points.filter(p => p.ts >= cutoff).slice(-HISTORY_MAX);
    }
    catch {
        return [];
    }
}
function saveHistory(points) {
    try {
        localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(points));
    }
    catch {
        // storage full or unavailable — silently ignore
    }
}
function formatBytes(bytes) {
    if (!bytes)
        return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + " " + units[i];
}
function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0)
        return `${d}d ${h}h ${m}m`;
    if (h > 0)
        return `${h}h ${m}m`;
    return `${m}m`;
}
function formatDurationAgo(ts) {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 5)
        return "just now";
    if (diff < 60)
        return `${diff}s ago`;
    return `${Math.floor(diff / 60)}m ago`;
}
function MetricCard({ icon, label, value, sublabel, color }) {
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
    return (_jsxs("div", { className: `relative overflow-hidden rounded-xl border bg-gradient-to-br ${colorMap[color]} p-5`, children: [_jsxs("div", { className: "flex items-center gap-3 mb-3", children: [_jsx("div", { className: `rounded-lg p-2 ${iconBg[color]}`, children: icon }), _jsx("span", { className: "text-sm font-medium text-gray-400", children: label })] }), _jsx("div", { className: "text-2xl font-bold text-white mb-1", children: value || "—" }), sublabel && _jsx("div", { className: "text-xs text-gray-500", children: sublabel })] }));
}
function ProgressBar({ percent, color }) {
    const clamped = Math.min(100, Math.max(0, percent));
    return (_jsx("div", { className: "h-3 w-full rounded-full bg-gray-700 overflow-hidden", children: _jsx("div", { className: `h-full rounded-full transition-all duration-500 ${color}`, style: { width: `${clamped}%` } }) }));
}
function SparklineChart({ data, label, color }) {
    const width = 600;
    const height = 120;
    const padding = { top: 8, right: 4, bottom: 16, left: 4 };
    if (data.length < 2) {
        return (_jsxs("div", { className: "rounded-xl border border-gray-700 bg-gray-900/50 p-4", children: [_jsxs("div", { className: "flex items-center justify-between mb-3", children: [_jsx("span", { className: "text-sm font-medium text-gray-400", children: label }), data.length > 0 && (_jsx("span", { className: `text-lg font-bold ${color === "blue" ? "text-blue-400" : "text-emerald-400"}`, children: data[data.length - 1]?.cpu != null ? `${data[data.length - 1].cpu.toFixed(1)}%` : "—" }))] }), _jsx("svg", { viewBox: `0 0 ${width} ${height}`, className: "w-full h-28 text-gray-600", children: _jsx("text", { x: width / 2, y: height / 2 + 4, textAnchor: "middle", className: "fill-gray-600 text-xs", children: "Collecting data\u2026" }) })] }));
    }
    const minVal = Math.min(0, ...data.map(d => d.cpu), ...data.map(d => d.mem));
    const maxVal = Math.max(100, ...data.map(d => d.cpu), ...data.map(d => d.mem));
    const range = maxVal - minVal || 1;
    const xScale = (i) => padding.left + (i / (data.length - 1)) * (width - padding.left - padding.right);
    const yScale = (v) => height - padding.bottom - ((v - minVal) / range) * (height - padding.top - padding.bottom);
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
        return _jsx("line", { x1: padding.left, y1: y, x2: width - padding.right, y2: y, stroke: "#37415a", strokeWidth: "0.5", strokeDasharray: "3,3" }, pct);
    });
    const latestCpu = data[data.length - 1]?.cpu ?? 0;
    const latestMem = data[data.length - 1]?.mem ?? 0;
    return (_jsxs("div", { className: "rounded-xl border border-gray-700 bg-gray-900/50 p-4", children: [_jsxs("div", { className: "flex items-center justify-between mb-3", children: [_jsx("span", { className: "text-sm font-medium text-gray-400", children: label }), _jsxs("div", { className: "flex gap-4", children: [_jsxs("span", { className: "text-lg font-bold text-blue-400", children: ["CPU ", latestCpu.toFixed(1), "%"] }), _jsxs("span", { className: "text-lg font-bold text-emerald-400", children: ["MEM ", latestMem.toFixed(1), "%"] })] })] }), _jsxs("svg", { viewBox: `0 0 ${width} ${height}`, className: "w-full h-28", preserveAspectRatio: "none", children: [gridLines, _jsx("path", { d: memArea, fill: "url(#memGrad)", opacity: "0.15" }), _jsx("path", { d: cpuArea, fill: "url(#cpuGrad)", opacity: "0.15" }), _jsxs("defs", { children: [_jsxs("linearGradient", { id: "cpuGrad", x1: "0", y1: "0", x2: "0", y2: "1", children: [_jsx("stop", { offset: "0%", stopColor: "#3b8cf0", stopOpacity: "0.4" }), _jsx("stop", { offset: "100%", stopColor: "#3b8cf0", stopOpacity: "0" })] }), _jsxs("linearGradient", { id: "memGrad", x1: "0", y1: "0", x2: "0", y2: "1", children: [_jsx("stop", { offset: "0%", stopColor: "#34d67a", stopOpacity: "0.4" }), _jsx("stop", { offset: "100%", stopColor: "#34d67a", stopOpacity: "0" })] })] }), _jsx("path", { d: cpuPath, fill: "none", stroke: "#3b8cf0", strokeWidth: "2", strokeLinejoin: "round", vectorEffect: "inherit" }), _jsx("path", { d: memPath, fill: "none", stroke: "#34d67a", strokeWidth: "2", strokeLinejoin: "round", vectorEffect: "inherit" }), data.length > 0 && (_jsxs(_Fragment, { children: [_jsx("circle", { cx: xScale(data.length - 1), cy: yScale(latestCpu), r: "4", fill: "#3b8cf0", stroke: "#1e2a4a", strokeWidth: "2" }), _jsx("circle", { cx: xScale(data.length - 1), cy: yScale(latestMem), r: "4", fill: "#34d67a", stroke: "#1a3a2a", strokeWidth: "2" })] }))] }), _jsxs("div", { className: "flex items-center gap-4 mt-2 text-xs text-gray-500", children: [_jsxs("span", { className: "flex items-center gap-1.5", children: [_jsx("span", { className: "w-3 h-0.5 bg-blue-500 rounded inline-block" }), " CPU"] }), _jsxs("span", { className: "flex items-center gap-1.5", children: [_jsx("span", { className: "w-3 h-0.5 bg-emerald-500 rounded inline-block" }), " Memory"] }), _jsxs("span", { className: "ml-auto", children: ["~", HISTORY_MAX, "s window (", data.length, " pts)"] })] })] }));
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
    const [sysMetrics, setSysMetrics] = useState(null);
    const [lsMetrics, setLsMetrics] = useState(null);
    const [history, setHistory] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const fetchData = useCallback(async () => {
        try {
            setError(null);
            const [sysRes, lsRes] = await Promise.all([
                fetch("/api/performance/system"),
                fetch("/api/performance/llama-swap"),
            ]);
            if (!sysRes.ok)
                throw new Error("Failed to fetch system metrics");
            const sysData = await sysRes.json();
            setSysMetrics(sysData);
            // ── Future: user-selectable source. Example ollama branch (left dormant):
            // const ollRes = await fetch("/api/performance/ollama");
            // if (ollRes.ok) setOllamaMetrics(await ollRes.json());
            if (lsRes.ok) {
                const lsData = await lsRes.json();
                setLsMetrics(lsData);
                if (lsData.available && lsData.system) {
                    setHistory((prev) => [...prev, {
                            ts: Date.now(),
                            cpu: lsData.system.cpu_percent,
                            mem: lsData.system.memory_percent,
                        }].slice(-HISTORY_MAX));
                }
            }
            else {
                setLsMetrics({ source: "llama-swap", available: false, error: "HTTP " + lsRes.status });
            }
        }
        catch (e) {
            setError(e.message || "Error fetching metrics");
        }
        finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 5000);
        return () => clearInterval(interval);
    }, [fetchData]);
    if (loading && history.length === 0) {
        return (_jsxs("div", { className: "flex items-center justify-center h-full text-gray-400", children: [_jsx(RefreshCw, { className: "w-6 h-6 animate-spin mr-2" }), "Loading metrics..."] }));
    }
    if (error && history.length === 0 && !lsMetrics) {
        return (_jsxs("div", { className: "flex flex-col items-center justify-center h-full text-gray-400", children: [_jsx("p", { className: "mb-4", children: error }), _jsx("button", { onClick: fetchData, className: "px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-white transition-color", children: "Retry" })] }));
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
    return (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-2xl font-bold text-white", children: "Performance Monitor" }), _jsx("p", { className: "text-sm text-gray-500 mt-1", children: "Live system & GPU metrics \u2022 Source: llama-swap \u2022 Auto-refresh every 5s" })] }), _jsxs("button", { onClick: fetchData, disabled: loading, className: "flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-white transition-color disabled:opacity-50", children: [_jsx(RefreshCw, { size: 16, className: loading ? "animate-spin" : "" }), "Refresh"] })] }), lsMetrics && !lsMetrics.available && (_jsxs("div", { className: "rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-300", children: ["llama-swap metrics unavailable: ", lsMetrics.error || "unknown error", ". The server could not reach the llama-swap /metrics endpoint. CPU/RAM/Disk above come from the Engram host."] })), _jsx(SparklineChart, { data: history, label: "CPU & Memory (llama-swap)", color: "blue" }), _jsx("h3", { className: "text-lg font-semibold text-white mb-4", children: "System" }), _jsxs("div", { className: "grid grid-cols-2 gap-4 mb-8", children: [_jsx(MetricCard, { icon: _jsx(Cpu, { size: 18 }), label: "CPU Usage", value: cpuPercent.toFixed(1) + "%", color: "blue" }), _jsx(MetricCard, { icon: _jsx(Zap, { size: 18 }), label: "Memory", value: memPercent.toFixed(1) + "%", sublabel: formatBytes(sysMetrics?.memory_used_mb ? sysMetrics.memory_used_mb * 1024 * 1024 : 0) + " / " + formatBytes(sysMetrics?.memory_total_mb ? sysMetrics.memory_total_mb * 1024 * 1024 : 0), color: "green" }), _jsx(MetricCard, { icon: _jsx(HardDrive, { size: 18 }), label: "Disk Usage", value: diskPercent.toFixed(1) + "%", sublabel: formatBytes(sysMetrics?.disk_used_gb ? sysMetrics.disk_used_gb * 1024 ** 3 : 0) + " / " + formatBytes(sysMetrics?.disk_total_gb ? sysMetrics.disk_total_gb * 1024 ** 3 : 0), color: "amber" }), _jsx(MetricCard, { icon: _jsx(Activity, { size: 18 }), label: "Load Average", value: load1.toFixed(2), sublabel: "1m: " + load1.toFixed(2) + " • 5m: " + load5.toFixed(2) + " • 15m: " + load15.toFixed(2), color: "purple" })] }), _jsxs("div", { className: "grid grid-cols-4 gap-6 mb-8", children: [_jsxs("div", { children: [_jsxs("div", { className: "flex justify-between text-sm mb-1", children: [_jsx("span", { className: "text-gray-400", children: "CPU" }), _jsxs("span", { className: "text-white", children: [cpuPercent.toFixed(1), "%"] })] }), _jsx(ProgressBar, { percent: cpuPercent, color: cpuPercent > 90 ? "bg-red-500" : cpuPercent > 70 ? "bg-amber-500" : "bg-blue-500" })] }), _jsxs("div", { children: [_jsxs("div", { className: "flex justify-between text-sm mb-1", children: [_jsx("span", { className: "text-gray-400", children: "Memory" }), _jsxs("span", { className: "text-white", children: [memPercent.toFixed(1), "%"] })] }), _jsx(ProgressBar, { percent: memPercent, color: memPercent > 90 ? "bg-red-500" : memPercent > 70 ? "bg-amber-500" : "bg-emerald-500" })] }), _jsxs("div", { children: [_jsxs("div", { className: "flex justify-between text-sm mb-1", children: [_jsx("span", { className: "text-gray-400", children: "Disk" }), _jsxs("span", { className: "text-white", children: [diskPercent.toFixed(1), "%"] })] }), _jsx(ProgressBar, { percent: diskPercent, color: diskPercent > 90 ? "bg-red-500" : diskPercent > 70 ? "bg-amber-500" : "bg-purple-500" })] }), _jsxs("div", { children: [_jsxs("div", { className: "flex justify-between text-sm mb-1", children: [_jsx("span", { className: "text-gray-400", children: "GPU VRAM" }), _jsxs("span", { className: "text-white", children: [vramPercent.toFixed(1), "%"] })] }), _jsx(ProgressBar, { percent: vramPercent, color: vramPercent > 90 ? "bg-red-500" : vramPercent > 70 ? "bg-amber-500" : "bg-cyan-500" })] })] }), _jsx("h3", { className: "text-lg font-semibold text-white mb-4", children: "GPUs (llama-swap)" }), gpus.length === 0 ? (_jsx("p", { className: "text-sm text-slate-400", children: "No GPU telemetry reported by llama-swap." })) : (_jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4 mb-8", children: gpus.map((g) => (_jsxs("div", { className: "rounded-xl border border-gray-700 bg-gray-900/50 p-5 space-y-3", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("span", { className: "font-medium text-white", children: g.name }), _jsx("span", { className: "text-xs text-gray-400", children: g.id })] }), _jsxs("div", { className: "grid grid-cols-2 gap-3 text-sm", children: [_jsxs("div", { children: [_jsx("span", { className: "text-gray-400", children: "GPU Util" }), _jsxs("div", { className: "text-white", children: [g.util_percent.toFixed(1), "%"] })] }), _jsxs("div", { children: [_jsx("span", { className: "text-gray-400", children: "Mem Util" }), _jsxs("div", { className: "text-white", children: [g.memory_util_percent.toFixed(1), "%"] })] }), _jsxs("div", { children: [_jsx("span", { className: "text-gray-400", children: "VRAM" }), _jsxs("div", { className: "text-white", children: [formatBytes(g.memory_used_bytes), " / ", formatBytes(g.memory_total_bytes), " (", g.memory_used_percent.toFixed(1), "%)"] })] }), _jsxs("div", { children: [_jsx("span", { className: "text-gray-400", children: "Temp" }), _jsxs("div", { className: "text-white", children: [g.temperature_celsius, "\u00B0C"] })] }), _jsxs("div", { children: [_jsx("span", { className: "text-gray-400", children: "VRAM Temp" }), _jsxs("div", { className: "text-white", children: [g.vram_temperature_celsius, "\u00B0C"] })] }), _jsxs("div", { children: [_jsx("span", { className: "text-gray-400", children: "Power" }), _jsxs("div", { className: "text-white", children: [g.power_draw_watts, " W"] })] }), _jsxs("div", { children: [_jsx("span", { className: "text-gray-400", children: "Fan" }), _jsxs("div", { className: "text-white", children: [g.fan_speed_percent, "%"] })] })] })] }, g.id))) })), _jsx("h3", { className: "text-lg font-semibold text-white mb-4", children: "System Details" }), _jsx("div", { className: "grid grid-cols-2 gap-6", children: _jsx("div", { className: "space-y-2 rounded-xl border border-gray-700 bg-gray-900/50 p-5", children: _jsxs("div", { className: "flex justify-between text-sm", children: [_jsx("span", { className: "text-gray-400", children: "Uptime" }), _jsx("span", { className: "text-white", children: formatUptime(sysMetrics?.uptime_seconds ?? 0) })] }) }) })] }));
}
