import { useState } from "react";
import { useRouter } from "next/router";
import Page from "@/src/components/layouts/page";
import { api } from "@/src/utils/api";

export default function EngramMemories() {
  const router = useRouter();
  const projectId = router.query.projectId as string | undefined;
  if (!projectId) return <Page headerProps={{ title: "Engram Memories" }}><div className="p-8 text-center">Loading...</div></Page>;

  const [search, setSearch] = useState("");
  const [sector, setSector] = useState("all");
  const limit = 100;

  const { data, isLoading } = api.engram.listMemories.useQuery(
    { projectId, search: search || undefined, sector: sector === "all" ? undefined : sector, limit },
    { enabled: !!projectId },
  );

 if (isLoading) return <Page headerProps={{ title: "Engram Memories", help: { description: "Browse and manage Engram memories" } }}><p className="text-muted-foreground">Loading...</p></Page>;
  if (!data || data.length === 0) return <Page headerProps={{ title: "Engram Memories", help: { description: "Browse and manage Engram memories" } }}><div className="rounded border border-dashed p-8 text-center"><p className="text-muted-foreground">No memories found. Memories will appear here once the Engram memory engine has processed conversations.</p></div></Page>;

  return (
    <Page headerProps={{ title: "Engram Memories", help: { description: "Browse and manage Engram memories" } }}>
      <div className="mb-4 flex gap-2">
        <input
          type="text"
          placeholder="Search memories..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded border px-3 py-2 text-sm"
        />
        <select
          value={sector}
          onChange={(e) => setSector(e.target.value)}
          className="rounded border px-3 py-2 text-sm"
        >
          <option value="all">All Sectors</option>
          <option value="semantic">Semantic</option>
          <option value="procedural">Procedural</option>
          <option value="episodic">Episodic</option>
          <option value="emotional">Emotional</option>
          <option value="reflective">Reflective</option>
        </select>
      </div>
      <div className="overflow-x-auto rounded border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Sector</th>
                <th className="px-4 py-2 text-left font-medium">Content</th>
                <th className="px-4 py-2 text-left font-medium">Recorded</th>
              </tr>
            </thead>
            <tbody>
              {data?.map((row: any) => (
                <tr key={row.id} className="border-t">
                  <td className="px-4 py-2 capitalize">{row.sector || "unknown"}</td>
                  <td className="max-w-md px-4 py-2 truncate font-mono text-xs">{row.content}</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {new Date(row.recorded_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
    </Page>
  );
}
