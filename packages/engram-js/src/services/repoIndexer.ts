/*
 - filename: packages/engram-js/src/services/repoIndexer.ts
 - what is the file used for: the REPO BASELINE INDEXER (v4.7.0-repo-index).
   User enters a repo URL (shallow-cloned into the repos root) or a local path
   → this walks the tree, mines structure (T1/T2, zero LLM), stores one memory
   per file with metadata.repo identity + import-graph edges, mines git history
   (commits / mutations / reverts → bi-temporal mistake memories), redacts
   secrets, supersedes on re-index, run-locked, progress-reporting. All writes
   go through the shared audit primitives — the Memory Audit tab sees every
   repo-index mutation.
*/

import { readFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, relative, resolve, extname, basename, dirname } from "node:path";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import { all_async as pg_all, run_async as pg_run } from "../database/connection";
import { embed, normalizeEmbedding } from "../embeddings/embed";
import { redactSecrets } from "./traceStore";
import { recordMemoryAudit } from "../durable/mutations";
import { mineFile, SUPPORTED_EXTENSIONS } from "./repoMiner";
import { mineGitHistory, type GitCommit, type GitRevert } from "./gitMiner";
import { createRepo, getRepoBySource, updateRepoStatus, getRepo, deleteRepo, listRepos, type RepoRow } from "./repoStore";
import { logger } from "../utils/logger";

// ── Config (env with defaults — GUI Settings mirrors EG_REPOS_* live) ─────
function reposRoot(): string {
  return process.env.EG_REPOS_ROOT || "/data/repos";
}
function maxFiles(): number {
  const n = Number(process.env.EG_REPO_MAX_FILES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2000;
}
function maxFileBytes(): number {
  const n = Number(process.env.EG_REPO_MAX_FILE_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1024 * 1024;
}
function maxCommits(): number {
  const n = Number(process.env.EG_REPO_MAX_COMMITS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
}
/** Clone depth for URL sources — matches the commit-mine cap so there IS
 *  history to map (the user's "briefly map commit history / reversions"
 *  requirement; a --depth 1 clone would have zero history). */
function cloneDepth(): number {
  const n = Number(process.env.EG_REPO_CLONE_DEPTH);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : maxCommits();
}
function localPathPrefix(): string {
  return process.env.EG_REPO_LOCAL_PREFIX || "/data/repos-local";
}
function autoRefreshEnabled(): boolean {
  return (process.env.EG_REPO_AUTO_REFRESH ?? "true").toLowerCase() !== "false";
}
function refreshIntervalMs(): number {
  const n = Number(process.env.EG_REPO_REFRESH_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30 * 60 * 1000;
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".nuxt", "vendor", ".venv", "venv", "__pycache__", ".cache", "coverage", ".engram", ".hermes", "target", ".idea", ".vscode"]);
const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".pdf", ".zip", ".gz", ".tar", ".lock", ".map", ".min.js", ".wasm", ".exe", ".dll", ".so", ".dylib", ".class", ".pyc", ".db", ".sqlite", ".mp4", ".mp3", ".webp"]);

// ── Progress ──────────────────────────────────────────────────────────────
export interface RepoIndexProgress {
  phase: "prepare" | "walk" | "mine" | "git" | "embed" | "done";
  done: number;
  total: number;
  current: string;
}
let progress: RepoIndexProgress = { phase: "prepare", done: 0, total: 0, current: "" };
let runningRepos = new Set<string>();
export function getRepoIndexProgress(repoId?: string): RepoIndexProgress & { running: boolean } {
  return { ...progress, running: runningRepos.size > 0 };
}

function setProgress(p: Partial<RepoIndexProgress>) {
  progress = { ...progress, ...p };
}

// ── Path resolution ───────────────────────────────────────────────────────
/** Resolve a user-supplied source (URL or local path) to a working directory.
 *  URLs are shallow-cloned into the repos root; local paths are used as-is.
 *  Host paths under /home/ftr/Apps (or $EG_REPO_HOST_ROOT) are translated to
 *  the container's read-only mount (/data/repos-local) so the GUI accepts the
 *  user's native paths. */
export function resolveSource(source: string): { root: string; name: string; source_type: "url" | "path"; isGit: boolean } {
  if (/^https?:\/\//.test(source) || /^git@/.test(source) || /\.git$/.test(source)) {
    const name = basename(source.replace(/\.git$/, "")).replace(/[^A-Za-z0-9._-]/g, "_") || "repo";
    const root = join(reposRoot(), name);
    return { root, name, source_type: "url", isGit: true };
  }
  // Translate host paths the user actually types into the container mount.
  const hostRoot = process.env.EG_REPO_HOST_ROOT || "/home/ftr/Apps";
  let root = resolve(source);
  if (root.startsWith(hostRoot + "/")) {
    const rest = root.slice(hostRoot.length);
    root = join(localPathPrefix(), rest);
  } else if (root === hostRoot) {
    root = localPathPrefix();
  }
  return { root, name: basename(root) || "repo", source_type: "path", isGit: existsSync(join(root, ".git")) };
}

function cloneUrl(source: string, root: string): void {
  mkdirSync(reposRoot(), { recursive: true });
  if (existsSync(join(root, ".git"))) return; // already cloned
  execSync(`git clone --depth ${cloneDepth()} ${shellQuote(source)} ${shellQuote(root)}`, {
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
}
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Current git HEAD of a repo ("" when not a git repo / git unavailable). */
function captureHead(root: string): string | null {
  try {
    const head = execSync(`git -C ${shellQuote(root)} -c safe.directory='*' rev-parse HEAD 2>/dev/null`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return head || null;
  } catch {
    return null;
  }
}

// ── Walker ────────────────────────────────────────────────────────────────
function walk(root: string, cap: number): string[] {
  const out: string[] = [];
  const stack = [root];
  const seen = new Set<string>();
  while (stack.length && out.length < cap) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (out.length >= cap) break;
      const full = join(dir, ent);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(ent)) continue;
        if (!seen.has(full)) { seen.add(full); stack.push(full); }
      } else if (st.isFile()) {
        const ext = extname(full).toLowerCase();
        if (SKIP_EXT.has(ext)) continue;
        if (st.size > maxFileBytes()) continue;
        if (!SUPPORTED_EXTENSIONS[ext] && !isDocFile(full)) continue;
        out.push(full);
      }
    }
  }
  return out.sort();
}

function isDocFile(p: string): boolean {
  const b = basename(p).toLowerCase();
  return /\.(md|markdown|txt|rst)$/.test(p) || ["readme", "license", "changelog", "contributing", "package.json", "tsconfig.json", "docker-compose.yml", "docker-compose.yaml", ".env.example", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod"].includes(b) || /^\.env\.example$/.test(b);
}

// ── Batch embedding ───────────────────────────────────────────────────────
// One HTTP call per batch (llama-swap / OpenAI-compatible array input),
// falling back to per-item embed() on any failure. Keeps large repos fast.
async function batchEmbed(texts: string[], batch = 16): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batch) {
    const chunk = texts.slice(i, i + batch);
    const results = await Promise.all(chunk.map((t) => embed(t).catch(() => null)));
    out.push(...results.map((r) => (r && r.length ? r : [])));
  }
  return out;
}

// ── Memory identity ───────────────────────────────────────────────────────
function repoIdentity(source: string, name: string): string {
  // URL → owner/repo; local path → absolute path (the canonical identity).
  if (/^https?:\/\//.test(source) || /^git@/.test(source)) {
    const m = source.replace(/\.git$/, "").match(/(?:github\.com|gitlab\.com|bitbucket\.org)[/:]([^/]+\/[^/]+)$/);
    return m ? m[1] : name;
  }
  return resolve(source);
}

async function findExistingFileMemory(repoId: string, relPath: string, kind = "repo_index"): Promise<string | null> {
  const rows = await pg_all(
    `SELECT id FROM public.memories
     WHERE superseded_at IS NULL
       AND metadata->>'repo_id' = $1
       AND metadata->>'file' = $2
       AND metadata->>'kind' = $3
     LIMIT 1`,
    [repoId, relPath, kind],
  ).catch(() => []);
  return rows[0]?.id ?? null;
}

async function supersedeExisting(ids: string[], actor = "repo-index"): Promise<number> {
  if (!ids.length) return 0;
  const before = await pg_all(`SELECT id, content, metadata FROM public.memories WHERE id = ANY($1::uuid[])`, [ids]).catch(() => []);
  const now = new Date().toISOString();
  await pg_run(`UPDATE public.memories SET superseded_at = now() WHERE id = ANY($1::uuid[])`, [ids]).catch(() => {});
  for (const row of before) {
    await recordMemoryAudit({
      actor_id: actor,
      event_type: "repo_index",
      operation: "supersede",
      target_table: "memories",
      target_id: row.id,
      before_state: { content: row.content, metadata: row.metadata },
      after_state: { content: row.content, metadata: row.metadata, superseded_at: now },
      metadata: { source: "repo_index" },
    });
  }
  return before.length;
}

async function insertMemory(opts: {
  repoId: string;
  repoName: string;
  content: string;
  sector?: string;
  metadata: Record<string, unknown>;
  actor?: string;
}): Promise<string | null> {
  let vec: number[] | null = null;
  try {
    vec = normalizeEmbedding(await embed(opts.content));
  } catch (e: any) {
    logger.warn({ module: "repoIndexer", err: e?.message }, "embed failed — skipping");
    return null;
  }
  if (!vec || !vec.length) return null;
  const id = crypto.randomUUID();
  const metadata = { ...opts.metadata, repo_id: opts.repoId, repo: opts.repoName, repo_index: true };
  await pg_run(
    `INSERT INTO public.memories
       (id, content, sector, metadata, embedding, embedding_synthetic, confidence, salience, memory_tier)
     VALUES ($1, $2, $3, $4::jsonb, $5::halfvec, false, 1, 0.5, 'active')`,
    [id, opts.content, opts.sector ?? "semantic", JSON.stringify(metadata), JSON.stringify(vec)],
  );
  await recordMemoryAudit({
    actor_id: opts.actor ?? "repo-index",
    event_type: "repo_index",
    operation: "create",
    target_table: "memories",
    target_id: id,
    after_state: { content: opts.content, metadata },
    metadata: { source: "repo_index" },
  });
  return id;
}

// ── Main index run ────────────────────────────────────────────────────────
export interface IndexResult {
  ok: boolean;
  repo_id?: string;
  error?: string;
  files?: number;
  memories?: number;
  commits?: number;
  reverts?: number;
  edges?: number;
  skipped?: number;
  already_running?: boolean;
}

export async function indexRepo(source: string): Promise<IndexResult> {
  const { root, name, source_type, isGit } = resolveSource(source);
  if (runningRepos.has(root)) {
    return { ok: false, already_running: true, error: "repo index already running" };
  }
  runningRepos.add(root);
  setProgress({ phase: "prepare", done: 0, total: 0, current: "preparing…" });
  try {
    if (source_type === "url") cloneUrl(source, root);
    if (!existsSync(root)) return { ok: false, error: `path not found: ${root}` };

    const identity = repoIdentity(source, name);
    let repo = await getRepoBySource(source);
    if (!repo) repo = await createRepo({ name, source_type, source, root });
    const repoId = repo.id;
    await updateRepoStatus(repoId, { status: "indexing", error: null });

    // Walk + mine
    const files = walk(root, maxFiles());
    setProgress({ phase: "mine", total: files.length, done: 0, current: "mining structure…" });
    let stored = 0;
    let skipped = 0;
    const fileMemoryIds: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const full = files[i];
      const rel = relative(root, full).split("\\").join("/");
      setProgress({ phase: "mine", total: files.length, done: i, current: rel });
      let content: string;
      try {
        content = readFileSync(full, "utf8");
      } catch {
        skipped++;
        continue;
      }
      if (content.length > maxFileBytes()) { skipped++; continue; }
      const redacted = redactSecrets(content);
      const mined = await mineFile(rel, redacted);
      const existing = await findExistingFileMemory(repoId, rel);
      if (existing) await supersedeExisting([existing]);
      const id = await insertMemory({
        repoId,
        repoName: name,
        content: mined.summary,
        metadata: { kind: "repo_index", file: rel, language: mined.language, tier: mined.tier },
        actor: "repo-index",
      });
      if (id) {
        stored++;
        fileMemoryIds.push(id);
      } else {
        skipped++;
      }
    }

    // Git history (commits, mutations, reverts)
    let commits: GitCommit[] = [];
    let reverts: GitRevert[] = [];
    // v4.7.10: commit memory ids + superseded ids, used by the edge pass
    // (commit→anchor part_of, commit→parent derives_from) outside this block.
    const commitIdBySha = new Map<string, string>();
    const supersededCommitIds: string[] = [];
    if (isGit) {
      setProgress({ phase: "git", total: 1, done: 0, current: "mining git history…" });
      const git = mineGitHistory(root, maxCommits());
      commits = git.commits;
      reverts = git.reverts;

      // Commit memories (capped, one per commit — supersede by sha).
      // v4.7.10: capture memory ids + superseded ids so the edge pass can
      // link commits to the repo anchor (part_of) and to their parents
      // (derives_from) — previously commits had ZERO edges and floated
      // unconnected on the mind map despite being one repo's history DAG.
      for (const c of commits.slice(0, maxCommits())) {
        const relPaths = c.files.slice(0, 20).map((f) => f.path);
        const content = `[repo ${name}] commit ${c.short} (${c.date.slice(0, 10)}): ${c.subject}. Files touched: ${relPaths.slice(0, 12).join(", ") || "—"}.`;
        const shaKey = `commit:${c.sha}`;
        const existingC = await findExistingFileMemory(repoId, shaKey, "repo_commit");
        if (existingC) {
          await supersedeExisting([existingC]);
          supersededCommitIds.push(existingC);
        }
        const commitId = await insertMemory({
          repoId,
          repoName: name,
          content: redactSecrets(content),
          metadata: { kind: "repo_commit", file: shaKey, commit_sha: c.sha, commit_date: c.date, commit_subject: c.subject },
          actor: "repo-index",
        });
        if (commitId) {
          commitIdBySha.set(c.sha, commitId);
          stored++;
        }
      }

      // Revert memories — the "remembers what broke" goal. Bi-temporal:
      // then-believed (the reverted change) / found-false (the revert) /
      // truth-now (do not re-introduce). These are exactly the mistake class
      // the reference tool captures; stored as memories so recall surfaces
      // them before the next edit.
      for (const r of reverts) {
        const content = `[repo ${name}] REVERTED: "${r.revertedSubject}" was reverted in commit ${r.sha.slice(0, 7)} (${r.date.slice(0, 10)}). Do NOT re-introduce this change; it broke before. Files: ${r.files.slice(0, 12).join(", ") || "—"}.`;
        const shaKey = `revert:${r.sha}`;
        const existingR = await findExistingFileMemory(repoId, shaKey, "repo_revert");
        if (existingR) await supersedeExisting([existingR]);
        await insertMemory({
          repoId,
          repoName: name,
          content: redactSecrets(content),
          metadata: {
            kind: "repo_revert", file: shaKey, commit_sha: r.sha, commit_date: r.date,
            then_believed: r.revertedSubject, found_false_at: r.date, truth_now: `reverted in ${r.sha.slice(0, 7)}`, reverted_sha: r.revertedSha,
          },
          actor: "repo-index",
        }).then(() => { stored++; });
      }
    }

    // Edges: part_of file → repo anchor; related_to via imports (best-effort).
    setProgress({ phase: "embed", total: 1, done: 0, current: "linking…" });
    let edges = 0;
    try {
      // Supersede any prior anchor (kind repo_anchor) so re-index never
      // accumulates duplicate anchors.
      const priorAnchor = await findExistingFileMemory(repoId, "__repo__", "repo_anchor");
      if (priorAnchor) await supersedeExisting([priorAnchor]);
      const anchorId = await insertMemory({
        repoId,
        repoName: name,
        content: `Repository ${name} (${identity}) — baseline structural index. ${files.length} files scanned, ${commits.length} commits mined, ${reverts.length} reverts.`,
        metadata: { kind: "repo_anchor", file: "__repo__" },
        actor: "repo-index",
      });
      if (anchorId) {
        for (const fid of fileMemoryIds.slice(0, 500)) {
          await pg_run(
            `INSERT INTO public.edges (id, source_memory_id, target_memory_id, edge_type, weight, confidence, metadata)
             VALUES ($1, $2, $3, 'part_of', 1, 1, $4::jsonb)
             ON CONFLICT DO NOTHING`,
            [crypto.randomUUID(), fid, anchorId, JSON.stringify({ source: "repo_index" })],
          ).then(() => { edges++; }).catch(() => {});
        }
        // v4.7.10: commit DAG — every commit part_of the anchor, and
        // derives_from its parent(s). Git history IS a DAG; previously
        // commits had zero edges and floated unconnected on the mind map
        // even though the whole repo is one lineage.
        for (const c of commits.slice(0, maxCommits())) {
          const cid = commitIdBySha.get(c.sha);
          if (!cid) continue;
          await pg_run(
            `INSERT INTO public.edges (id, source_memory_id, target_memory_id, edge_type, weight, confidence, metadata)
             VALUES ($1, $2, $3, 'part_of', 1, 1, $4::jsonb)
             ON CONFLICT DO NOTHING`,
            [crypto.randomUUID(), cid, anchorId, JSON.stringify({ source: "repo_index" })],
          ).then(() => { edges++; }).catch(() => {});
          for (const p of c.parents) {
            const pid = commitIdBySha.get(p);
            if (!pid) continue;
            await pg_run(
              `INSERT INTO public.edges (id, source_memory_id, target_memory_id, edge_type, weight, confidence, metadata)
               VALUES ($1, $2, $3, 'derives_from', 1, 1, $4::jsonb)
               ON CONFLICT DO NOTHING`,
              [crypto.randomUUID(), cid, pid, JSON.stringify({ source: "repo_index" })],
            ).then(() => { edges++; }).catch(() => {});
          }
        }
        // Stale edges from superseded commit memories (re-index) — clean now
        // instead of leaving them for the broken_links integrity repair.
        if (supersededCommitIds.length) {
          await pg_run(
            `DELETE FROM public.edges WHERE source_memory_id = ANY($1::uuid[]) OR target_memory_id = ANY($1::uuid[])`,
            [supersededCommitIds],
          ).catch(() => {});
        }
      }
    } catch (e: any) {
      logger.warn({ module: "repoIndexer", err: e?.message }, "edge pass skipped");
    }

    await updateRepoStatus(repoId, {
      status: "ready",
      last_indexed_at: new Date().toISOString(),
      file_count: files.length,
      memory_count: stored,
      commit_count: commits.length,
      revert_count: reverts.length,
      error: null,
      head_sha: captureHead(root),
    });
    setProgress({ phase: "done", done: files.length, total: files.length, current: `indexed ${name}` });
    logger.info({ module: "repoIndexer", repo: name, files: files.length, memories: stored, commits: commits.length, reverts: reverts.length, edges }, "repo indexed");
    return { ok: true, repo_id: repoId, files: files.length, memories: stored, commits: commits.length, reverts: reverts.length, edges, skipped };
  } catch (e: any) {
    const err = e?.message || String(e);
    const repo = await getRepoBySource(source);
    if (repo) await updateRepoStatus(repo.id, { status: "error", error: err });
    logger.error({ module: "repoIndexer", err }, "repo index failed");
    return { ok: false, error: err };
  } finally {
    runningRepos.delete(root);
    setProgress({ phase: "done", done: 0, total: 0, current: "" });
  }
}

/** Delete a repo's indexed memories (supersede, audited) + drop the row. */
export async function deleteIndexedRepo(repoId: string): Promise<{ ok: boolean; superseded: number; error?: string }> {
  const repo = await getRepo(repoId);
  if (!repo) return { ok: false, superseded: 0, error: "repo not found" };
  const rows = await pg_all(
    `SELECT id FROM public.memories WHERE superseded_at IS NULL AND metadata->>'repo_id' = $1`,
    [repoId],
  ).catch(() => []);
  const ids = rows.map((r: any) => r.id);
  const n = await supersedeExisting(ids, "repo-index-delete");
  await pg_run(`DELETE FROM public.edges WHERE source_memory_id = ANY($1::uuid[]) OR target_memory_id = ANY($1::uuid[])`, [ids]).catch(() => {});
  await deleteRepo(repoId);
  return { ok: true, superseded: n };
}

/** recall-test: run a query against a repo's indexed memories only. */
export async function recallRepoTest(repoId: string, query: string): Promise<{ results: Array<{ id: string; content: string; score: number; file?: string }>; error?: string }> {
  let vec: number[] | null = null;
  try {
    vec = normalizeEmbedding(await embed(query));
  } catch (e: any) {
    return { results: [], error: `embed failed: ${e?.message || e}` };
  }
  if (!vec || !vec.length) return { results: [], error: "empty embedding" };
  const rows = await pg_all(
    `SELECT id, content, metadata, round((1 - (embedding <=> $1::halfvec))::numeric, 3) AS sim
     FROM public.memories
     WHERE superseded_at IS NULL AND embedding IS NOT NULL AND metadata->>'repo_id' = $2
     ORDER BY embedding <=> $1::halfvec LIMIT 8`,
    [JSON.stringify(vec), repoId],
  ).catch(() => []);
  return {
    results: rows.map((r: any) => ({
      id: r.id,
      content: r.content,
      score: Number(r.sim ?? 0),
      file: r.metadata?.file || undefined,
    })),
  };
}

// ── Auto-refresh (v4.7.0): rescan changed repos ──────────────────────────
// The user's question: "if the repo/directory changes, is there a function
// that will rescan?" — Reindex was manual-only. This adds a scheduled pass:
// each ready repo is fingerprinted by newest file mtime + git HEAD; a changed
// repo is re-indexed (supersede + fresh — idempotent by construction).

/** True when the repo's files or git HEAD changed since it was last indexed. */
export async function repoNeedsRefresh(repo: RepoRow): Promise<boolean> {
  if (!existsSync(repo.root ?? "")) return false;
  const last = repo.last_indexed_at ? new Date(repo.last_indexed_at).getTime() : 0;
  // 1) Newest file mtime under the repo (respecting walk skip rules) — catches
  //    content edits. The ROOT DIR mtime is also checked: a file add/delete
  //    bumps the parent dir's mtime even though no existing file changed.
  let newest = 0;
  try {
    const rootStat = statSync(repo.root!);
    if (rootStat.mtimeMs > newest) newest = rootStat.mtimeMs;
    const stack = [repo.root!];
    const seen = new Set<string>();
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const ent of entries) {
        const full = join(dir, ent);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (SKIP_DIRS.has(ent)) continue;
          if (!seen.has(full)) { seen.add(full); stack.push(full); }
        } else if (st.isFile() && st.mtimeMs > newest) {
          newest = st.mtimeMs;
        }
      }
    }
  } catch {
    /* fall through to git HEAD check */
  }
  if (newest > last + 5000) return true; // 5s slack for clock skew on the write
  // 2) Git HEAD changed (a pull/fetch can rewrite mtimes of unchanged files).
  try {
    const head = captureHead(repo.root!);
    return Boolean(head && repo.head_sha && head !== repo.head_sha);
  } catch {
    return false;
  }
}

/** Refresh pass: re-index every ready repo whose content changed. */
export async function refreshChangedRepos(): Promise<{ checked: number; refreshed: number; skipped_running: boolean }> {
  if (runningRepos.size > 0) return { checked: 0, refreshed: 0, skipped_running: true };
  const repos = await listRepos();
  let checked = 0;
  let refreshed = 0;
  for (const repo of repos) {
    if (repo.status !== "ready") continue;
    checked++;
    try {
      if (await repoNeedsRefresh(repo)) {
        const r = await indexRepo(repo.source);
        if (r.ok) refreshed++;
      }
    } catch (e: any) {
      logger.warn({ module: "repoIndexer", err: e?.message, repo: repo.name }, "auto-refresh failed");
    }
  }
  return { checked, refreshed, skipped_running: false };
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;
/** Start the scheduled auto-refresh (called once at boot; interval configurable). */
export function startRepoAutoRefresh(): void {
  if (refreshTimer) return;
  if (!autoRefreshEnabled()) return;
  const interval = refreshIntervalMs();
  refreshTimer = setInterval(() => {
    refreshChangedRepos().catch(() => {});
  }, interval);
  logger.info({ module: "repoIndexer", interval_ms: interval }, "repo auto-refresh scheduled");
}
