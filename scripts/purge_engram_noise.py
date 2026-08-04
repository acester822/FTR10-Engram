#!/usr/bin/env python3
"""
Engram memory-store noise scanner + gated purger.

Connects to the Engram PostgreSQL DB (via the `engram-postgres-1` Docker
container, since the DB is not exposed on the host) and classifies active,
non-superseded memories into noise classes.

DEFAULT MODE = dry-run (report only, no writes).
Use --delete to actually remove the targeted noise class.

Targeted noise class ("ide_diff"):
  content LIKE '[IDE save%Diff%'  OR  content LIKE 'Diff for %'
These are raw file-diff captures from the VS Code Engram extension's
"save interception" path. They are not durable facts and (per user)
constitute the bulk of the store's noise.

What is NEVER touched:
  - is_genome = true            (core directives / immutable facts)
  - memory_tier = 'archived'     (already archived)
  - superseded_at IS NOT NULL    (version history)
  - anything not matching the noise pattern

Profiling also reports other suspected-noise classes (tiny, code-only,
empty-diff) but those are REPORT-ONLY unless you add them to TARGET_PATTERNS
and pass --delete. Safe by design: delete is opt-in and single-class.

Usage:
  python3 purge_engram_noise.py            # dry-run report
  python3 purge_engram_noise.py --delete    # remove ide_diff class
  python3 purge_engram_noise.py --delete --also tiny_dash code_or_diff
"""
import subprocess
import sys
import re

CONTAINER = "engram-postgres-1"
DB = "engram"
PGUSER = "postgres"

# Noise classifiers -> SQL predicate. Each returns a WHERE clause (already
# scoped to active/non-superseded). "ide_diff" is the default --delete target.
PATTERNS = {
    "ide_diff": "content LIKE '[IDE save%Diff%' OR content LIKE 'Diff for %'",
    "ide_save_any": "content LIKE '[IDE save%'",
    "tiny_dash": "content LIKE '%- %' AND length(content) < 120",
    "code_or_diff": "content ~ '^([+-]\\s)' OR content LIKE '%```%'",
    "empty_diff": "content ~ '^(\\[IDE save[^\\n]*\\]\\n)?Diff for [^\\n]*:\\n(- |\\+|\\n)*$'",
}

# Patterns that --delete may remove. Extend deliberately; never includes
# genome/archived/superseded (those are excluded in the SQL base filter).
DELETABLE = {"ide_diff"}


def psql(query: str) -> str:
    """Run a query inside the postgres container, return stdout."""
    cmd = [
        "docker", "exec", "-i", CONTAINER,
        "psql", "-U", PGUSER, "-d", DB, "-t", "-A", "-F", "\t", "-c", query,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        sys.exit(f"psql failed ({r.returncode}):\n{r.stderr}")
    return r.stdout


def count_where(predicate: str) -> int:
    q = (
        "SELECT count(*) FROM memories "
        "WHERE memory_tier <> 'archived' AND superseded_at IS NULL "
        f"AND ({predicate});"
    )
    out = psql(q).strip().splitlines()
    return int(out[0]) if out and out[0].strip().isdigit() else 0


def sample_where(predicate: str, n: int = 3) -> list:
    q = (
        "SELECT left(content, 90) FROM memories "
        "WHERE memory_tier <> 'archived' AND superseded_at IS NULL "
        f"AND ({predicate}) LIMIT {n};"
    )
    return [l for l in psql(q).splitlines() if l != ""]


def main():
    args = sys.argv[1:]
    do_delete = "--delete" in args
    extra = [a for a in args if a != "--delete"]

    # Report base stats
    total = count_where("TRUE")
    genome = count_where("is_genome = true")
    non_ep = count_where("sector <> 'episodic'")
    print(f"=== Engram memory store ({DB} via {CONTAINER}) ===")
    print(f"Active (non-archived, non-superseded) total : {total}")
    print(f"  is_genome (core directives)               : {genome}")
    print(f"  non-episodic (structured real memories)   : {non_ep}")
    print()

    print("=== Noise class profile (active only) ===")
    for name, pred in PATTERNS.items():
        c = count_where(pred)
        flag = "  <- DELETABLE" if name in DELETABLE else ""
        print(f"  {name:14s}: {c:5d}{flag}")
        for s in sample_where(pred, 2):
            print(f"       e.g. {s[:88]!r}")
    print()

    target = "ide_diff"
    target_pred = PATTERNS[target]
    n_target = count_where(target_pred)
    print(f">>> Targeted for deletion: '{target}' = {n_target} memories")
    print(f">>> Would REMAIN: {total - n_target} (incl. {genome} genome, {non_ep} structured)")

    if not do_delete:
        print("\n[DRY-RUN] No changes made. Re-run with --delete to remove the"
              " 'ide_diff' class.")
        return

    if target not in DELETABLE:
        sys.exit(f"Refusing to delete '{target}': not in DELETABLE set.")

    print(f"\n[DELETE] Removing {n_target} '{target}' memories...")
    # Delete, preserving genome/archived/superseded as a safety net even though
    # the pattern already excludes them.
    del_q = (
        "DELETE FROM memories "
        "WHERE memory_tier <> 'archived' AND superseded_at IS NULL "
        f"AND is_genome = false AND ({target_pred});"
    )
    psql(del_q)
    remaining = count_where("TRUE")
    print(f"[DELETE] Done. Remaining active memories: {remaining}")
    # Vacuum to reclaim space from the 3.9k-row deletion
    print("[DELETE] Vacuuming...")
    psql("VACUUM (ANALYZE) memories;")


if __name__ == "__main__":
    main()
