/*
 - filename: packages/engram-js/src/services/gitMiner.ts
 - what is the file used for: GIT HISTORY mining for the repo baseline indexer
   (v4.7.0-repo-index). If the indexed location is a git repo, this captures a
   compact map of PAST CHANGES — commits, per-file mutations, and REVERSIONS
   (revert commits → bi-temporal "mistake" facts: "this broke before, do not
   re-introduce it"). That is the user's explicit goal for this rung: the
   agent stops re-introducing bugs you already fixed — because Engram
   remembers what broke. Zero LLM; pure `git log` parsing.
*/

import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface GitCommit {
  sha: string;
  short: string;
  author: string;
  date: string;
  subject: string;
  files: { path: string; status: "A" | "M" | "D" | "R" }[];
}

export interface GitRevert {
  sha: string;
  date: string;
  subject: string;          // the revert commit's subject
  revertedSubject: string;  // "Revert \"X\"" → X
  revertedSha: string;      // "This reverts commit <sha>" → sha (when present)
  files: string[];
}

export interface GitMineResult {
  isGit: boolean;
  commits: GitCommit[];
  reverts: GitRevert[];
  mutations: Record<string, { adds: number; mods: number; dels: number; lastCommit: string }>;
  error?: string;
}

function isGitRepo(root: string): boolean {
  try {
    return existsSync(join(root, ".git")) || existsSync(join(root, ".git", "HEAD")) ||
      execSync(`git -C ${shellQuote(root)} -c safe.directory='*' rev-parse --is-inside-work-tree 2>/dev/null`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() === "true";
  } catch {
    return false;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const MAX_COMMITS_DEFAULT = 200;

export function mineGitHistory(root: string, maxCommits = MAX_COMMITS_DEFAULT): GitMineResult {
  const empty: GitMineResult = { isGit: false, commits: [], reverts: [], mutations: {} };
  if (!isGitRepo(root)) return empty;
  try {
    // Format: \x1e-prefixed records — the record separator starts each
    // commit's header line, so split("\x1e") yields one record per commit
    // ("header\nfile-status lines") even though name-status lines follow
    // the pretty-format header on subsequent lines.
    const fmt = `\x1e%H%x1f%an%x1f%aI%x1f%s`;
    const out = execSync(
      `git -C ${shellQuote(root)} -c safe.directory='*' log -${maxCommits} --name-status --pretty=format:${fmt}`,
      { maxBuffer: 64 * 1024 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const commits: GitCommit[] = [];
    const mutations: Record<string, { adds: number; mods: number; dels: number; lastCommit: string }> = {};
    const records = out.split("\x1e").filter(Boolean);
    for (const rec of records) {
      const lines = rec.split("\n").filter(Boolean);
      const header = lines[0]?.split("\x1f");
      if (!header || header.length < 4) continue;
      const [sha, author, date, subject] = header;
      const files: GitCommit["files"] = [];
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split("\t");
        const status = (parts[0] || "M").trim();
        const path = parts[parts.length - 1]?.trim() || "";
        if (!path) continue;
        let s: "A" | "M" | "D" | "R" = "M";
        if (status.startsWith("A")) s = "A";
        else if (status.startsWith("D")) s = "D";
        else if (status.startsWith("R")) s = "R";
        files.push({ path, status: s });
        const m = (mutations[path] ??= { adds: 0, mods: 0, dels: 0, lastCommit: "" });
        if (s === "A") m.adds++;
        else if (s === "D") m.dels++;
        else m.mods++;
        m.lastCommit = m.lastCommit || sha.slice(0, 7);
      }
      commits.push({ sha, short: sha.slice(0, 7), author, date, subject, files });
    }

    // Revert detection: "Revert \"X\"" (git revert / cherry-pick) or
    // subjects mentioning a revert. These become bi-temporal mistakes.
    const reverts: GitRevert[] = [];
    for (const c of commits) {
      const mRevert = c.subject.match(/^Revert\s+"?(.+?)"?\s*$/);
      const mSha = c.subject.match(/reverts commit\s+([0-9a-f]{7,40})/i);
      if (mRevert || mSha || /^revert/i.test(c.subject)) {
        reverts.push({
          sha: c.sha,
          date: c.date,
          subject: c.subject,
          revertedSubject: mRevert ? mRevert[1] : c.subject,
          revertedSha: mSha ? mSha[1] : "",
          files: c.files.map((f) => f.path),
        });
      }
    }

    return { isGit: true, commits, reverts, mutations };
  } catch (e: any) {
    return { ...empty, isGit: true, error: e?.message || String(e) };
  }
}
