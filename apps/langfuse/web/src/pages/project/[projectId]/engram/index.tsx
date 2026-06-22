import { useRouter } from "next/router";
import Page from "@/src/components/layouts/page";
import { api } from "@/src/utils/api";

export default function EngramDashboard() {
  const router = useRouter();
  const projectId = router.query.projectId as string;
  const { data } = api.engram.getMemoryStats.useQuery({ projectId }, { enabled: !!projectId });

  return (
    <Page headerProps={{ title: "Engram Dashboard", help: { description: "Memory engine overview" } }}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-lg border p-4">
          <h3 className="text-sm font-medium text-muted-foreground">Total Memories</h3>
          <p className="text-3xl font-bold">{data?.length ? data.reduce((a: number, r: any) => a + Number(r.count), 0) : 0}</p>
        </div>
        <div className="rounded-lg border p-4">
          <h3 className="text-sm font-medium text-muted-foreground">Genome</h3>
          <p className="text-3xl font-bold">{data?.find((r: any) => r.genome_count)?.genome_count || 0}</p>
        </div>
        <div className="rounded-lg border p-4">
          <h3 className="text-sm font-medium text-muted-foreground">Phenotype</h3>
          <p className="text-3xl font-bold">{data?.find((r: any) => r.phenotype_count)?.phenotype_count || 0}</p>
        </div>
      </div>
      <div className="mt-6">
        <h3 className="mb-2 text-lg font-semibold">Memories by Sector</h3>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
          {data?.map((row: any) => (
            <div key={row.sector} className="rounded-lg border p-3">
              <p className="text-sm capitalize">{row.sector || "unknown"}</p>
              <p className="text-xl font-bold">{row.count}</p>
            </div>
          ))}
        </div>
      </div>
    </Page>
  );
}
