/*
 - filename: packages/engram-js/src/services/memoryLogger.ts
 - what is the file used for: Async memory extraction and logging service
*/

import { env } from "../configuration";
import { make_db as kit_make_db, run_async, all_async } from "../api/routes/_kit";
import { rememberDurableMemory } from "../durable/repository";
import { embed } from "../embeddings/embed";
import { DEFAULT_GENOME_DECAY_RATE, DEFAULT_PHENOTYPE_DECAY_RATE, normalizeSector } from "./memoryInjector";
import { logger } from "../utils/logger";
import { resolveGenerativeModel, tryResolveGenerativeModel, tryResolveProviderUrl } from "../database/modelRegistry";

// Extraction model comes from the canonical registry (Settings tab → env → fail).
const genModel = (): string => {
  try { return resolveGenerativeModel("extraction"); } catch { return ""; }
};
import { getLangfuse } from "./langfuseClient";

/**
 * Throttle: prevent extraction from running on every single turn.
 * Skips if extraction ran within the cooldown window.
 */
const EXTRACTION_COOLDOWN_MS = parseInt(String(process.env.EG_EXTRACTION_COOLDOWN_MS), 10) || 30_000;
const MAX_FACTS_PER_TURN = parseInt(String(process.env.EG_MAX_FACTS_PER_TURN), 10) || 5;
let _lastExtractionTime = 0;

/**
 * Heuristic gate that rejects content which is NOT worth persisting as a long-term
 * memory. The extraction LLM is asked to be selective, but we enforce a hard floor
 * here so loosened debug prompts can never flood the store with ephemeral chatter.
 */
function isWorthRemembering(content: string): boolean {
  const c = content.trim();
  if (c.length < 15) return false;          // too thin to be a meaningful fact
  if (c.length > 400) return false;         // summaries / dumps, not atomic facts
  const cl = c.toLowerCase();

  // Never store raw IDE-save diff dumps.
  if (cl.startsWith("[ide save:") || cl.includes("\ndiff for")) return false;

  // Never store anything that looks like a leaked secret / credential.
  if (/('|")?\s*(password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\b/i.test(c)
      && /[:=]\s*['"][^'"]{2,}/.test(c)) {
    return false;
  }

  // Reject pure ephemeral session state (working dir, clock, active file, session id).
  if (/^(the )?(current )?(working (directory|dir)|active file|session id|cwd)\b/i.test(cl)) return false;
  if (/^the current time is /i.test(cl)) return false;
  if (/\bsession id \d+ is currently active\b/i.test(cl)) return false;

  // Reject vague self-congratulatory boilerplate with no retrievable content.
  const vague = [
    /^no (user )?preferences or constraints (were |are )?(noted|specified)/i,
    /^no discrepancies detected/i,
    /^no permanent changes are stored/i,
    /^(the )?(system|task) (is |has )?(now )?(completed|ready|fully functional|working as expected|functioning correctly)/i,
    /^(all actions are temporary and (reversible|reversable))/i,
    /\b(build completed successfully|exit code 0|images? built without issues)\b/i,
  ];
  if (vague.some((re) => re.test(c))) return false;

  // Reject self-referential meta observations about the memory engine itself,
  // and self-narration about the current task / cleanup / "what we did".
  const meta = [
    /^(genome directive recalled|phenotype fact identified)/i,
    /(recalled \d+ relevant memories|memory injected|steer test triggered|memory block in the <memory-context>)/i,
    /^(full-coverage test|integration test):/i,
    /^(key (insight|fact)|important decision was to|the system remembers the need)/i,
    /^(the system confirms (successful|the health|memory retrieval))/i,
    /recall integrates genome/i,
    // Instruction/self-narration about the memory store itself.
    /^(the )?(system|engine|memory( store| engine| logging)?) (should|must|will|needs to|is (supposed to|configured to)|was) (remember|recall|forget|store|retain|remove|filter|adjust|log|note|recommend)/i,
    /^(the )?system should (remember|recall|note|log|store)/i,
    /^(recommended to|we should|i should|let'?s) (remove|keep|retain|clean|store|note|remember)/i,
    /memory logging was adjusted|non-essential noise|durable facts about memory structure|before (final )?consolidation/i,
    /a clear preference for (typescript|python|[\w-]+) is noted/i,
  ];
  if (meta.some((re) => re.test(c))) return false;

  // Reject "what we did this session" recaps and status self-narration: these are
  // ephemeral and not reusable facts. This is the class that previously slipped
  // through (e.g. "memory logging fixed with updated schema", "three files modified:",
  // "system recovered from a freeze", "system confirms it runs the latest version").
  const recap = [
    /^(the )?(system|engine|memory( store| engine| logging)?|task|build|service|extension) (was |has been |is now |now )?(fixed|updated|modified|adjusted|changed|patched|corrected|improved|restored|rebuilt|recreated)/i,
    /^(the )?(system|task|build|service) (recovered|resumed|restarted|reloaded) (from|operation)/i,
    /^(the )?system confirms (it |the )?(runs|is running|the latest|successful)/i,
    /^(the )?(system|build|extension|service) (runs|is) (the )?(latest|current|newest) (stable )?version/i,
    /^(the )?(system|task|build) (is |has )?(now )?(complete|completed|working|functional|ready|stable)/i,
    /^\d+ (files?|memories) (modified|changed|added|updated|created|deleted|removed)/i,
    /^(added|updated|modified|fixed|removed|deleted) \d+ (files?|memories|embeddings)/i,
    /^(verified|confirmed|tested|checked) (the |that )?(installed|running|current|latest|build)/i,
    /^(restarting|restoring|rebuilding) [a-z]+ (resolves|fixed|clears|recovers)/i,
  ];
  if (recap.some((re) => re.test(c))) return false;

  return true;
}

/**
 * Lexical near-duplicate check against existing active memories. Used as a cheap
 * pre-filter before the (more expensive) LLM extraction runs, and again after, to
 * stop near-identical re-phrasings from accumulating.
 */
async function isNearDuplicate(db: any, content: string): Promise<boolean> {
  const c = content.trim().toLowerCase().replace(/\s+/g, " ");
  try {
    const result = await db.query(
      `select content from "public"."memories" where superseded_at is null`,
      [],
    );
    for (const row of result.rows || []) {
      const existing = String(row.content || "").trim().toLowerCase().replace(/\s+/g, " ");
      if (!existing) continue;
      // Exact or one is a substring of the other → duplicate.
      if (c === existing) return true;
      if (c.length > 20 && existing.includes(c)) return true;
      if (existing.length > 20 && c.includes(existing)) return true;
    }
  } catch { /* best-effort */ }
  return false;
}

/**
 * Async log interaction - extract new memories from conversation
 * Returns count of successfully stored memories
 */
export async function logInteractionAsync(
  userPrompt: string,
  llmResponseText: string,
  sessionId?: string,
  projectId?: string,
  allowGenome: boolean = true,
): Promise<{ storedCount: number; sectors: Record<string, number>; storedMemoryIds: string[] }> {
  const empty = () => ({ storedCount: 0, sectors: {} as Record<string, number>, storedMemoryIds: [] as string[] });
  try {
    // v5.0.2 PRE-EXTRACTION GATE: turns that CANNOT yield durable facts never
    // reach the extraction LLM. Two recurring artifact classes (2026-08-22
    // fidelity audit, scores 0.2–0.5):
    //   1. Anaphoric user prompts — "Yes, get rid of them please" / "run the
    //      entire sweep". Without conversation history the referent of
    //      "them"/"it" is unresolvable, so the model invented facts or
    //      re-stored stale ones.
    //   2. Machine notifications — background-process completions,
    //      [IMPORTANT: ...] harness blocks. Pure session state.
    // Skipping here saves an LLM call AND keeps the fidelity judge honest.
    {
      const up = userPrompt.trim();
      const machineNoise =
        /^\[IMPORTANT:/i.test(up) ||
        /^Background process \S+ (completed|exited|failed)/i.test(up) ||
        /\bexit_code=\d+/.test(up) && up.length < 400;
      if (machineNoise) {
        logger.debug({ module: 'memoryLogger' }, 'Skipping extraction — machine/harness notification turn');
        return empty();
      }
      const words = up.split(/\s+/).filter(Boolean);
      if (
        words.length > 0 && words.length <= 12 &&
        !/[?]/.test(up) && up.length < 90 &&
        /^(yes|no|ok|okay|sure|thanks|thank you|please|go ahead|do it|do that|sounds good|perfect|great|confirmed|approved|nope|nah)\b/i.test(up) &&
        /\b(them|it|that|this|those|these)\b/i.test(up)
      ) {
        logger.debug({ module: 'memoryLogger' }, 'Skipping extraction — anaphoric acknowledgment turn (pronoun referent not in this turn)');
        return empty();
      }
    }

    // Throttle: skip if extraction ran recently
    const now = Date.now();
    if (now - _lastExtractionTime < EXTRACTION_COOLDOWN_MS) {
      logger.debug({ module: 'memoryLogger', model: genModel() }, 'Skipping extraction - cooldown active');
      return empty();
    }
    _lastExtractionTime = now;

    // Truncate inputs to keep the prompt within reasonable bounds
    const truncatedPrompt = userPrompt.length > 2500 ? userPrompt.substring(0, 2500) + '... [TRUNCATED]' : userPrompt;
    const truncatedResponse = llmResponseText.length > 3000 ? llmResponseText.substring(0, 3000) + '... [TRUNCATED]' : llmResponseText;

    // Skip extraction for very short responses (nothing meaningful to extract)
    if (llmResponseText.trim().length < 50) {
      logger.debug({ module: 'memoryLogger', model: genModel() }, 'Skipping extraction - response too short');
      return empty();
    }

    const extractionPrompt = `### SYSTEM DIRECTIVE ###
You are a conservative background memory-extraction API. You are NOT a chat assistant.
You do not answer questions. You do not write code. You do not converse.
Your ONLY function is to extract DURABLE, REUSABLE facts from the conversation that would
genuinely help a future session.

### WHAT IS WORTH EXTRACTING (be selective — only extract if it meets the bar) ###
- A clear, stated USER PREFERENCE, constraint, or standing rule (e.g. "prefers TypeScript", "always run tests before committing").
- A confirmed, non-obvious DECISION or CONCLUSION about architecture/design that is stable over time.
- A reusable FACT about the project, codebase, or domain (e.g. service ports, model names, config keys).
- An explicit "remember this / save this" request from the user (mark is_genome: true).

### DO NOT EXTRACT (these are noise — never emit them) ###
- Transient session/debugging chatter: build results, "working directory is X", timestamps, active file names, session IDs, "X is now functional" confirmations.
- IDE-save diff dumps, stack traces, or raw tool output.
- Self-referential meta about the memory system ("memory injected", "recalled N memories", "genome directive recalled").
- Vague boilerplate with no retrievable content ("no preferences were noted", "task completed").
- Anything that merely restates the user's immediate ask or the assistant's ephemeral status.
- Literal secrets, passwords, API keys, or tokens — NEVER extract credentials.

### OUTPUT SCHEMA ###
Return ONLY valid JSON with this shape:
{
  "context": { "project": "<project name or \"\">", "module": "<module/area or \"\">", "file": "<file path or \"\">", "topic": "<one-line topic or \"\">" },
  "facts": [
    { "content": "<self-contained fact>", "quote": "<verbatim source text>", "sector": "semantic|procedural|episodic|emotional|reflective", "is_genome": <true ONLY for standing rules / explicit save requests; otherwise omit> }
  ],
  "links": [
    { "from": <fact index>, "to": <fact index>, "type": "part_of|derives_from|related_to" }
  ]
}
- "context" is the frame this conversation belongs to (which project/module/file/topic was being discussed). Empty strings when unknown. Attached to every fact.
- "facts": each fact is ATOMIC and SELF-CONTAINED — it must make complete sense with no reference to this conversation. 15–400 chars, third person, no timestamps, no diffs, no paths unless the path IS the fact.
- SINGLE CLAUSE (hard rule, added after a compound-dilution review): a fact must be ONE clause about ONE specific thing. NEVER emit a compound paragraph that bundles multiple facts (e.g. do NOT write one memory that merges "hierarchy is workspace→repo→session", "uses a trust ladder", AND "recall_gap enforces one-proposal-per-memory" — emit each as its OWN fact). A long sentence containing several independent claims MUST be split into separate facts.
- QUOTE (hard rule, verbatim anchoring v4.7.7, hardened v4.7.10): every fact MUST include "quote" — the EXACT verbatim sentence or substring of the CONVERSATION that the fact was extracted from, copied WORD-FOR-WORD from the input. Do NOT paraphrase, elide, merge, summarize, or "clean up" the quote — a paraphrased or composite quote will be REJECTED and the fact discarded. If the exact sentence is longer than 120 chars, copy exactly its first 120 chars (a clean verbatim prefix). If the only quote you can produce does not contain a specific you want to write, that specific was NOT in the conversation — drop it from the fact. WRONG: "Devices with HVCI/VBS have been shown to have increa..." (elided). RIGHT: "Devices with HVCI/VBS enabled have been shown to have increased boot times, shutdown times, app launch times" (verbatim).
- SPECIFICS OR NOTHING (hard rule): a fact that would be meaningless without this conversation is NOT a fact. A decision/conclusion MUST include the concrete what, where, and why (component, file, rationale). Vague announcements like "Important decision: restructure X" are REJECTED — either include the specifics or do not extract.
- "links": connect facts about the same topic into a cluster — the overview/decision fact is the anchor; satellites use "part_of" (detail of the anchor), "derives_from" (follows from another fact), or "related_to" (loose association). Links are OPTIONAL. If a fact cannot be linked with these three types, leave it unlinked — NEVER drop a memory because it cannot be linked.
Do NOT invent other fields. If nothing meets the bar, return {"context": {}, "facts": [], "links": []}.

Example of CORRECT output:
{
  "context": { "project": "Engram", "module": "traceStore", "file": "services/traceStore.ts", "topic": "trace retention policy" },
  "facts": [
    { "content": "Trace retention defaults to 7 days and is pruned by hard DELETE", "quote": "Trace retention defaults to 7 days and is pruned by hard DELETE", "sector": "semantic" },
    { "content": "The user decided trace retention must be configurable via EG_TRACE_RETENTION_DAYS, defaulting to 7", "quote": "trace retention must be configurable via EG_TRACE_RETENTION_DAYS", "sector": "procedural" }
  ],
  "links": [
    { "from": 1, "to": 0, "type": "derives_from" }
  ]
}

### INPUT DATA ###
User Prompt: ${truncatedPrompt}
AI Response: ${truncatedResponse}

### EXECUTE EXTRACTION NOW ###
`.trim();

    // Split the directive (instructions, incl. the "DO NOT EXTRACT" rules) from the
    // input data so the FULL directive lands in the system role. Previously the system
    // message was truncated to 400 chars, which cut off the entire "DO NOT EXTRACT"
    // block — so the model was told what to extract but never what to avoid, and it
    // emitted session-recap chatter that slipped past the keyword gate.
    const _splitAt = extractionPrompt.indexOf("### INPUT DATA ###");
    const systemDirective = (_splitAt >= 0 ? extractionPrompt.substring(0, _splitAt) : extractionPrompt).trim();
    const userData = (_splitAt >= 0 ? extractionPrompt.substring(_splitAt) : "").trim();

    logger.info(
      { module: 'memoryLogger', model: genModel(), userPromptLength: truncatedPrompt.length, responseLength: truncatedResponse.length },
      'Analyzing conversation for new memories'
    );

   const controller = new AbortController();
   // v4.7.10: 60s → 180s. Extraction must survive queueing behind a
   // consolidation batch on the shared generative slot (verified: consolidation
   // holds the slot for minutes; 60s aborts produced the empty-store collapses).
   const timeoutId = setTimeout(() => controller.abort(), 180_000);

    try {
      let rawResponse: string | null = null;
      let generationEnded = false;

      const chatUrl = `${tryResolveProviderUrl("generative")}/chat/completions`;
      logger.info(
        { module: 'memoryLogger', model: genModel(), url: chatUrl },
        'Sending extraction request to remote generative endpoint'
      );

      const lf = getLangfuse();
      let generation: any;
      if (lf && sessionId) {
        // Create a top-level trace for the session so memory extraction appears as its own entry.
        // The name "Memory Analysis" groups related extractions under one visible trace.
        const memTrace = lf.trace({ 
          name: "Memory Analysis", 
          sessionId, 
          metadata: { module: "memoryLogger" },
          input: extractionPrompt.substring(0, 2000),
        });
        generation = memTrace.generation({
          name: "extract",
          model: genModel(),
          modelParameters: { temperature: 0.3 },
          input: extractionPrompt,
          metadata: { module: "memoryLogger" },
        });
      } else if (lf) {
        generation = lf.generation({
          name: "memory-extraction",
          model: genModel(),
          modelParameters: { temperature: 0.3 },
          input: extractionPrompt,
          metadata: { module: "memoryLogger" },
        });
      }

      try {
        const response = await fetch(chatUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: genModel(),
            messages: [
              { role: "system", content: systemDirective },
              { role: "user", content: userData }
            ],
            stream: false,
            temperature: 0.2,
            max_tokens: 2048,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.error(
            { module: 'memoryLogger', status: response.status, model: genModel(), url: chatUrl, error: errorText.substring(0, 500) },
            'Extraction LLM returned error status'
          );
          generation?.end({ output: "", level: "ERROR" });
          generationEnded = true;
          return empty();
        }

        const data = await response.json();
        rawResponse = ((data.choices?.[0]?.message?.content || "") as string);

        generation?.end({
          output: rawResponse,
          usage: {
            promptTokens: data.usage?.prompt_tokens,
            completionTokens: data.usage?.completion_tokens,
          },
        });
        generationEnded = true;
      } finally {
        if (!generationEnded) {
          generation?.end({ output: null, level: "ERROR" });
        }
      }

      let extractedMemories: any[] = [];
      let parsed: any;

      try {
        // Strip markdown code fences (```json ... ``` or bare ``` ... ```) anywhere
        // in the response, then fall back to extracting the outermost JSON object in
        // case the model prepends prose (e.g. "Here is the extraction:").
        let cleanJson = rawResponse
          .replace(/```json\s*([\s\S]*?)\s*```/gi, "$1")
          .replace(/```\s*([\s\S]*?)\s*```/g, "$1")
          // v4.7.10: models write Windows paths with raw backslashes
          // (%programdata%\Dell\TrustedDevice\services.log) — invalid JSON
          // escapes that killed the whole extraction. Repair single
          // backslashes that are not part of a valid escape sequence.
          .replace(/(?<!\\)\\(?![\\"/bfnrtu])/g, "\\\\")
          .trim();
        try {
          parsed = JSON.parse(cleanJson);
        } catch {
          const start = cleanJson.indexOf("{");
          const end = cleanJson.lastIndexOf("}");
          if (start !== -1 && end > start) {
            parsed = JSON.parse(cleanJson.slice(start, end + 1));
          } else {
            throw new Error("no JSON object found in extraction output");
          }
        }
      } catch (e) {
        logger.error(
          { module: 'memoryLogger', model: genModel(), rawOutput: rawResponse.substring(0, 500) },
          'Failed to parse extraction JSON'
        );
        return empty();
      }

      // Normalize: accept the new {context, facts, links} object OR the legacy array.
      let ctx: any = {};
      let links: any[] = [];
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.facts)) {
        ctx = parsed.context && typeof parsed.context === 'object' ? parsed.context : {};
        links = Array.isArray(parsed.links) ? parsed.links : [];
        extractedMemories = parsed.facts;
      } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        logger.info(
          { module: 'memoryLogger', model: genModel() },
          `LLM returned single object, wrapping as array`
        );
        extractedMemories = [parsed];
      } else if (Array.isArray(parsed)) {
        extractedMemories = parsed;
      }

      if (!extractedMemories.length) {
        logger.info({ module: 'memoryLogger', model: genModel() }, 'No new significant memories extracted');
        return empty();
      }

      // Cap extracted facts to prevent memory explosion
      if (extractedMemories.length > MAX_FACTS_PER_TURN) {
        logger.info({ module: 'memoryLogger', model: genModel(), total: extractedMemories.length, capped: MAX_FACTS_PER_TURN }, 'Capping extracted facts');
        extractedMemories = extractedMemories.slice(0, MAX_FACTS_PER_TURN);
        links = links.filter((l) => l.from < MAX_FACTS_PER_TURN && l.to < MAX_FACTS_PER_TURN);
      }

      // Quality gate: drop anything that isn't worth persisting long-term.
      const beforeGate = extractedMemories.length;
      const survivedIndex: number[] = [];
      extractedMemories = extractedMemories.filter((mem, i) => {
        const keep = mem?.content && typeof mem.content === 'string' && isWorthRemembering(mem.content);
        if (keep) survivedIndex.push(i);
        return keep;
      });
      if (extractedMemories.length < beforeGate) {
        logger.info({ module: 'memoryLogger', model: genModel(), dropped: beforeGate - extractedMemories.length }, 'Quality gate dropped low-value candidates');
      }

      // ── VERBATIM GROUNDING CHECK (v4.7.7) ──
      // Every fact must carry a 'quote' that (a) is a verbatim substring of the
      // conversation, and (b) contains the fact's specifics (names, numbers,
      // paths). Kills the hallucinated-specifics class ("captures the database
      // schema details but hallucinates specific table names") deterministically —
      // an invented table name cannot appear in the real conversation, so its
      // quote cannot contain it. Zero LLM cost.
      const conversationText = `${userPrompt}\n${llmResponseText}`.toLowerCase();
      // v4.7.9: normalize formatting punctuation on BOTH sides before the
      // verbatim match. The extractor copies quotes verbatim but drops
      // markdown decorations present in the conversation (bold **x**, code
      // `x`, em/en-dashes, curly quotes, ellipses) — a decorated conversation
      // vs an undecorated quote failed `includes()` and rejected every
      // grounded fact (verified live: 6/6 grounded facts rejected solely by
      // `**` / backticks in the source text). Normalization only strips
      // formatting glyphs; invented specifics still cannot appear in the
      // conversation, so the hallucinated-specifics class stays impossible.
      const normalizeVerbatim = (s: string): string =>
        s
          .replace(/[*`]/g, "")
          .replace(/[—–]/g, "-")
          .replace(/[“”]/g, '"')
          .replace(/[’]/g, "'")
          .replace(/…/g, "...")
          .replace(/\s+/g, " ")
          .trim();
      const normConv = normalizeVerbatim(conversationText);
      const STOP = new Set([
        "the","and","that","with","from","this","were","was","has","have","been","not","for","are","its","their","they","them","will","would","should","could","about","into","than","then","when","where","which","what","who","can","may","must","our","your","but","all","any","each","more","most","other","some","such","only","own","same","too","very","just","also","these","those","there","here","because","before","after","while","using","used","use","does","did","done","being","both","each","few","how","nor","once","said","says","still","though","through","under","until","upon","well","with","yet",
      ]);
      const specificPairs = (text: string): Array<{ raw: string; low: string }> => {
        // Tokens with case preserved (raw) so identifier-ish "hard" specifics
        // (numbers, paths, acronyms, kebab/snake/dotted names) can be told
        // apart from ordinary English words the extractor may paraphrase.
        // Trailing sentence periods are stripped before classification.
        const m = new Map<string, { raw: string; low: string }>();
        for (const t of text.replace(/[^a-zA-Z0-9_\-./]/g, " ").split(/\s+/)) {
          if (t.length < 4) continue;
          const raw = t.replace(/\.+$/, "");
          const low = raw.toLowerCase();
          if (STOP.has(low)) continue;
          if (!m.has(low)) m.set(low, { raw, low });
        }
        return Array.from(m.values());
      };
      // A "hard" specific is one that cannot be paraphrased: it carries a
      // digit, path/identifier punctuation, or an uppercase letter (acronym /
      // proper name). Hard specifics are the hallucination surface — an
      // invented table name or IP cannot appear in the real conversation.
      const isHard = (raw: string): boolean => /[0-9]/.test(raw) || /[-_./]/.test(raw) || /[A-Z]/.test(raw);
      let groundingRejected = 0;
      extractedMemories = extractedMemories.filter((mem) => {
        const quote = typeof mem?.quote === "string" ? mem.quote.trim() : "";
        const pairs = specificPairs(mem?.content || "");
        const hard = pairs.filter((p) => isHard(p.raw));
        if (!quote) {
          // No quote at all: unverifiable when the fact carries HARD specifics.
          // Soft (paraphraseable) wording without a quote is harmless.
          if (hard.length >= 1) {
            groundingRejected++;
            return false;
          }
          return true;
        }
        const normQuote = normalizeVerbatim(quote.toLowerCase());
        if (normQuote.length < 10 || !normConv.includes(normQuote)) {
          // v4.7.10: tolerate light paraphrase. Qwen3-VL quotes are ~95%
          // verbatim with small elisions (verified live: 3/5 good facts
          // rejected on wording alone). A grounded paraphrase still has all
          // its words in ORDER within a bounded window of the conversation
          // (greedy subsequence, ≤24-token gap). The hallucination defense is
          // carried by the hard-specifics-in-conversation check below —
          // invented names/numbers/paths cannot appear in the conversation at
          // all, so fabricated text fails BOTH this subsequence and that check.
          const tokMatch = (a: string, b: string): boolean => {
            if (a === b) return true;
            const [s, l] = a.length <= b.length ? [a, b] : [b, a];
            if (l.startsWith(s) && /^[^a-z0-9]*$/.test(l.slice(s.length))) return true; // punctuation suffix
            return l.includes(s) && l.length <= s.length * 1.5; // light containment, no long-id matches
          };
          const isSubsequence = (q: string, c: string): boolean => {
            const qt = q.split(/\s+/).filter(Boolean);
            const ct = c.split(/\s+/).filter(Boolean);
            const GAP = 24;
            // Backtracking subsequence: greedy can dead-end on the FIRST
            // occurrence of a repeated phrase (e.g. "dell secure bios" in the
            // user prompt vs the real sentence in the response). On failure at
            // token k, advance the previous token's match and retry.
            const pos = new Array(qt.length).fill(-1);
            let k = 0, steps = 0;
            while (k >= 0 && steps++ < 5000) {
              if (k === qt.length) return true;
              const minPos = k === 0 ? 0 : pos[k - 1] + 1;
              const maxPos = Math.min(ct.length, minPos + GAP);
              let found = -1;
              for (let i = Math.max(minPos, pos[k] + 1); i < maxPos; i++) {
                if (tokMatch(ct[i], qt[k])) { found = i; break; }
              }
              if (found === -1) {
                if (k === 0) return false;
                pos[k] = -1;
                k--;
                continue;
              }
              pos[k] = found;
              k++;
            }
            return false;
          };
          if (!isSubsequence(normQuote, normConv)) {
            groundingRejected++; // quote is neither verbatim nor a grounded paraphrase
            return false;
          }
        }
        if (hard.length >= 1) {
          // v4.7.9: ground HARD specifics against the CONVERSATION (the ground
          // truth), not just the quote. The quote is a verbatim fragment used
          // as provenance; a fact synthesizing several parts of the
          // conversation legitimately has specifics spread beyond the quoted
          // fragment, and the quote may be the EVIDENCE (error codes, logs)
          // rather than the subject — the old "≥50% of specifics in quote"
          // (and any in-quote anchor) over-rejected grounded facts (verified:
          // 4/6 Dell-BIOS facts failed pre-fix while ALL their specifics were
          // in the conversation). Hard specifics (numbers, paths, identifiers,
          // acronyms) cannot be paraphrased, so an invented one still cannot
          // appear in the conversation — the hallucination defense is
          // unchanged in spirit: the class stays structurally impossible.
          // Soft English words (verbs/adjectives) may be paraphrased and are
          // not checked.
          const missing = hard.filter((p) => !normConv.includes(p.low));
          if (missing.length > 0) {
            groundingRejected++; // invented specifics have no source in the conversation
            return false;
          }
        }
        return true;
      });
      if (groundingRejected > 0) {
        logger.info({ module: 'memoryLogger', rejected: groundingRejected, survived: extractedMemories.length }, 'Grounding check rejected unanchored facts');
      }

      if (!extractedMemories.length) {
        logger.info({ module: 'memoryLogger', model: genModel() }, 'No new significant memories extracted');
        return empty();
      }

      // Store each extracted memory
      const db = kit_make_db(run_async, all_async);
      let storedCount = 0;
      const sectors: Record<string, number> = {};
      const storedIds: string[] = []; // parallel to extractedMemories (survivors)
      for (const mem of extractedMemories) {
        const content = typeof mem.content === 'string' ? mem.content.trim() : '';
        if (content.length < 5) continue;

        // Normalize the LLM-provided sector to a canonical value before use.
        const sector = normalizeSector(mem.sector, "semantic");

        // Dedup: skip if an identical or near-duplicate memory already exists
        const dedupResult = await db.query(
          `select 1 from "public"."memories" where content = $1 and superseded_at is null limit 1`,
          [content],
        );
        if (dedupResult.rows?.length) {
          logger.debug({ module: 'memoryLogger', content: content.substring(0, 60) }, 'Skipping duplicate memory');
          storedIds.push(""); // keep index alignment with extractedMemories
          continue;
        }
        if (await isNearDuplicate(db, content)) {
          logger.debug({ module: 'memoryLogger', content: content.substring(0, 60) }, 'Skipping near-duplicate memory');
          storedIds.push("");
          continue;
        }

        let decayRate = DEFAULT_PHENOTYPE_DECAY_RATE;
        if (mem.is_genome && allowGenome) decayRate = DEFAULT_GENOME_DECAY_RATE;
        else if (sector === "episodic") decayRate = 0.15;
        else if (["semantic", "procedural"].includes(sector)) decayRate = 0.05;

        const result = await rememberDurableMemory(db, {
          content,
          user_id: "system",
          project_id: projectId,
          embedding: await embed(content),
          metadata: {
            sector,
            decay_rate: decayRate,
            is_genome: Boolean(mem.is_genome && allowGenome),
            // Verbatim anchoring (v4.7.7): the exact conversation text this
            // fact was extracted from — provenance + auditability.
            ...(typeof mem.quote === "string" && mem.quote.trim().length >= 10
              ? { quote: mem.quote.trim().slice(0, 200) }
              : {}),
            // Coherence rung (v4.6.0): the context frame from extraction —
            // every fact knows which project/module/file/topic it belongs to.
            ...(ctx.project || ctx.module || ctx.file || ctx.topic
              ? { context: { project: ctx.project || null, module: ctx.module || null, file: ctx.file || null, topic: ctx.topic || null } }
              : {}),
          },
        });

        storedIds.push(result.id);
        storedCount++;
        sectors[sector] = (sectors[sector] || 0) + 1;
        logger.info({ module: 'memoryLogger', model: genModel(), sector, content: content.substring(0, 60) }, `Saved ${sector} memory`);
      }

      // Coherence rung: materialize extraction-proposed links as graph edges.
      // Links reference fact indices; storedIds[i] is the memory for fact i
      // ("" when dedup skipped it). Links are auxiliary — an edge failure
      // never rolls back stored memories. Unsupported link types surface as
      // cluster_link_evaluation findings for judge/user (never dropped).
      const WRITABLE_LINK_TYPES = new Set(["part_of", "derives_from", "related_to"]);
      for (const link of links) {
        // Links reference ORIGINAL fact indices; remap through survivedIndex
        // (survivor position i = original index survivedIndex[i]) to storedIds.
        const fromPos = typeof link.from === "number" ? survivedIndex.indexOf(link.from) : -1;
        const toPos = typeof link.to === "number" ? survivedIndex.indexOf(link.to) : -1;
        const fromId = fromPos >= 0 ? storedIds[fromPos] : "";
        const toId = toPos >= 0 ? storedIds[toPos] : "";
        if (!fromId || !toId || fromId === toId) continue;
        if (!WRITABLE_LINK_TYPES.has(link.type)) {
          try {
            await db.query(
              `insert into "public"."integrity_findings"
                 (run_id, check_name, severity, action_taken, detail, status)
               values ((select id from "public"."integrity_runs" order by started_at desc limit 1),
                       'cluster_link_evaluation', 'info', 'flag', $1::jsonb, 'open')`,
              [JSON.stringify({ source_memory_id: fromId, target_memory_id: toId, proposed_type: link.type, reason: "extraction proposed a link type outside part_of/derives_from/related_to" })],
            );
          } catch {
            /* findings need an integrity_runs row; silently skip if none yet */
          }
          continue;
        }
        try {
          await db.query(
            `insert into "public"."edges"
               (id, user_id, project_id, source_memory_id, target_memory_id, edge_type, weight, confidence, provenance, metadata, recorded_at)
             values (gen_random_uuid(), 'system', $1, $2, $3, $4, 1, 0.9, $5::jsonb, $6::jsonb, now())`,
            [projectId ?? null, fromId, toId, link.type, JSON.stringify({ source: "extraction", via: "coherence" }), JSON.stringify({ extraction_link: true })],
          );
          logger.debug({ module: 'memoryLogger', from: fromId.slice(0, 8), to: toId.slice(0, 8), type: link.type }, 'Created extraction link edge');
        } catch (e: any) {
          logger.warn({ module: 'memoryLogger', err: e?.message }, 'Edge creation failed (auxiliary — ignored)');
        }
      }

      logger.info({ module: 'memoryLogger', model: genModel(), count: storedCount }, `Saved ${storedCount} new memories`);
      // True extraction-fidelity scoring (v4.7.0): expose WHAT was stored so
      // the judge can grade the extraction output, not the response receipt.
      return { storedCount, sectors, storedMemoryIds: storedIds.filter(Boolean) };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    logger.error({ module: 'memoryLogger', model: genModel(), err: error }, 'Async memory logging failed');
    return empty(); // Return 0 on error
  }
}