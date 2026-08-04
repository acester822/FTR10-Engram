#!/usr/bin/env python3
"""
Purge ephemeral session chatter from Engram.

Targets only clearly-ephemeral memories:
  - [IDE save ...] diff dumps (never durable facts)
  - content matching the isWorthRemembering recap/meta/vague rejection rules
    (session recaps, status self-narration, memory-system meta chatter)
Never touches genome memories, and never touches anything that passes the
worth-remembering gate. Idempotent.

Usage:
  python3 purge_chatter.py            # dry-run count
  python3 purge_chatter.py --apply     # delete
"""
import subprocess
import sys
import re

CONTAINER = "engram-postgres-1"
DB = "engram"
PGUSER = "postgres"

# Mirrors the recap/meta/vague rules in memoryLogger.ts isWorthRemembering().
RECAP = [
    r"^(the )?(system|engine|memory( store| engine| logging)?|task|build|service|extension) (was |has been |is now |now )?(fixed|updated|modified|adjusted|changed|patched|corrected|improved|restored|rebuilt|recreated)",
    r"^(the )?(system|task|build|service) (recovered|resumed|restarted|reloaded) (from|operation)",
    r"^(the )?system confirms (it |the )?(runs|is running|the latest|successful)",
    r"^(the )?(system|build|extension|service) (runs|is) (the )?(latest|current|newest) (stable )?version",
    r"^(the )?(system|task|build) (is |has )?(now )?(complete|completed|working|functional|ready|stable)",
    r"^\d+ (files?|memories) (modified|changed|added|updated|created|deleted|removed)",
    r"^(added|updated|modified|fixed|removed|deleted) \d+ (files?|memories|embeddings)",
    r"^(verified|confirmed|tested|checked) (the |that )?(installed|running|current|latest|build)",
    r"^(restarting|restoring|rebuilding) [a-z]+ (resolves|fixed|clears|recovers)",
]
VAGUE = [
    r"^no (user )?preferences or constraints (were |are )?(noted|specified)",
    r"^no discrepancies detected",
    r"^no permanent changes are stored",
    r"^(the )?(system|task) (is |has )?(now )?(completed|ready|fully functional|working as expected|functioning correctly)",
    r"\b(build completed successfully|exit code 0|images? built without issues)\b",
]
META = [
    r"^(genome directive recalled|phenotype fact identified)",
    r"^(full-coverage test|integration test):",
    r"^(key (insight|fact)|important decision was to|the system remembers the need)",
    r"^(the system confirms (successful|the health|memory retrieval))",
    r"recall integrates genome",
    r"memory logging was adjusted|non-essential noise|durable facts about memory structure|before (final )?consolidation",
    r"a clear preference for (typescript|python|[\w-]+) is noted",
    r"^(recommended to|we should|i should|let'?s) (remove|keep|retain|clean|store|note|remember)",
]
ALL = [re.compile(r, re.I) for r in RECAP + VAGUE + META]


def psql(q):
    r = subprocess.run(["docker", "exec", "-i", CONTAINER, "psql", "-U", PGUSER, "-d", DB, "-t", "-A", "-F", "\t", "-f", "-"],
                      input=q, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        sys.exit(f"psql failed: {r.stderr[:300]}")
    return [l for l in r.stdout.splitlines() if l.strip()]


def is_chatter(content):
    c = content.strip()
    # 1) Raw IDE-save diff dumps — never durable facts.
    if c.lower().startswith("[ide save:") or "\ndiff for" in c.lower():
        return True
    # 2) "what we did this session" recap / status self-narration (substring, not strict anchor).
    recap_sub = [
        "recovered from a freeze", "resumed operation", "memory logging fixed",
        "files modified:", "runs the latest stable", "embeddings were added",
        "system confirms it runs", "no permanent changes are stored",
        "task completed", "build completed successfully", "exit code 0",
        "memory injected", "recalled ", "genome directive recalled",
        "non-essential noise", "durable facts about memory structure",
    ]
    cl = c.lower()
    if any(s in cl for s in recap_sub):
        return True
    # 3) Too thin to be a meaningful atomic fact.
    if len(c) < 15:
        return True
    return False


def main():
    apply = "--apply" in sys.argv
    ids = psql(
        "SELECT id::text, content FROM memories "
        "WHERE is_genome = false AND superseded_at IS NULL AND memory_tier <> 'archived';"
    )
    targets = []
    for line in ids:
        if "\t" not in line:
            continue
        mid, content = line.split("\t", 1)
        if is_chatter(content):
            targets.append(mid)

    print(f"Chatter candidates: {len(targets)}")
    if not apply:
        # show a sample
        sample = targets[:15]
        for mid in sample:
            c = next((ln.split("\t", 1)[1] for ln in ids if ln.startswith(mid + "\t")), "")
            print(f"  - {c[:80]}")
        print("[DRY-RUN] re-run with --apply to delete.")
        return

    for mid in targets:
        psql(f"DELETE FROM memories WHERE id = '{mid}';")
    print(f"[APPLY] Deleted {len(targets)} chatter memories.")


if __name__ == "__main__":
    main()
