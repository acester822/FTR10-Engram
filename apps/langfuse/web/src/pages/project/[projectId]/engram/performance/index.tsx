import { useRouter } from "next/router";
import Page from "@/src/components/layouts/page";
import { api } from "@/src/utils/api";

export default function EngramPerformance() {
  const router = useRouter();
  const projectId = router.query.projectId as string;
  const { data, isLoading, error } = api.engram.getPerformance.useQuery(
    { projectId },
    { enabled: !!projectId },
  );

  return (
    <Page headerProps={{ title: "Engram Performance", help: { description: "System performance metrics from Engram" } }}>
      {isLoading && <p className="text-muted-foreground">Loading...</p>}
      {error && <p className="text-destructive">Error: {error.message}</p>}
      {!isLoading && !error && data?.error && (
        <div className="rounded border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-destructive">{data.error}</p>
        </div>
      )}
      {!isLoading && !error && data && !("error" in data) && (
        <pre className="overflow-x-auto rounded border bg-muted/30 p-4 text-xs">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </Page>
  );
}
