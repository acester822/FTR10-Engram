#!/usr/bin/env node
/*
 * scripts/cleanupNoisyMemories.mjs
 *
 * One-off hygiene pass over the live Engram memory store.
 *
 * Removes memories that have NO meaningful long-term content — the kind of
 * ephemeral debugging chatter / IDE-save diff dumps / session-state noise /
 * self-referential boilerplate that accumulated while the extraction prompt
 * was loosened. Also removes any memory that leaks a credential.
 *
 * Deletions go through the live DELETE /api/dashboard/memories/:id endpoint,
 * which removes the whole row (including its pgvector embedding) so orphan
 * vectors can never be recalled.
 *
 * DRY RUN by default. Pass --apply to actually delete.
 */
import http from "node:http";

const BASE = process.env.EG_BASE_URL || "http://localhost:8098";
const APPLY = process.argv.includes("--apply");

// ── Noise classification (mirrors the in-code quality gate) ──────────────
function rule(m) {
  const c = m.content || "";
  const cl = c.toLowerCase();

  // 1. SECRET / credential leak — always delete.
  if (
    /('|")?\s*(password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\b/i.test(c) &&
    /[:=]\s*['"][^'"]{2,}|password\s+['"][^'"]{2,}/i.test(c)
  ) {
    return "SECRET";
  }

  // 2. Raw IDE-save diff dumps.
  if (cl.startsWith("[ide save:") || cl.includes("\ndiff for")) return "IDE_SAVE";

  // 3. Pure ephemeral session state.
  if (/^(the )?(current )?(working (directory|dir)|active file|session id|cwd)\b/i.test(cl)) return "SESSION_STATE";
  if (/^the current time is /i.test(cl)) return "SESSION_STATE";
  if (/\bsession id \d+ is currently active\b/i.test(cl)) return "SESSION_STATE";
  if (/^sessions are stored in the directory/i.test(cl)) return "SESSION_STATE";

  // 4. Build / ephemeral pipeline results.
  if (/\b(build completed successfully|exit code 0|image(s)? (and web images )?built without issues|the new engram code rejects non-canonical sectors at write time|rebuilt\/recompiled the engram|rebuilding the (engram|webgui)|corrected dependencies were installed|stray closing parenthesis affecting jsx)\b/i.test(cl))
    return "BUILD_EPH";

  // 5. Vague self-congratulatory boilerplate with no retrievable content.
  const vague = [
    /^no (user )?preferences or constraints (were |are )?(noted|specified)/i,
    /^no discrepancies detected/i,
    /^no permanent changes are stored/i,
    /^(the )?(system|task) (is |has )?(now )?(completed|ready|fully functional|working as expected|functioning correctly)/i,
    /^(all actions are temporary and (reversible|reversable))/i,
    /^(the system is currently running with a slow progress)/i,
    /^(mark task complete after)/i,
    /^(the task involves restructuring and organizing background data)/i,
  ];
  if (vague.some((re) => re.test(c))) return "VAGUE_META";

  // 6. Self-referential meta about the memory engine itself.
  const meta = [
    /^(genome directive recalled|phenotype fact identified)/i,
    /(recalled \d+ relevant memories|memory injected|steer test triggered|memory block in the <memory-context>)/i,
    /^(full-coverage test|integration test):/i,
    /^(key (insight|fact)|important decision was to|the system remembers the need)/i,
    /^(the system confirms (successful|the health|memory retrieval))/i,
    /recall integrates genome/i,
    /^(the system has completed its current task)/i,
    /^(the system completed all restructuring)/i,
  ];
  if (meta.some((re) => re.test(c))) return "SELF_REF";

  // 8. Residual vague "the system…" padding / session-binding ephemera with no
  //    retrievable, reusable content (lower-confidence than the rules above).
  const vagueSys = [
    /^(the )?system (is |was |has |confirms|remembers|detected|completed|ready|noted)/i,
    /\b(is (now )?(stable|functioning correctly|verified|live|active)|now (stable|live|verified))\b/i,
    /\b(confirmed successfully|verified successfully|working as expected)\b/i,
    /\btracked again\b/i,
    /\bit followed you to\b/i,
    /\bthree different files were accessed\b/i,
  ];
  if (vagueSys.some((re) => re.test(c))) return "VAGUE_SYSTEM";

  return null;
}

async function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${BASE}${path}`,
      { method: "GET" },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`bad JSON from ${path}: ${body.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  // Fetch all active memories via the list API (paginated).
  let rows = [];
  for (let offset = 0; ; offset += 500) {
    const page = await get(`/memories?limit=500&offset=${offset}`);
    const items = page.items || [];
    rows = rows.concat(items.map((m) => ({ id: m.id, content: m.content })));
    if (items.length < 500) break;
  }
  console.log(`\nFetched ${rows.length} active memories.\n`);

  const byRule = {};
  const targets = [];
  for (const m of rows) {
    const r = rule(m);
    if (r) {
      byRule[r] = (byRule[r] || 0) + 1;
      targets.push({ ...m, _rule: r });
    }
  }

  console.log("=== DELETE PLAN (by rule) ===");
  for (const [r, n] of Object.entries(byRule)) console.log(`  ${r}: ${n}`);
  console.log(`  TOTAL TO DELETE: ${targets.length}\n`);

  for (const t of targets) {
    console.log(`  [${t._rule}] ${t.id} :: ${JSON.stringify(t.content).slice(0, 110)}`);
  }

  if (!APPLY) {
    console.log("\n*** DRY RUN — no changes made. Re-run with --apply to execute. ***");
    return;
  }

  console.log("\nApplying deletions via dashboard endpoint (complete row + embedding removal)...");
  let ok = 0;
  let fail = 0;
  for (const t of targets) {
    try {
      const res = await fetch(`${BASE}/api/dashboard/memories/${t.id}`, {
        method: "DELETE",
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.success) ok++;
      else {
        fail++;
        console.error(`  FAILED ${t.id} (${res.status}): ${JSON.stringify(body).slice(0, 120)}`);
      }
    } catch (e) {
      fail++;
      console.error(`  ERROR ${t.id}: ${e.message}`);
    }
  }
  console.log(`\nDone. Soft-deleted: ${ok}, failed: ${fail}. Remaining active: ${rows.length - ok}.`);
}

main()
  .catch((e) => {
    console.error("CLEANUP FAILED:", e);
    process.exit(1);
  });
