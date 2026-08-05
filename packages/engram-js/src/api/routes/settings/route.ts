/*
 - filename: packages/engram-js/src/api/routes/settings/route.ts
 - what is the file used for: Settings API — the web GUI Settings tab is the ONLY place
   providers/models are configured. GET returns current + resolved config; PUT saves;
   POST /test saves AND validates a section with a live provider request.
*/

import { bad, fail } from "../_kit";
import { all_async as pg_all } from "../../../database/connection";
import {
  getSettings,
  saveSettings,
  SETTING_KEYS,
} from "../../../services/settingsService";
import {
  resolveGenerativeModel,
  resolveEmbeddingModel,
  resolveProviderUrl,
  tryResolveGenerativeModel,
  tryResolveEmbeddingModel,
  tryResolveProviderUrl,
} from "../../../database/modelRegistry";

const FACETS = ["episodic", "semantic", "procedural", "emotional", "reflective"] as const;

function bodyJson(req: any): any {
  return typeof req.body === "object" && req.body !== null ? req.body : {};
}

/** Flatten the nested GUI shape { provider, generative, embedding } into setting keys. */
function flattenSettings(body: any): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const provider = body.provider || {};
  const generative = body.generative || {};
  const embedding = body.embedding || {};
  const gprov = generative.provider || {};
  const eprov = embedding.provider || {};

  out[SETTING_KEYS.providerType] = provider.type || "openai-compatible";
  if (provider.host !== undefined) out[SETTING_KEYS.providerHost] = String(provider.host).trim();
  if (provider.port !== undefined) out[SETTING_KEYS.providerPort] = String(provider.port).trim();

  if (gprov.host !== undefined) out[SETTING_KEYS.generativeProviderHost] = String(gprov.host).trim();
  if (gprov.port !== undefined) out[SETTING_KEYS.generativeProviderPort] = String(gprov.port).trim();
  if (generative.model !== undefined) out[SETTING_KEYS.generativeModel] = String(generative.model).trim();
  if (generative.extraction !== undefined) out[SETTING_KEYS.extractionModel] = String(generative.extraction).trim();
  if (generative.compaction !== undefined) out[SETTING_KEYS.compactionModel] = String(generative.compaction).trim();
  if (generative.consolidation !== undefined) out[SETTING_KEYS.consolidationModel] = String(generative.consolidation).trim();

  if (eprov.host !== undefined) out[SETTING_KEYS.embeddingProviderHost] = String(eprov.host).trim();
  if (eprov.port !== undefined) out[SETTING_KEYS.embeddingProviderPort] = String(eprov.port).trim();
  if (embedding.model !== undefined) out[SETTING_KEYS.embeddingModel] = String(embedding.model).trim();
  for (const f of FACETS) {
    if (embedding[f] !== undefined) out[`embedding.${f}`] = String(embedding[f]).trim();
  }
  return out;
}

function settingsView() {
  const s = getSettings();
  return {
    provider: {
      type: s[SETTING_KEYS.providerType] || "openai-compatible",
      host: s[SETTING_KEYS.providerHost] || "",
      port: s[SETTING_KEYS.providerPort] || "",
    },
    generative: {
      provider: {
        host: s[SETTING_KEYS.generativeProviderHost] || "",
        port: s[SETTING_KEYS.generativeProviderPort] || "",
      },
      model: s[SETTING_KEYS.generativeModel] || "",
      extraction: s[SETTING_KEYS.extractionModel] || "",
      compaction: s[SETTING_KEYS.compactionModel] || "",
      consolidation: s[SETTING_KEYS.consolidationModel] || "",
    },
    embedding: {
      provider: {
        host: s[SETTING_KEYS.embeddingProviderHost] || "",
        port: s[SETTING_KEYS.embeddingProviderPort] || "",
      },
      model: s[SETTING_KEYS.embeddingModel] || "",
      episodic: s[SETTING_KEYS.facetEpisodic] || "",
      semantic: s[SETTING_KEYS.facetSemantic] || "",
      procedural: s[SETTING_KEYS.facetProcedural] || "",
      emotional: s[SETTING_KEYS.facetEmotional] || "",
      reflective: s[SETTING_KEYS.facetReflective] || "",
    },
  };
}

function resolvedView() {
  const genModel = tryResolveGenerativeModel("default");
  const genExtraction = tryResolveGenerativeModel("extraction");
  const genCompaction = tryResolveGenerativeModel("compaction");
  const genConsolidation = tryResolveGenerativeModel("consolidation");
  const embModel = tryResolveEmbeddingModel("semantic");
  return {
    providerUrl: tryResolveProviderUrl("generative"),
    generative: {
      model: genModel,
      extraction: genExtraction,
      compaction: genCompaction,
      consolidation: genConsolidation,
    },
    embedding: {
      model: embModel,
      episodic: tryResolveEmbeddingModel("episodic"),
      semantic: embModel,
      procedural: tryResolveEmbeddingModel("procedural"),
      emotional: tryResolveEmbeddingModel("emotional"),
      reflective: tryResolveEmbeddingModel("reflective"),
    },
  };
}

function validateHost(host: string): string | null {
  if (!host) return "Provider host is required";
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return "Provider host must be an IP address or hostname";
  return null;
}

function validatePort(port: string): string | null {
  if (!port) return null; // port optional (defaults to 80)
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return "Port must be between 1 and 65535";
  return null;
}

/** Live provider test for a section. Uses the settings passed in (after saving them). */
async function testSection(section: "generative" | "embedding"): Promise<any> {
  const started = Date.now();
  try {
    const url = resolveProviderUrl(section);
    if (section === "generative") {
      const model = resolveGenerativeModel("default");
      const res = await fetch(`${url}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        }),
      });
      const ms = Date.now() - started;
      if (!res.ok) {
        const text = (await res.text().catch(() => "")).substring(0, 300);
        return { ok: false, section, model, providerUrl: url, latencyMs: ms, error: `HTTP ${res.status}: ${text}` };
      }
      return { ok: true, section, model, providerUrl: url, latencyMs: ms };
    }
    // embedding
    const model = resolveEmbeddingModel("semantic");
    const res = await fetch(`${url}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: "ping" }),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).substring(0, 300);
      return { ok: false, section, model, providerUrl: url, latencyMs: ms, error: `HTTP ${res.status}: ${text}` };
    }
    const data = await res.json();
    const dims = Array.isArray(data?.data?.[0]?.embedding) ? data.data[0].embedding.length : 0;
    return { ok: dims > 0, section, model, providerUrl: url, latencyMs: ms, dims, error: dims > 0 ? undefined : "Empty embedding returned" };
  } catch (e: any) {
    return { ok: false, section, latencyMs: Date.now() - started, error: e?.message || String(e) };
  }
}

export const settings_route = (app: any) => {
  app.get("/api/settings", async (req: any, res: any) => {
    try {
      res.json({
        settings: settingsView(),
        resolved: resolvedView(),
      });
    } catch (e) {
      fail(res, "settings_get_failed", e);
    }
  });

  app.put("/api/settings", async (req: any, res: any) => {
    try {
      const body = bodyJson(req);
      const flat = flattenSettings(body);
      const host = flat[SETTING_KEYS.providerHost] || "";
      const port = flat[SETTING_KEYS.providerPort] || "";
      const hostErr = validateHost(host);
      if (hostErr) return bad(res, "provider.host", hostErr);
      const portErr = validatePort(port);
      if (portErr) return bad(res, "provider.port", portErr);
      await saveSettings(flat);
      res.json({ ok: true, settings: settingsView(), resolved: resolvedView() });
    } catch (e) {
      fail(res, "settings_save_failed", e);
    }
  });

  app.post("/api/settings/test", async (req: any, res: any) => {
    try {
      const body = bodyJson(req);
      const section = body.section === "embedding" ? "embedding" : "generative";

      // The test button saves ALL settings first, then validates the section live.
      if (body.settings && typeof body.settings === "object") {
        const flat = flattenSettings(body.settings);
        const host = flat[SETTING_KEYS.providerHost] || "";
        const hostErr = validateHost(host);
        if (hostErr) return bad(res, "provider.host", hostErr);
        const portErr = validatePort(flat[SETTING_KEYS.providerPort] || "");
        if (portErr) return bad(res, "provider.port", portErr);
        await saveSettings(flat);
      }

      const result = await testSection(section);
      res.json(result);
    } catch (e) {
      fail(res, "settings_test_failed", e);
    }
  });
};
