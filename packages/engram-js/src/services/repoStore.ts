/*
 - filename: packages/engram-js/src/services/repoStore.ts
 - what is the file used for: `repos` table CRUD — the repo baseline indexing
   ledger (v4.7.0-repo-index). One row per indexed repo (URL clone or local
   path). Status machine: idle → indexing → ready | error. Re-index and delete
   go through here so the GUI always reads the same source of truth.
*/

import { all_async as pg_all, run_async as pg_run } from "../database/connection";

export interface RepoRow {
  id: string;
  name: string;
  source_type: "url" | "path";
  source: string;
  root: string | null;
  status: "idle" | "indexing" | "ready" | "error";
  last_indexed_at: string | null;
  file_count: number;
  memory_count: number;
  commit_count: number;
  revert_count: number;
  error: string | null;
  created_at: string;
  head_sha?: string | null;
}

export async function listRepos(): Promise<RepoRow[]> {
  return pg_all(
    `SELECT id, name, source_type, source, root, status, last_indexed_at,
            file_count, memory_count, commit_count, revert_count, error, created_at, head_sha
     FROM public.repos ORDER BY created_at DESC`,
  ).catch(() => [] as RepoRow[]);
}

export async function getRepo(id: string): Promise<RepoRow | null> {
  const rows = await pg_all(
    `SELECT id, name, source_type, source, root, status, last_indexed_at,
            file_count, memory_count, commit_count, revert_count, error, created_at, head_sha
     FROM public.repos WHERE id = $1::uuid`,
    [id],
  ).catch(() => [] as any[]);
  return rows[0] ?? null;
}

export async function getRepoBySource(source: string): Promise<RepoRow | null> {
  const rows = await pg_all(
    `SELECT id, name, source_type, source, root, status, last_indexed_at,
            file_count, memory_count, commit_count, revert_count, error, created_at, head_sha
     FROM public.repos WHERE source = $1`,
    [source],
  ).catch(() => [] as any[]);
  return rows[0] ?? null;
}

export async function createRepo(r: {
  name: string;
  source_type: "url" | "path";
  source: string;
  root: string;
}): Promise<RepoRow> {
  const rows = await pg_run(
    `INSERT INTO public.repos (name, source_type, source, root)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source) DO UPDATE SET name = EXCLUDED.name, root = EXCLUDED.root
     RETURNING id, name, source_type, source, root, status, last_indexed_at,
               file_count, memory_count, commit_count, revert_count, error, created_at, head_sha`,
    [r.name, r.source_type, r.source, r.root],
  );
  // pg_run may return rows on RETURNING; if not, refetch.
  const row = Array.isArray(rows) ? rows[0] : null;
  if (row) return row as RepoRow;
  const existing = await getRepoBySource(r.source);
  if (existing) return existing;
  throw new Error("repo upsert failed");
}

export async function updateRepoStatus(
  id: string,
  patch: Partial<Pick<RepoRow, "status" | "error" | "last_indexed_at" | "file_count" | "memory_count" | "commit_count" | "revert_count" | "head_sha">>,
): Promise<void> {
  const sets: string[] = [];
  const params: any[] = [id];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  if (!sets.length) return;
  await pg_run(`UPDATE public.repos SET ${sets.join(", ")} WHERE id = $1::uuid`, params);
}

export async function deleteRepo(id: string): Promise<boolean> {
  const r = await pg_run(`DELETE FROM public.repos WHERE id = $1::uuid`, [id]);
  return true;
}
