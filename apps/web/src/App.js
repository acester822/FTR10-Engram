import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect, useCallback } from "react";
import { Skull, Database, Activity, Trash2, Edit2, Save, X, Search, RefreshCw, FileText } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
const API_BASE = "/api/dashboard";
export default function App() {
    const [activeTab, setActiveTab] = useState("dashboard");
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);
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
    return (_jsxs("div", { className: "min-h-screen bg-gray-50 text-gray-900 font-sans flex", children: [_jsxs("aside", { className: "fixed left-0 top-0 h-full w-64 bg-slate-900 text-white p-6 flex flex-col z-20", children: [_jsxs("div", { className: "flex items-center gap-3 mb-10", children: [_jsx(Skull, { className: "w-8 h-8 text-blue-400" }), _jsx("h1", { className: "text-xl font-bold tracking-tight", children: "CodeCortex" })] }), _jsxs("nav", { className: "space-y-2 flex-1", children: [_jsx(NavButton, { active: activeTab === "dashboard", onClick: () => setActiveTab("dashboard"), icon: _jsx(Activity, { size: 20 }), children: "Dashboard" }), _jsx(NavButton, { active: activeTab === "memories", onClick: () => setActiveTab("memories"), icon: _jsx(Database, { size: 20 }), children: "Memory Explorer" }), _jsx(NavButton, { active: activeTab === "logs", onClick: () => setActiveTab("logs"), icon: _jsx(FileText, { size: 20 }), children: "Interaction Logs" })] }), _jsxs("div", { className: "pt-6 border-t border-slate-700 text-xs text-slate-400", children: [_jsx("p", { children: "v2.0.0 Cognitive Engine" }), _jsx("p", { className: "mt-1", children: "Local-first \u2022 SQLite/Postgres" })] })] }), _jsxs("main", { className: "ml-64 p-8 w-full min-h-screen", children: [activeTab === "dashboard" && (_jsx(DashboardView, { stats: stats, onRefresh: fetchStats })), activeTab === "memories" && _jsx(MemoriesView, {}), activeTab === "logs" && _jsx(LogsView, {})] })] }));
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
        setEditForm({ content: m.content, sector: m.sector || "semantic", is_genome: m.is_genome === 1 ? 1 : 0 });
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
                method: "PATCH",
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
    return (_jsxs("div", { className: "space-y-6", children: [_jsx("h2", { className: "text-2xl font-bold text-slate-800", children: "Memory Explorer" }), _jsxs("div", { className: "flex gap-4", children: [_jsxs("div", { className: "relative flex-1", children: [_jsx(Search, { className: "absolute left-3 top-3 text-slate-400", size: 20 }), _jsx("input", { type: "text", placeholder: "Search memories...", className: "w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white", value: search, onChange: (e) => setSearch(e.target.value) })] }), _jsxs("select", { className: "px-4 py-2.5 border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-blue-500 outline-none", value: sectorFilter, onChange: (e) => setSectorFilter(e.target.value), children: [_jsx("option", { value: "all", children: "All Sectors" }), _jsx("option", { value: "semantic", children: "Semantic" }), _jsx("option", { value: "episodic", children: "Episodic" }), _jsx("option", { value: "procedural", children: "Procedural" }), _jsx("option", { value: "emotional", children: "Emotional" }), _jsx("option", { value: "reflective", children: "Reflective" })] })] }), _jsx("div", { className: "bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden", children: _jsxs("table", { className: "w-full text-left", children: [_jsx("thead", { className: "bg-gray-50 border-b border-gray-200", children: _jsxs("tr", { children: [_jsx("th", { className: "px-6 py-4 text-xs font-semibold text-slate-500 uppercase", children: "Content" }), _jsx("th", { className: "px-6 py-4 text-xs font-semibold text-slate-500 uppercase", children: "Sector" }), _jsx("th", { className: "px-6 py-4 text-xs font-semibold text-slate-500 uppercase", children: "Type" }), _jsx("th", { className: "px-6 py-4 text-xs font-semibold text-slate-500 uppercase", children: "Age" }), _jsx("th", { className: "px-6 py-4 text-xs font-semibold text-slate-500 uppercase text-right", children: "Actions" })] }) }), _jsxs("tbody", { className: "divide-y divide-gray-100", children: [memories.map((m) => (_jsxs("tr", { className: "hover:bg-gray-50 transition-colors", children: [_jsx("td", { className: "px-6 py-4", children: editingId === m.id ? (_jsx("textarea", { className: "w-full p-2 border border-blue-300 rounded text-sm focus:ring-2 focus:ring-blue-500 outline-none", rows: 3, value: editForm.content, onChange: (e) => setEditForm({ ...editForm, content: e.target.value }) })) : (_jsx("p", { className: "text-sm text-slate-800 line-clamp-2 whitespace-pre-wrap", children: escapeHtml(m.content) })) }), _jsx("td", { className: "px-6 py-4", children: editingId === m.id ? (_jsx("select", { className: "text-sm border rounded p-1", value: editForm.sector, onChange: (e) => setEditForm({ ...editForm, sector: e.target.value }), children: ["semantic", "episodic", "procedural", "emotional", "reflective"].map((s) => (_jsx("option", { value: s, children: s }, s))) })) : (_jsx("span", { className: "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 capitalize", children: m.sector || "unknown" })) }), _jsx("td", { className: "px-6 py-4", children: editingId === m.id ? (_jsxs("select", { className: "text-sm border rounded p-1", value: editForm.is_genome, onChange: (e) => setEditForm({ ...editForm, is_genome: parseInt(e.target.value) }), children: [_jsx("option", { value: 0, children: "Phenotype" }), _jsx("option", { value: 1, children: "Genome" })] })) : (m.is_genome === 1 ? (_jsxs("span", { className: "flex items-center gap-1 text-xs font-medium text-amber-600", children: [_jsx(Skull, { size: 14 }), " Genome"] })) : (_jsx("span", { className: "text-xs text-slate-400", children: "Phenotype" }))) }), _jsx("td", { className: "px-6 py-4 text-sm text-slate-500", children: m.created_at ? formatDistanceToNow(new Date(m.created_at), { addSuffix: true }) : (m.recorded_at ? formatDistanceToNow(new Date(m.recorded_at), { addSuffix: true }) : "N/A") }), _jsx("td", { className: "px-6 py-4 text-right", children: editingId === m.id ? (_jsxs("div", { className: "flex justify-end gap-2", children: [_jsx("button", { onClick: saveEdit, disabled: saving, className: "p-1.5 text-emerald-600 hover:bg-emerald-50 rounded disabled:opacity-50", children: _jsx(Save, { size: 18 }) }), _jsx("button", { onClick: () => setEditingId(null), className: "p-1.5 text-slate-500 hover:bg-gray-100 rounded", children: _jsx(X, { size: 18 }) })] })) : (_jsxs("div", { className: "flex justify-end gap-2", children: [_jsx("button", { onClick: () => startEdit(m), className: "p-1.5 text-blue-600 hover:bg-blue-50 rounded", children: _jsx(Edit2, { size: 18 }) }), _jsx("button", { onClick: () => handleDelete(m.id), className: "p-1.5 text-red-600 hover:bg-red-50 rounded", children: _jsx(Trash2, { size: 18 }) })] })) })] }, m.id))), memories.length === 0 && (_jsx("tr", { children: _jsx("td", { colSpan: 5, className: "px-6 py-12 text-center text-slate-400", children: "No memories found matching your criteria." }) }))] })] }) })] }));
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
    if (loading)
        return _jsx("div", { className: "text-slate-500", children: "Loading interaction logs..." });
    return (_jsxs("div", { className: "space-y-6", children: [_jsx("h2", { className: "text-2xl font-bold text-slate-800", children: "Interaction & Extraction Logs" }), _jsx("div", { className: "bg-white rounded-xl shadow-sm border border-gray-200 p-6", children: logs.length === 0 ? (_jsx("p", { className: "text-center text-slate-400 py-8", children: "No interaction logs available." })) : (_jsx("div", { className: "space-y-6", children: logs.map((log, idx) => (_jsxs("div", { className: "flex gap-4 relative pb-6 last:pb-0", children: [idx !== logs.length - 1 && (_jsx("div", { className: "absolute left-3.5 top-8 bottom-[-24px] w-0.5 bg-gray-200" })), _jsx("div", { className: `w-7 h-7 rounded-full flex items-center justify-center shrink-0 z-10 ${log.is_genome === 1 ? "bg-amber-100 text-amber-600" : "bg-blue-100 text-blue-600"}`, children: log.is_genome === 1 ? _jsx(Skull, { size: 14 }) : _jsx(Activity, { size: 14 }) }), _jsxs("div", { className: "flex-1", children: [_jsxs("div", { className: "flex justify-between items-start mb-1", children: [_jsxs("span", { className: "text-sm font-semibold text-slate-800 capitalize", children: [log.sector || "unknown", " Memory", " ", log.is_genome === 1 ? "(Genome)" : "(Phenotype)"] }), _jsx("span", { className: "text-xs text-slate-400", children: log.created_at ? formatDistanceToNow(new Date(log.created_at), { addSuffix: true }) : (log.recorded_at ? formatDistanceToNow(new Date(log.recorded_at), { addSuffix: true }) : "N/A") })] }), _jsx("p", { className: "text-sm text-slate-600 bg-gray-50 p-3 rounded-lg border border-gray-100 whitespace-pre-wrap", children: escapeHtml(log.content) }), _jsxs("p", { className: "text-xs text-slate-400 mt-1", children: ["ID: ", log.id] })] })] }, log.id))) })) })] }));
}
function escapeHtml(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
