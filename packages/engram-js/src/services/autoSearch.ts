import { env } from "../configuration";
import { logger } from "../utils/logger";

// ── Types ─────────────────────────────────────────────────────────────

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  content: string;
  engine: string;
}

interface SearXNGResult {
  title: string;
  url: string;
  content: string;
  engine: string;
  category: string;
}

interface SearXNGSuggestions {
  query: string;
  number_of_results: number;
  results: SearXNGResult[];
  answers: string[];
  suggestions: string[];
  corrections: string[];
}

interface CrawledDoc {
  request_url: string;
  final_url: string;
  status: string;
  markdown: string;
  error_message: string | null;
  metadata: Record<string, unknown>;
}

interface CrawlResponse {
  crawled_at: string;
  documents: CrawledDoc[];
  summary: { total: number; successful: number; failed: number };
}

// ── Heuristics for detecting technology/language/framework topics ────

const TECH_PATTERNS = [
  /\b(node\.?js|express|react|vue|angular|next\.?js|nuxt|svelte|solid|sveltekit)\b/i,
  /\b(python|django|flask|fastapi|pytorch|tensorflow|asyncio|pandas|numpy)\b/i,
  /\b(postgres|mysql|mongo|redis|prisma|typeorm|drizzle|sqlite)\b/i,
  /\b(docker|kubernetes|k8s|terraform|ansible|helm|compose)\b/i,
  /\b(aws|gcp|azure|cloudflare|vercel|netlify|heroku|fly\.io)\b/i,
  /\b(api|sdk|library|framework|package|module|dependency|config|middleware)\b/i,
  /\b(how\s+to|guide|tutorial|example|docs?|documentation|setup|install)\b/i,
  /\b(graphql|rest|grpc|websocket|sse|oauth|jwt|cors)\b/i,
  /\b(typescript|javascript|rust|go|golang|swift|kotlin|elixir|zig)\b/i,
  /\b(react\s+native|flutter|electron|tauri|expo|prisma|tRPC)\b/i,
];

function isTechPrompt(prompt: string): boolean {
  return TECH_PATTERNS.some((p) => p.test(prompt));
}

// ── MCP SSE client ──────────────────────────────────────────────────

/**
 * Manages a single SSE connection to the FastMCP HTTP transport.
 * FastMCP requires: GET /mcp for SSE → yields session_id, then POST /mcp
 * with JSON-RPC bodies. Responses arrive as SSE messages on the GET stream.
 */
class MCPClient {
  private baseUrl: string;
  private sessionId: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async connect(signal?: AbortSignal): Promise<string> {
    if (this.sessionId) return this.sessionId;

    const response = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "engram", version: "1.0" },
        },
      }),
      signal,
    });

    if (!response.ok) throw new Error(`MCP init failed: ${response.status}`);

    const sid = response.headers.get("mcp-session-id");
    if (!sid) throw new Error("No mcp-session-id header in initialize response");

    this.sessionId = sid;

    return sid;
  }

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.sessionId) throw new Error("MCP client not connected");

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: method, arguments: params },
    });

    const response = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": this.sessionId,
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`MCP call failed (${response.status}): ${text.slice(0, 200)}`);
    }

    const text = await response.text();

    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.error) throw new Error(`MCP error: ${data.error.message}`);
        if (data.result) {
          const content = data.result.content;
          if (Array.isArray(content) && content.length > 0 && content[0].type === "text") {
            return JSON.parse(content[0].text as string) as T;
          }
          return data.result as T;
        }
      } catch (e: any) {
        if (e.message?.startsWith("MCP error:")) throw e;
      }
    }

    throw new Error(`Could not parse MCP response: ${text.slice(0, 200)}`);
  }
}

function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort(sig.reason);
      return controller.signal;
    }
    sig.addEventListener("abort", () => controller.abort(sig.reason), { once: true });
  }
  return controller.signal;
}

// ── Singletons per URL ──────────────────────────────────────────────

const mcpClients = new Map<string, MCPClient>();

function getMCPClient(): MCPClient {
  const url = env.auto_search_url;
  if (!mcpClients.has(url)) {
    mcpClients.set(url, new MCPClient(url));
  }
  return mcpClients.get(url)!;
}

// ── Auto-Search Engine ──────────────────────────────────────────────

export class AutoSearchEngine {
  async generateQueries(
    userPrompt: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string[]> {
    const systemPrompt =
      "You are a search query generator for a knowledge augmentation system. Given the user's request, output exactly 2-3 short, focused web search queries that would find authoritative documentation or answers. Return ONLY a JSON array of strings (no markdown, no explanation).";

    let rawResponse: string;

    try {
      const chatUrl = `${env.generative_url}/chat/completions`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: env.generative_model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `${userPrompt}\n\n/no_think` },
          ],
          stream: false,
          temperature: 0.1,
          max_tokens: 256,
        }),
        signal: options.signal || controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok)
        throw new Error(`Query gen LLM returned ${response.status}`);
      const data = await response.json();
      rawResponse = (
        (data.choices?.[0]?.message?.content || "") as string
      )
        .replace(/^```json\s*|\s*```$/g, "")
        .trim();

      if (!rawResponse) return [];

      const parsed = JSON.parse(rawResponse);
      const queries: string[] = Array.isArray(parsed) ? parsed : [parsed];
      return queries
        .filter((q) => typeof q === "string" && q.length > 3)
        .slice(0, 3);
    } catch (error: any) {
      logger.warn(
        { module: "autoSearch", err: error.message },
        "Query generation failed — falling back to keyword extraction",
      );
      return this.extractKeywords(userPrompt);
    }
  }

  private extractKeywords(prompt: string): string[] {
    const keywords: string[] = [];
    for (const pattern of TECH_PATTERNS) {
      const match = prompt.match(pattern);
      if (match) keywords.push(match[0].toLowerCase().replace(/^\./, ""));
    }
    const unique = [...new Set(keywords)];
    return unique.length > 0 ? [unique.join(" ") + " documentation"] : [];
  }

  async search(
    queries: string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<SearXNGResult[]> {
    if (queries.length === 0) return [];

    const client = getMCPClient();
    await client.connect(options.signal);

    const allResults: SearXNGResult[] = [];
    const seenUrls = new Set<string>();

    for (const query of queries) {
      try {
        const result = await client.call<SearXNGSuggestions>("search", {
          query,
          max_results: 5,
          language: "en",
          safesearch: 1,
        });

        for (const r of result.results || []) {
          const url = r.url?.split("?")[0];
          if (!url || seenUrls.has(url)) continue;

          const domain = new URL(url).hostname;

          if (
            env.auto_search_domains.length > 0 &&
            !env.auto_search_domains.some((d) => domain.includes(d))
          ) {
            continue;
          }

          seenUrls.add(url);
          allResults.push(r);
        }
      } catch (error: any) {
        logger.warn(
          { module: "autoSearch", query, err: error.message },
          "Search failed for query",
        );
      }
    }

    return allResults.slice(0, env.auto_search_max_results);
  }

  async fetchContent(
    results: SearXNGResult[],
    options: { signal?: AbortSignal } = {},
  ): Promise<SearchResult[]> {
    if (results.length === 0) return [];

    const urls = results.map((r) => r.url.split("?")[0]);
    const searchResultMap = new Map(results.map((r) => [r.url.split("?")[0], r]));

    let crawlResponse: CrawlResponse;

    try {
      const client = getMCPClient();
      await client.connect(options.signal);

      crawlResponse = await client.call<CrawlResponse>("crawl", {
        urls,
        output_format: "markdown",
        timeout: 15,
        concurrency: 3,
        dedup_mode: "exact",
      });
    } catch (error: any) {
      logger.warn(
        { module: "autoSearch", err: error.message },
        "Crawl failed — falling back to search snippets only",
      );
      return results.map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.content,
        content: r.content,
        engine: r.engine,
      }));
    }

    const out: SearchResult[] = [];
    for (const doc of crawlResponse.documents || []) {
      if (doc.status !== "success" || !doc.markdown) continue;

      const src = searchResultMap.get(doc.final_url) || searchResultMap.get(doc.request_url);
      const maxChars = env.auto_search_max_chars;

      let content = doc.markdown;
      if (content.length > maxChars) {
        content = content.substring(0, maxChars) + "\n... [TRUNCATED]";
      }

      out.push({
        url: doc.final_url || doc.request_url,
        title: (doc.metadata?.title as string) || src?.title || doc.final_url,
        snippet: src?.content || content.substring(0, 200),
        content,
        engine: src?.engine || "crawl4ai",
      });
    }

    return out;
  }

  shouldSearch(topScore: number, userPrompt: string): boolean {
    if (!env.auto_search_enabled) return false;
    if (topScore >= env.auto_search_min_confidence) return false;
    return isTechPrompt(userPrompt);
  }

  formatContext(results: SearchResult[]): string {
    if (results.length === 0) return "";

    let block = "\n--- WEB CONTEXT (auto-retrieved) ---\n";
    for (const r of results) {
      block += `[${r.title}]\n`;
      block += `  Source: ${r.url} (${r.engine})\n`;
      block += `  ${r.content}\n\n`;
    }

    return block;
  }
}

export const autoSearch = new AutoSearchEngine();