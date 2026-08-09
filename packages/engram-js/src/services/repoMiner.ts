/*
 - filename: packages/engram-js/src/services/repoMiner.ts
 - what is the file used for: the repo baseline indexer's STRUCTURAL MINER
   (v4.7.0-repo-index). Two tiers, both ZERO-LLM:
     T1 — line-based heuristic (regex per language): functions/classes/
          imports/exports signatures. Zero deps, fast, ~80% of the value.
     T2 — tree-sitter AST parsing (web-tree-sitter + per-language wasm
          grammars vendored from npm packages, the reference tool's proven
          path): verified syntax, call graph, generics, nested structure.
   Output shape is identical for both tiers — one memory per file:
   { path, summary, entities[], imports[], exports[] }.
*/

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

// ── Language detection ───────────────────────────────────────────────────
export const SUPPORTED_EXTENSIONS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".cpp": "cpp",
  ".cs": "csharp",
};

export interface MinedFile {
  path: string;
  language: string;
  tier: "T1" | "T2";
  summary: string;
  entities: string[];
  imports: string[];
  exports: string[];
}

// ── T1: line-based heuristic ─────────────────────────────────────────────
// Per-language regexes: [entities, imports, exports]. Good-enough structural
// baseline: names + signatures, nothing about internals.
const T1_PATTERNS: Record<string, { entity: RegExp; import: RegExp; export: RegExp }> = {
  typescript: {
    entity: /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    import: /^\s*import\s+.*?from\s+["']([^"']+)["']/gm,
    export: /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)|^\s*export\s*\{([^}]+)\}/gm,
  },
  javascript: {
    entity: /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    import: /^\s*(?:import\s+.*?from\s+["']([^"']+)["']|const\s+\w+\s*=\s*require\(["']([^"']+)["']\))/gm,
    export: /^\s*module\.exports\s*=\s*([A-Za-z_$][\w$]*)|^\s*export\s+(?:default\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  },
  python: {
    entity: /^\s*(?:async\s+)?def\s+([a-zA-Z_]\w*)|^\s*class\s+([A-Za-z_]\w*)/gm,
    import: /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm,
    export: /^\s*(?:async\s+)?def\s+([a-zA-Z_]\w*)|^\s*class\s+([A-Za-z_]\w*)/gm,
  },
  go: {
    entity: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|^\s*type\s+([A-Za-z_]\w*)/gm,
    import: /^\s*import\s+(?:\(|"([^"]+)"|([A-Za-z_]\w*)\s*"([^"]+)")/gm,
    export: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)|^\s*type\s+([A-Z]\w*)/gm,
  },
  rust: {
    entity: /^\s*(?:pub\s+)?(?:fn|struct|enum|trait|type|impl)\s+([A-Za-z_]\w*)/gm,
    import: /^\s*use\s+([\w:]+)/gm,
    export: /^\s*pub\s+(?:fn|struct|enum|trait|type)\s+([A-Za-z_]\w*)/gm,
  },
  java: {
    entity: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface|enum)\s+([A-Za-z_]\w*)|^\s*(?:public|private|protected)\s+[\w<>\[\],\s]+\s+([a-z]\w*)\s*\(/gm,
    import: /^\s*import\s+([\w.]+)/gm,
    export: /^\s*(?:public|protected)\s+(?:static\s+)?(?:class|interface|enum)\s+([A-Za-z_]\w*)/gm,
  },
  ruby: {
    entity: /^\s*(?:def\s+([a-zA-Z_]\w*)|class\s+([A-Z]\w*)|module\s+([A-Z]\w*))/gm,
    import: /^\s*(?:require|require_relative)\s+["']([^"']+)["']/gm,
    export: /^\s*def\s+([a-zA-Z_]\w*)/gm,
  },
  php: {
    entity: /^\s*(?:public|private|protected)?\s*function\s+([A-Za-z_]\w*)|^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/gm,
    import: /^\s*use\s+([\w\\]+)/gm,
    export: /^\s*function\s+([A-Za-z_]\w*)/gm,
  },
  c: {
    entity: /^\s*(?:static\s+)?(?:[\w\s\*]+?)\s+([a-zA-Z_]\w*)\s*\([^;]*\)\s*\{/gm,
    import: /^\s*#include\s*[<"]([^>"]+)[>"]/gm,
    export: /^\s*(?:[\w\s\*]+?)\s+([a-zA-Z_]\w*)\s*\(/gm,
  },
  cpp: {
    entity: /^\s*(?:class|struct|namespace|template\s*<[^>]+>\s*class)\s+([A-Za-z_]\w*)/gm,
    import: /^\s*#include\s*[<"]([^>"]+)[>"]/gm,
    export: /^\s*(?:[\w\s\*&:]+?)\s+([a-zA-Z_]\w*)\s*\(/gm,
  },
  csharp: {
    entity: /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/gm,
    import: /^\s*using\s+([\w.]+)/gm,
    export: /^\s*(?:public|protected|internal)\s+[\w<>\[\],\s]+\s+([A-Za-z_]\w*)\s*\(/gm,
  },
};

const T1_FALLBACK_ENTITY = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

function matchAll(re: RegExp, text: string): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    for (let i = 1; i < m.length; i++) {
      if (m[i] !== undefined) out.push(m[i].trim());
    }
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return [...new Set(out)];
}

export function mineT1(path: string, content: string): MinedFile {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  const language = SUPPORTED_EXTENSIONS[ext] ?? "unknown";
  const pat = T1_PATTERNS[language] ?? { entity: T1_FALLBACK_ENTITY, import: /^import/g, export: /^export/g };
  const entities = matchAll(pat.entity, content);
  const imports = matchAll(pat.import, content);
  const exportedNames = matchAll(pat.export, content).length ? matchAll(pat.export, content) : entities;
  const summary = buildSummary(path, language, entities, imports, exportedNames, "T1");
  return { path, language, tier: "T1", summary, entities, imports, exports: exportedNames };
}

// ── T2: tree-sitter AST parsing ──────────────────────────────────────────
// Lazy singleton parser — grammars load once, cached. Vendored from npm
// packages (the reference tool's proven path); wasm ships in-package.
let tsParser: any = null;
let tsLanguages: Record<string, any> = {};

async function getTsParser(): Promise<any> {
  if (tsParser) return tsParser;
  try {
    const mod = await import("web-tree-sitter");
    const Parser = (mod as any).Parser ?? (mod as any).default?.Parser;
    if (!Parser) throw new Error("web-tree-sitter: no Parser export");
    await Parser.init();
    tsParser = Parser;
    return Parser;
  } catch (e: any) {
    tsParser = null;
    throw e;
  }
}

const GRAMMAR_PACKAGES: Record<string, string> = {
  typescript: "tree-sitter-typescript",
  javascript: "tree-sitter-javascript",
  python: "tree-sitter-python",
  go: "tree-sitter-go",
  rust: "tree-sitter-rust",
  c: "tree-sitter-c",
  cpp: "tree-sitter-cpp",
};

async function loadTsLanguage(language: string): Promise<any> {
  if (tsLanguages[language]) return tsLanguages[language];
  const Parser = await getTsParser();
  const pkg = GRAMMAR_PACKAGES[language];
  if (!pkg) return null;
  try {
    const require2 = createRequire(__filename);
    const pkgMain = require2.resolve(`${pkg}/package.json`);
    const wasmPath = join(dirname(pkgMain), `tree-sitter-${language}.wasm`);
    if (!existsSync(wasmPath)) return null;
    // web-tree-sitter exports Language as a separate named export; the
    // Parser class carries static `init()` and a `LANGUAGE_VERSION` —
    // grammar loading goes through Language.load(wasmPath).
    const mod: any = await import("web-tree-sitter");
    const Language = mod.Language ?? mod.default?.Language;
    if (!Language?.load) return null;
    const lang = await Language.load(wasmPath);
    tsLanguages[language] = lang;
    return lang;
  } catch (e: any) {
    return null;
  }
}

/** Walk a tree-sitter tree, collecting named declarations + calls. */
function walkTs(node: any, out: { entities: Set<string>; calls: Set<string>; imports: Set<string> }, depth = 0): void {
  if (!node || depth > 12) return;
  const t = node.type;
  const nameField = node.childForFieldName && node.childForFieldName("name");
  if (
    (t === "function_declaration" || t === "method_definition" || t === "class_declaration" ||
     t === "interface_declaration" || t === "type_alias_declaration" || t === "enum_declaration" ||
     t === "struct_item" || t === "enum_item" || t === "trait_item" || t === "impl_item" ||
     t === "function_item" || t === "class_definition" || t === "function_definition") &&
    nameField
  ) {
    out.entities.add(nameField.text);
  }
  if ((t === "call_expression" || t === "call") && node.childForFieldName && node.childForFieldName("function")) {
    const fn = node.childForFieldName("function");
    if (fn && fn.type === "identifier") out.calls.add(fn.text);
  }
  if (t === "import_statement" || t === "import_from_statement" || t === "use_declaration") {
    const src = node.childForFieldName && node.childForFieldName("source");
    if (src) out.imports.add(src.text.replace(/["']/g, ""));
  }
  if (node.namedChildren) {
    for (const c of node.namedChildren) walkTs(c, out, depth + 1);
  } else if (node.children) {
    for (const c of node.children) walkTs(c, out, depth + 1);
  }
}

export async function mineT2(path: string, content: string): Promise<MinedFile> {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  const language = SUPPORTED_EXTENSIONS[ext] ?? "unknown";
  try {
    const Parser = await getTsParser();
    const lang = await loadTsLanguage(language);
    if (!lang) return mineT1(path, content); // graceful fallback
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(content);
    const out = { entities: new Set<string>(), calls: new Set<string>(), imports: new Set<string>() };
    walkTs(tree.rootNode, out);
    const entities = [...out.entities];
    const imports = [...out.imports];
    const exportedNames = entities;
    const summary = buildSummary(path, language, entities, imports, exportedNames, "T2", [...out.calls]);
    return { path, language, tier: "T2", summary, entities, imports, exports: exportedNames };
  } catch (e: any) {
    return mineT1(path, content); // any parser failure → T1 (never fail the index)
  }
}

// ── Shared summary builder ───────────────────────────────────────────────
function buildSummary(
  path: string,
  language: string,
  entities: string[],
  imports: string[],
  exportedNames: string[],
  tier: "T1" | "T2",
  calls: string[] = [],
): string {
  const rel = path.replace(/^\.\//, "");
  const parts: string[] = [`File ${rel} (${language})`];
  if (exportedNames.length) parts.push(`exports: ${exportedNames.slice(0, 24).join(", ")}`);
  if (entities.length && entities.join("|") !== exportedNames.join("|")) {
    parts.push(`defines: ${entities.slice(0, 24).join(", ")}`);
  }
  if (imports.length) parts.push(`imports: ${imports.slice(0, 16).join(", ")}`);
  if (tier === "T2" && calls.length) parts.push(`calls: ${calls.slice(0, 16).join(", ")}`);
  return parts.join(". ") + ".";
}

/** Convenience: mine one file (T2 with T1 fallback). */
export async function mineFile(path: string, content: string): Promise<MinedFile> {
  try {
    return await mineT2(path, content);
  } catch {
    return mineT1(path, content);
  }
}
