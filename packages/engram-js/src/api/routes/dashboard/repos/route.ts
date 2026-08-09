/*
 - filename: packages/engram-js/src/api/routes/dashboard/repos/route.ts
 - what is the file used for: Repo baseline indexing dashboard endpoints
   (v4.7.0-repo-index): index (URL or local path), list, progress, reindex,
   delete (supersede all + audit), recall-test against a repo's memories.
*/

import { bad, fail } from "../../_kit";
import { listRepos, getRepo, updateRepoStatus } from "../../../../services/repoStore";
import { indexRepo, deleteIndexedRepo, recallRepoTest, getRepoIndexProgress } from "../../../../services/repoIndexer";

export const dashboard_repos_route = (app: any) => {
  // POST /api/dashboard/repos/index {source} — start an index run (async).
  app.post("/api/dashboard/repos/index", async (req: any, res: any) => {
    try {
      const source = String(req.body?.source || "").trim();
      if (!source) return bad(res, "source", "missing source");
      const result = await indexRepo(source);
      if (result.ok) return res.json({ ok: true, files: result.files, memories: result.memories, commits: result.commits, reverts: result.reverts, edges: result.edges, skipped: result.skipped, repo_id: result.repo_id });
      if (result.already_running) return res.status(409).json({ ok: false, error: result.error });
      return fail(res, "repo_index_failed", new Error(result.error || "failed"));
    } catch (e) {
      fail(res, "repo_index_failed", e);
    }
  });

  // GET /api/dashboard/repos — list indexed repos with stats.
  app.get("/api/dashboard/repos", async (_req: any, res: any) => {
    try {
      const repos = await listRepos();
      res.json({ ok: true, repos });
    } catch (e) {
      fail(res, "repos_list_failed", e);
    }
  });

  // GET /api/dashboard/repos/progress — live progress of a running index.
  app.get("/api/dashboard/repos/progress", async (_req: any, res: any) => {
    try {
      res.json({ ok: true, ...getRepoIndexProgress() });
    } catch (e) {
      fail(res, "repos_progress_failed", e);
    }
  });

  // POST /api/dashboard/repos/:id/reindex — re-run (supersede + fresh).
  app.post("/api/dashboard/repos/:id/reindex", async (req: any, res: any) => {
    try {
      const repo = await getRepo(req.params.id);
      if (!repo) return bad(res, "id", "repo not found");
      await updateRepoStatus(repo.id, { status: "indexing", error: null });
      const result = await indexRepo(repo.source);
      if (result.ok) return res.json({ ok: true, files: result.files, memories: result.memories, commits: result.commits, reverts: result.reverts, edges: result.edges, skipped: result.skipped, repo_id: result.repo_id });
      return fail(res, "repo_reindex_failed", new Error(result.error || "failed"));
    } catch (e) {
      fail(res, "repo_reindex_failed", e);
    }
  });

  // DELETE /api/dashboard/repos/:id — supersede all its memories (audited,
  // undoable) + drop the row.
  app.delete("/api/dashboard/repos/:id", async (req: any, res: any) => {
    try {
      const result = await deleteIndexedRepo(req.params.id);
      if (!result.ok) return bad(res, "id", result.error || "repo not found");
      res.json({ ok: true, superseded: result.superseded });
    } catch (e) {
      fail(res, "repo_delete_failed", e);
    }
  });

  // GET /api/dashboard/repos/:id/recall-test?query= — demo recall against a
  // repo's indexed memories only.
  app.get("/api/dashboard/repos/:id/recall-test", async (req: any, res: any) => {
    try {
      const query = String(req.query?.query || "").trim();
      if (!query) return bad(res, "query", "missing query");
      const result = await recallRepoTest(req.params.id, query);
      if (result.error) return fail(res, "repo_recall_failed", new Error(result.error));
      res.json({ ok: true, results: result.results });
    } catch (e) {
      fail(res, "repo_recall_failed", e);
    }
  });
};
