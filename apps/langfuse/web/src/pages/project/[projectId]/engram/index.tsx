import { useRouter } from "next/router";
import Page from "@/src/components/layouts/page";
import { api } from "@/src/utils/api";

export default function EngramDashboard() {
  const router = useRouter();
  const projectId = router.query.projectId as string;
  const { data, isLoading, error } = api.engram.getMemoryStats.useQuery({ projectId }, { enabled: !!projectId });

  if (isLoading) return <Page headerProps={{ title: "Dashboard", help: { description: "Memory engine overview" } }}><p className="text-muted-foreground">Loading...</p></Page>;
  if (error) return <Page headerProps={{ title: "Dashboard", help: { description: "Memory engine overview" } }}><div className="rounded border border-destructive/30 bg-destructive/5 p-4"><p className="text-destructive">{error.message}</p></div></Page>;

  const total = data?.reduce((a: number, r: any) => a + Number(r.count), 0) || 0;
  const genomeCount = data?.find((r: any) => r.genome_count)?.genome_count || 0;
  const phenotypeCount = data?.find((r: any) => r.phenotype_count)?.phenotype_count || 0;

  return (
    <Page headerProps={{ title: "Dashboard", help: { description: "Memory engine overview" } }}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-lg border p-4">
          <h3 className="text-sm font-medium text-muted-foreground">Total Memories</h3>
          <p className="text-3xl font-bold">{total}</p>
        </div>
        <div className="rounded-lg border p-4">
          <h3 className="text-sm font-medium text-muted-foreground">Genome</h3>
          <p className="text-3xl font-bold">{genomeCount}</p>
        </div>
        <div className="rounded-lg border p-4">
          <h3 className="text-sm font-medium text-muted-foreground">Phenotype</h3>
          <p className="text-3xl font-bold">{phenotypeCount}</p>
        </div>
      </div>
      {data && data.length > 0 ? (
        <div className="mt-6">
          <h3 className="mb-2 text-lg font-semibold">Memories by Sector</h3>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            {data.map((row: any) => (
              <div key={row.sector} className="rounded-lg border p-3">
                <p className="text-sm capitalize">{row.sector || "unknown"}</p>
                <p className="text-xl font-bold">{row.count}</p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-6 rounded-lg border border-dashed p-8 text-center">
          <p className="text-muted-foreground">No memories yet. Memories will appear here once the Engram memory engine has processed conversations.</p>
        </div>
      )}
    </Page>
  );
}
