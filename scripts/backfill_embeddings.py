#!/usr/bin/env python3
"""
Backfill NULL embeddings for existing Engram memories.

Targets only active, non-superseded, non-genome memories whose `embedding`
column is NULL. Computes a 768-dim vector via Nomic-Embed-Text-v1.5 on the LAN
llama-swap box and writes it back as halfvec(768).

Why this is written the way it is (lessons learned the hard way):
  - Postgres checkpoint stall: doing one UPDATE per row (~1400 of them) forced
    constant checkpoints that blocked for 80s+. FIX: batch every row in a batch
    into ONE `UPDATE ... FROM (VALUES ...)` statement -> ~1 transaction/batch.
  - llama-swap lockup: hammering the embed endpoint with a tight burst locks the
    Nomic server process, which needs a manual restart to recover. FIX: pace
    embeds gently (~0.8s apart) and stop hard after a few consecutive failures
    instead of hanging on a dead endpoint.
  - Parse safety: fetch ONLY ids (validated UUIDs) before any SQL, so we never
    emit `WHERE id = ''` (which Postgres rejects).

Idempotent: only touches rows where embedding IS NULL. Re-runs resume.
Safe scope: never touches genome / archived / superseded memories.

Usage:
  python3 backfill_embeddings.py                 # dry-run count
  python3 backfill_embeddings.py --apply          # embed + update remaining
  python3 backfill_embeddings.py --apply --batch 50 --pace 0.8
"""
import subprocess
import sys
import time
import urllib.request
import urllib.error
import json
import re
import os

CONTAINER = "engram-postgres-1"
DB = "engram"
PGUSER = "postgres"

EMBED_URL = "http://10.10.10.41:8080/v1/embeddings"
EMBED_MODEL = os.environ.get("EG_MODEL_EMBEDDING", "Nomic-Embed-Text-v1.5")
BATCH = 50
PACE = 0.8          # seconds between embed calls (gentle on llama-swap)
MAX_CONSEC_FAILURES = 3  # stop hard if llama-swap looks locked; don't hang
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def psql(query: str) -> list:
    # Pipe SQL via stdin to avoid ARG_MAX limits on large batched statements.
    cmd = ["docker", "exec", "-i", CONTAINER, "psql", "-U", PGUSER,
           "-d", DB, "-t", "-A", "-f", "-"]
    r = subprocess.run(cmd, input=query, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        sys.exit(f"psql failed ({r.returncode}): {r.stderr[:300]}")
    return [l for l in r.stdout.splitlines() if l.strip() != ""]


def embed_one(text: str) -> list:
    """Embed a single text. Raises on failure (caller handles backoff/lockup)."""
    payload = json.dumps({"model": EMBED_MODEL, "input": text}).encode()
    req = urllib.request.Request(EMBED_URL, data=payload,
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=45) as resp:
        data = json.load(resp)
    vec = data["data"][0]["embedding"]
    if len(vec) != 768:
        raise ValueError(f"expected 768 dims, got {len(vec)}")
    return vec


def embed_with_retry(text: str) -> list:
    """Retry transient 429/timeout a few times, then raise."""
    last_err = None
    for attempt in range(4):
        try:
            return embed_one(text)
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code == 429:
                time.sleep(min(20, 3 * (attempt + 1)))
                continue
            raise
        except Exception as e:
            last_err = e
            time.sleep(3 * (attempt + 1))
    raise last_err


def batched_update(rows) -> None:
    """rows: list of (uuid_str, vec_list). ONE statement, ONE transaction."""
    if not rows:
        return
    values = []
    for mid, vec in rows:
        vec_literal = "[" + ",".join(f"{x:.8g}" for x in vec) + "]"
        # uuid is validated; vec is our own float literal (safe to interpolate)
        values.append(f"('{mid}','{vec_literal}'::halfvec)")
    vals = ",".join(values)
    q = (
        "UPDATE memories m SET embedding = v.emb "
        "FROM (VALUES " + vals + ") AS v(id, emb) "
        "WHERE m.id = v.id::uuid;"
    )
    psql(q)


def main():
    global BATCH, PACE
    apply = "--apply" in sys.argv
    for i, a in enumerate(sys.argv):
        if a == "--batch" and i + 1 < len(sys.argv):
            BATCH = int(sys.argv[i + 1])
        if a == "--pace" and i + 1 < len(sys.argv):
            PACE = float(sys.argv[i + 1])

    count_q = (
        "SELECT count(*) FROM memories "
        "WHERE memory_tier <> 'archived' AND superseded_at IS NULL "
        "AND is_genome = false AND embedding IS NULL;"
    )
    total = int(psql(count_q)[0])
    print("=== Engram embedding backfill ===")
    print(f"NULL-embedding targets (active, non-genome): {total}")
    if total == 0:
        print("Nothing to do. All active memories are embedded.")
        return
    if not apply:
        print("[DRY-RUN] No changes. Re-run with --apply to embed + update.")
        return

    print(f"[APPLY] Embedding {total} memories, batch={BATCH}, pace={PACE}s/embed...")
    done = 0
    failures = 0
    skipped = 0
    consec = 0
    while True:
        fetch_q = (
            "SELECT id::text FROM memories "
            "WHERE memory_tier <> 'archived' AND superseded_at IS NULL "
            "AND is_genome = false AND embedding IS NULL "
            f"ORDER BY recorded_at ASC LIMIT {BATCH};"
        )
        ids = psql(fetch_q)
        if not ids:
            break

        pending = []   # (mid, vec) to flush in one batched UPDATE
        for mid in ids:
            mid = mid.strip()
            if not UUID_RE.match(mid):
                skipped += 1
                if skipped <= 5:
                    print(f"  SKIP non-uuid id: {mid[:20]!r}")
                continue
            try:
                # fetch content for this id (validated UUID -> safe interpolation)
                crows = psql(f"SELECT content FROM memories WHERE id = '{mid}';")
                content = crows[0] if crows else ""
                if not content:
                    skipped += 1
                    continue
                vec = embed_with_retry(content)
                pending.append((mid, vec))
                done += 1
                consec = 0
            except Exception as e:
                failures += 1
                consec += 1
                print(f"  FAIL {mid[:8]}: {str(e)[:70]}")
                if consec >= MAX_CONSEC_FAILURES:
                    print(f"\n  !! {MAX_CONSEC_FAILURES} consecutive embed failures -> "
                          f"llama-swap/Nomic appears locked.")
                    print(f"     Restart llama-swap, then re-run this script "
                          f"(idempotent, resumes from {done} done).\n")
                    return
            time.sleep(PACE)

        # Flush the whole batch in ONE statement (fixes Postgres checkpoint stall)
        try:
            batched_update(pending)
        except Exception as e:
            print(f"  BATCH UPDATE FAIL: {str(e)[:120]}")
            # roll back the 'done' accounting for this batch so re-run retries them
            done -= len(pending)
            failures += len(pending)

        print(f"  progress: embedded={done} failures={failures} skipped={skipped} remaining={total-done-failures-skipped}")

    print(f"[APPLY] Done. embedded={done} failures={failures} skipped={skipped}")
    print("[APPLY] Vacuuming...")
    psql("VACUUM (ANALYZE) memories;")


if __name__ == "__main__":
    main()
