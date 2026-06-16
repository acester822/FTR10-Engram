/*
 - filename: packages/engram-js/src/api/routes/ide/route.ts
 - what is the file used for: VS Code extension IDE integration routes — session management, event ingestion, context queries, and pattern retrieval
*/

import crypto from "node:crypto";
import { type route_ctx } from "../_kit";
import { rememberDurableMemory, recallDurableMemories } from "../../../durable/repository";

// In-memory session store (sufficient for dev; use Redis for production multi-instance)
const sessions = new Map<string, { user_id: string; project_id?: string; ide_name: string; started_at: number }>();

export const ide_routes = (app: any, ctx: route_ctx) => {

  // POST /api/ide/session/start — called by VS Code extension on activation
  app.post("/api/ide/session/start", async (req: any, res: any) => {
    const { user_id, project_name, ide_name } = req.body || {};
    if (!user_id) return res.status(400).json({ err: "user_id is required" });

    const session_id = crypto.randomUUID();
    sessions.set(session_id, {
      user_id: String(user_id),
      project_id: project_name ? String(project_name) : undefined,
      ide_name: ide_name || "vscode",
      started_at: Date.now(),
    });

    console.log(`[IDE] Session started: ${session_id} for user=${user_id} project=${project_name || "unknown"}`);
    res.json({ session_id, ok: true });
  });

  // POST /api/ide/session/end — called by VS Code extension on deactivation
  app.post("/api/ide/session/end", async (req: any, res: any) => {
    const { session_id } = req.body || {};
    if (session_id) sessions.delete(session_id);
    res.json({ ok: true });
  });

  // POST /api/ide/events — receives file-save diffs and other IDE events
  app.post("/api/ide/events", async (req: any, res: any) => {
    const { session_id, user_id, event_type, file_path, language, content, metadata } = req.body || {};

    if (!content || !file_path) return res.json({ ok: true, skipped: "no content" });

    // Only persist save events with real content — ignore cursor moves, etc.
    if (event_type !== "save") return res.json({ ok: true, skipped: "non-save event" });

    const session = session_id ? sessions.get(String(session_id)) : null;
    const uid = user_id || session?.user_id || "system";
    const project = session?.project_id;

    try {
      await rememberDurableMemory(ctx.db, {
        content: `[IDE save: ${file_path}]\n${String(content).slice(0, 4000)}`,
        user_id: uid,
        project_id: project,
        metadata: {
          source: "vscode",
          event_type,
          file_path,
          language: language || "unknown",
          sector: "episodic",
          ...(metadata || {}),
        },
      });
      res.json({ ok: true });
    } catch (err) {
      console.error("[IDE] Failed to store event:", err);
      res.json({ ok: true, warn: "storage failed" });
    }
  });

  // POST /api/ide/context — query memories relevant to the current context
  app.post("/api/ide/context", async (req: any, res: any) => {
    const { query, session_id, file_path, limit } = req.body || {};
    if (!query) return res.status(400).json({ err: "query is required" });

    try {
      const result = await recallDurableMemories(ctx.db, {
        query: String(query),
        limit: Math.min(Number(limit) || 10, 20),
      });
      res.json({ memories: result.results || [] });
    } catch (err) {
      console.error("[IDE] Context query failed:", err);
      res.json({ memories: [] });
    }
  });

  // GET /api/ide/patterns/:session_id — return recent patterns for the session
  app.get("/api/ide/patterns/:session_id", async (req: any, res: any) => {
    const { session_id } = req.params;
    const session = sessions.get(session_id);

    if (!session) return res.json({ patterns: [] });

    try {
      // Return recent episodic + procedural memories as "patterns"
      const result = await recallDurableMemories(ctx.db, {
        query: "coding patterns workflow habits",
        limit: 10,
      });
      const patterns = (result.results || []).map((m: any) => ({
        id: m.id,
        description: m.content.slice(0, 120),
        frequency: m.access_count || 1,
        context: m.content,
        sector: m.metadata?.sector || "semantic",
      }));
      res.json({ patterns });
    } catch {
      res.json({ patterns: [] });
    }
  });

  // POST /memory/add — alias used by VS Code extension "add to memory" command
  app.post("/memory/add", async (req: any, res: any) => {
    const { content, user_id, tags, metadata } = req.body || {};
    if (!content) return res.status(400).json({ err: "content is required" });

    try {
      const result = await rememberDurableMemory(ctx.db, {
        content: String(content),
        user_id: user_id || "vscode-user",
        metadata: {
          sector: "semantic",
          source: "vscode-manual",
          tags: tags || [],
          ...(metadata || {}),
        },
      });
      res.json({ id: result.id, ok: true });
    } catch (err) {
      console.error("[IDE] memory/add failed:", err);
      res.status(500).json({ err: "Failed to store memory" });
    }
  });
};
