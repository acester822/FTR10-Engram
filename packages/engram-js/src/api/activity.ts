/*
 * In-memory request-activity ring buffer.
 *
 * Captures actual inbound/outbound memory traffic so a connected client
 * (e.g. Hermes) can be observed *using* memory: writes (incoming) vs reads
 * (outgoing). Kept bounded (MAX_ACTIVITY) so it can never grow the server's
 * memory. Exposed to the GUI via GET /api/dashboard/activity.
 */

const MAX_ACTIVITY = 500;
export const activityLog: any[] = [];

export interface ActivityClass {
  direction: "in" | "out";
  kind: "write" | "read";
  label: string;
}

/**
 * Genome/phenotype/sector breakdown for an activity entry.
 *
 * Derivable only from the response payload (the Hermes plugin makes the
 * request, so the server — not any client — must compute the counts that feed
 * the "2 Genome + 1 Phenotype injected" style notifications).
 */
export interface ActivityBreakdown {
  genome: number;
  phenotype: number;
  sectors: Record<string, number>;
}

function _isGenome(v: any): boolean {
  return v === true || v === 1 || v === "true" || v === "t" || v === "True";
}

/**
 * Pure derivation of a memory traffic breakdown from the request body and the
 * JSON response. Kept side-effect-free and exported so it can be unit-tested
 * without booting the server.
 *
 * - recall (read): tally genome vs phenotype + per-sector from `results[].is_genome`/`sector`.
 * - ingest/conversation (write): read `extraction.sectors` + `extraction.stored_count`
 *   (ingest never promotes to genome — allowGenome=false on that route).
 * - /memories (write): explicit remember — genome when `body.is_genome`, else phenotype.
 */
export function deriveBreakdown(
  cls: ActivityClass,
  body: any,
  respJson: any,
): ActivityBreakdown | undefined {
  const empty = (): ActivityBreakdown => ({ genome: 0, phenotype: 0, sectors: {} });
  if (!respJson || typeof respJson !== "object") return undefined;

  if (cls.kind === "read") {
    const results = respJson.results || respJson.memories;
    if (!Array.isArray(results) || results.length === 0) return empty();
    const b = empty();
    for (const r of results) {
      if (_isGenome(r?.is_genome)) b.genome++;
      else b.phenotype++;
      const sector = typeof r?.sector === "string" ? r.sector : "unknown";
      b.sectors[sector] = (b.sectors[sector] || 0) + 1;
    }
    return b;
  }

  // write: ingest/conversation exposes a structured extraction object
  const extraction = respJson.extraction;
  if (extraction && (extraction.sectors || typeof extraction.stored_count === "number")) {
    const b = empty();
    const sectors: Record<string, number> = extraction.sectors || {};
    b.sectors = sectors;
    const bySector = Object.values(sectors).reduce(
      (a: number, c: any) => a + (Number(c) || 0),
      0,
    );
    b.phenotype = bySector || (extraction.stored_count || 0);
    b.genome = 0; // ingest/conversation route passes allowGenome=false
    return b;
  }

  // write: explicit /memories remember
  if (body && body.is_genome) return { genome: 1, phenotype: 0, sectors: {} };
  if (body && typeof body.content === "string") return { genome: 0, phenotype: 1, sectors: {} };

  return empty();
}

export function classifyActivity(method: string, url: string): ActivityClass | null {
  const u = url.split("?")[0];
  // Writes (memory being saved / ingested)
  if (method === "POST" && u === "/memories")
    return { direction: "in", kind: "write", label: "remember" };
  if (
    method === "POST" &&
    (u === "/ingest" || u === "/ingest/conversation" || u === "/ingest/document")
  )
    return { direction: "in", kind: "write", label: "ingest" };
  // Reads (memory being recalled/retrieved)
  if (method === "POST" && (u === "/recall" || u === "/api/dashboard/recall"))
    return { direction: "out", kind: "read", label: "recall" };
  return null;
}

export function recordActivity(entry: any) {
  activityLog.push(entry);
  if (activityLog.length > MAX_ACTIVITY) activityLog.shift();
}

/** Convenience builder so callers can attach a pre-computed breakdown. */
export function makeActivityEntry(base: any, breakdown?: ActivityBreakdown | null): any {
  return breakdown ? { ...base, breakdown } : base;
}

export function clearActivity() {
  activityLog.length = 0;
}
