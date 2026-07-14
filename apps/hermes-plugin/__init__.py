"""Engram memory + cognition provider plugin for Hermes.

Bridges Hermes to a running FTR10 Engram memory proxy
(https://github.com/acester822/FTR10-Engram) over its REST API.

Architecture note (the "reroute"):
  Hermes stays the orchestrator. Engram is a *backend* + *cognition engine*,
  never the chat proxy.
  - Hermes's model.base_url points at the real LLM (OpenRouter), NOT Engram.
  - Engram is reached only through this plugin's HTTP calls:
      * prefetch()  -> /recall  (+ cached genome)  injected before each turn
      * sync_turn() -> /ingest/conversation  FULL TURN (user msg + assistant
                      reply + tool I/O) so Engram's own extraction LLM decides
                      what is worth storing (genome vs phenotype, sector, decay).
                      Hermes does NOT pre-filter — Engram is the memory authority.
      * on_memory_write() -> /memories  only for the explicit engram_remember tool
      * maintenance tools -> /api/dashboard/consolidate, /admin/decay/run,
        /contradictions
  Engram's own /v1/chat/completions proxy, compaction, and auto-search are NOT
  used (Hermes already does orchestration + compression + web search). We instead
  drive Engram's *native* extraction (logInteractionAsync) via /ingest/conversation,
  which is the exact same path the chat proxy uses — so Engram gets the entire
  reply and decides storage, exactly as designed.

Engram's "more than memory" engines map as:
  Recall + phenotype injection ........ prefetch()
  Genome (immutable directives) ....... cached on init, always injected
  Fact extraction / durable store ..... sync_turn() -> /ingest/conversation (FULL reply)
  Consolidation ....................... engram_consolidate tool + on_session_end
  Decay engine ........................ engram_decay tool
  Contradiction tracking .............. engram_contradiction tool

No MCP server, no extra dependencies — stdlib urllib only.

Config (config.yaml under plugins.engram OR env vars):
  base_url      EG base URL             (default http://localhost:8098)
  api_key       EG_API_KEY (if auth)    (default empty -> no auth header)
  user_id       scope writes to you      (default "hermes")
  recall_user_id scope recall queries    (default "" -> no scope, sees system-stored
                                          extraction memories too)
  project_id    scope to a project       (default empty -> all projects)
  recall_limit  max phenotype/turn       (default 5)
  recall_mode   strict|historical|associative (default associative)
  genome_limit  max genome directives/turn (default 15)
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "http://localhost:8098"
DEFAULT_USER_ID = "hermes"
DEFAULT_RECALL_USER_ID = ""  # empty -> no scope; Engram's extraction stores as "system"
DEFAULT_RECALL_LIMIT = 5
DEFAULT_RECALL_MODE = "associative"
DEFAULT_GENOME_LIMIT = 15


# ---------------------------------------------------------------------------
# Plugin config
# ---------------------------------------------------------------------------

def _load_plugin_config() -> dict:
    from hermes_constants import get_hermes_home
    import os
    cfg: dict = {}
    config_path = get_hermes_home() / "config.yaml"
    if config_path.exists():
        try:
            import yaml
            with open(config_path, encoding="utf-8-sig") as f:
                all_config = yaml.safe_load(f) or {}
            cfg = (all_config.get("plugins") or {}).get("engram") or {}
        except Exception:
            cfg = {}
    env_map = {
        "base_url": "EG_BASE_URL",
        "api_key": "EG_API_KEY",
        "user_id": "EG_USER_ID",
        "recall_user_id": "EG_RECALL_USER_ID",
    }
    for key, env in env_map.items():
        if os.environ.get(env):
            cfg[key] = os.environ[env]
    return cfg


# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------

class _EngramClient:
    def __init__(self, base_url: str, api_key: str, user_id: str, project_id: str,
                 recall_user_id: str = ""):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.user_id = user_id
        self.project_id = project_id
        self._recall_user_id = recall_user_id

    # -- low level --------------------------------------------------------

    def _headers(self) -> Dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    def _request(self, method: str, path: str, payload: Optional[dict] = None) -> Optional[dict]:
        url = f"{self.base_url}{path}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(url, data=data, headers=self._headers(), method=method)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            # try the /api-prefixed variant for other Engram builds
            if not path.startswith("/api/"):
                return self._request(method, "/api" + path, payload)
            body = e.read().decode("utf-8", "replace")[:300]
            logger.debug("Engram %s %s -> HTTP %s: %s", method, path, e.code, body)
            return None
        except Exception as e:
            logger.debug("Engram %s %s failed: %s", method, path, e)
            return None

    def _get(self, path: str, params: Optional[dict] = None) -> Optional[dict]:
        if params:
            q = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items() if v is not None)
            if q:
                path = f"{path}?{q}"
        return self._request("GET", path)

    def _post(self, path: str, payload: dict) -> Optional[dict]:
        return self._request("POST", path, payload)

    def _delete(self, path: str) -> bool:
        res = self._request("DELETE", path, {})
        return res is not None

    # -- recall / store ---------------------------------------------------

    def recall(self, query: str, limit: int, mode: str) -> List[dict]:
        payload = {"query": query, "limit": limit, "mode": mode}
        # Scope only when configured; empty recall_user_id -> no scope, so we
        # also see memories Engram's extraction stored under user_id="system".
        if self._recall_user_id:
            payload["user_id"] = self._recall_user_id
        if self.project_id:
            payload["project_id"] = self.project_id
        res = self._post("/recall", payload)
        if not res:
            return []
        return res.get("results", []) or []

    def remember(self, content: str, metadata: Optional[dict] = None) -> Optional[dict]:
        payload: dict = {"content": content, "user_id": self.user_id}
        if self.project_id:
            payload["project_id"] = self.project_id
        if metadata:
            payload["metadata"] = metadata
        return self._post("/memories", payload)

    def converse(self, user_prompt: str, llm_response: str,
                 session_id: str = "", metadata: Optional[dict] = None) -> Optional[dict]:
        """Hand Engram the FULL turn so its native extraction LLM decides storage.

        Targets POST /ingest/conversation (a thin route that calls Engram's
        logInteractionAsync — the same path its /v1/chat/completions proxy uses).
        Falls back to POST /ingest (raw event -> extraction candidate) if the
        dedicated route is absent. Hermes never pre-filters; Engram is the
        memory authority.
        """
        payload: dict = {
            "user_prompt": user_prompt,
            "llm_response": llm_response,
            "session_id": session_id or "",
        }
        if self.project_id:
            payload["project_id"] = self.project_id
        if metadata:
            payload["metadata"] = metadata
        res = self._post("/ingest/conversation", payload)
        if res is not None:
            return res
        # Fallback: raw event (creates an extraction candidate, queued).
        fallback = {
            "source": {"kind": "hermes", "uri": "hermes://conversation",
                       "content_type": "text/plain"},
            "content": f"USER: {user_prompt}\n\nASSISTANT: {llm_response}",
            "user_id": self.user_id,
        }
        if self.project_id:
            fallback["project_id"] = self.project_id
        if metadata:
            fallback["metadata"] = metadata
        return self._post("/ingest", fallback)

    def delete(self, memory_id: str) -> bool:
        return self._delete(f"/memories/{memory_id}")

    # -- genome (cached core directives) ----------------------------------

    def genome(self, limit: int = 500) -> List[dict]:
        res = self._get("/api/dashboard/memories", {"limit": limit})
        if not res:
            return []
        mems = res.get("memories", []) or []
        # is_genome may be bool or 0/1 depending on build
        return [m for m in mems if m.get("is_genome") in (True, 1, "true", "t")]

    # -- maintenance engines ----------------------------------------------

    def health(self) -> Optional[dict]:
        return self._get("/health")

    def consolidate(self) -> Optional[dict]:
        return self._post("/api/dashboard/consolidate", {})

    def decay(self, dry_run: bool = False, limit: Optional[int] = None) -> Optional[dict]:
        body: dict = {"dry_run": dry_run}
        if limit is not None:
            body["limit"] = limit
        if self.user_id:
            body["user_id"] = self.user_id
        return self._post("/admin/decay/run", body)

    def contradiction_create(self, memory_id: str, contradicts_id: str,
                             confidence: Optional[float] = None) -> Optional[dict]:
        body: dict = {"memory_id": memory_id, "contradicts_memory_id": contradicts_id,
                      "user_id": self.user_id}
        if self.project_id:
            body["project_id"] = self.project_id
        if confidence is not None:
            body["confidence"] = confidence
        return self._post("/contradictions", body)

    def contradiction_resolve(self, contradiction_id: str, resolution: str) -> Optional[dict]:
        body: dict = {"resolution": resolution, "user_id": self.user_id}
        return self._post(f"/contradictions/{contradiction_id}/resolve", body)


# ---------------------------------------------------------------------------
# Tool schemas
# ---------------------------------------------------------------------------

REMEMBER_SCHEMA = {
    "name": "engram_remember",
    "description": (
        "Store a durable, project-aware memory in Engram (PostgreSQL + pgvector). "
        "Use for facts, preferences, decisions, code patterns, or anything the user "
        "would expect you to remember across sessions. Engram classifies and embeds it "
        "automatically. Returns the new memory id."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "content": {"type": "string", "description": "The factual memory to store (one clear statement)."},
            "note": {"type": "string", "description": "Optional context about why this is being remembered."},
            "genome": {
                "type": "boolean",
                "description": "If true, store as an immutable core directive (genome) that is always injected.",
            },
        },
        "required": ["content"],
    },
}

RECALL_SCHEMA = {
    "name": "engram_recall",
    "description": (
        "Search Engram's persistent memory by semantic similarity. Use when you need "
        "retrieved context the user told you before, project facts, or prior decisions. "
        "Returns ranked memories with content and relevance score."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Natural-language search query."},
            "limit": {"type": "integer", "description": "Max memories to return (default 5)."},
            "mode": {"type": "string", "enum": ["strict", "historical", "associative"], "description": "Recall mode (default associative)."},
        },
        "required": ["query"],
    },
}

FORGET_SCHEMA = {
    "name": "engram_forget",
    "description": "Delete a single Engram memory by id (soft delete).",
    "parameters": {
        "type": "object",
        "properties": {"memory_id": {"type": "string", "description": "Engram memory id to delete."}},
        "required": ["memory_id"],
    },
}

CONSOLIDATE_SCHEMA = {
    "name": "engram_consolidate",
    "description": (
        "Trigger Engram's consolidation engine now: merges related memories, promotes "
        "important ones to genome, and prunes obsolete facts. Normally runs on session "
        "end; call this manually after large changes or when memory feels stale."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}

DECAY_SCHEMA = {
    "name": "engram_decay",
    "description": (
        "Run Engram's memory-decay engine: lowers salience of stale, unused memories so "
        "the knowledge base stays healthy. dry_run reports what would change without "
        "modifying anything."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "dry_run": {"type": "boolean", "description": "If true, report only (default true)."},
            "limit": {"type": "integer", "description": "Max memories to process (default 50)."},
        },
        "required": [],
    },
}

CONTRADICTION_SCHEMA = {
    "name": "engram_contradiction",
    "description": (
        "Track and resolve conflicting memories in Engram. create links two memory ids "
        "that contradict each other; resolve closes an open contradiction with a decision."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["create", "resolve"], "description": "create or resolve."},
            "memory_id": {"type": "string", "description": "Memory id asserting the claim (create)."},
            "contradicts_memory_id": {"type": "string", "description": "Memory id it contradicts (create)."},
            "contradiction_id": {"type": "string", "description": "Open contradiction id to resolve (resolve)."},
            "resolution": {"type": "string", "description": "How the conflict was resolved (resolve)."},
        },
        "required": ["action"],
    },
}

TOOL_SCHEMAS = [
    REMEMBER_SCHEMA, RECALL_SCHEMA, FORGET_SCHEMA,
    CONSOLIDATE_SCHEMA, DECAY_SCHEMA, CONTRADICTION_SCHEMA,
]


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------

class EngramMemoryProvider(MemoryProvider):
    def __init__(self, config: dict | None = None):
        self._config = config or _load_plugin_config()
        self._client: Optional[_EngramClient] = None
        self._session_id = ""
        self._genome: List[dict] = []
        self._base_url = self._config.get("base_url", DEFAULT_BASE_URL)
        self._api_key = self._config.get("api_key", "")
        self._user_id = self._config.get("user_id", DEFAULT_USER_ID)
        self._recall_user_id = self._config.get("recall_user_id", DEFAULT_RECALL_USER_ID)
        self._project_id = self._config.get("project_id", "")
        self._recall_limit = int(self._config.get("recall_limit", DEFAULT_RECALL_LIMIT))
        self._recall_mode = self._config.get("recall_mode", DEFAULT_RECALL_MODE)
        self._genome_limit = int(self._config.get("genome_limit", DEFAULT_GENOME_LIMIT))

    # -- mandatory ABC members ---------------------------------------------

    @property
    def name(self) -> str:
        return "engram"

    def is_available(self) -> bool:
        return bool(self._base_url)

    def initialize(self, session_id: str, **kwargs) -> None:
        self._session_id = session_id
        self._client = _EngramClient(
            base_url=self._base_url, api_key=self._api_key,
            user_id=self._user_id, project_id=self._project_id,
            recall_user_id=self._recall_user_id,
        )
        self._refresh_genome()
        self._check_health()

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return TOOL_SCHEMAS

    # -- genome + recall injection ----------------------------------------

    def _refresh_genome(self) -> None:
        if not self._client:
            return
        try:
            self._genome = self._client.genome() or []
            if self._genome:
                logger.info("Engram: loaded %d genome directives", len(self._genome))
        except Exception as e:
            logger.debug("Engram genome load failed: %s", e)
            self._genome = []

    def _check_health(self) -> None:
        if not self._client:
            return
        try:
            h = self._client.health()
            vs = (h or {}).get("vector_store") or {}
            if vs.get("active") is False:
                logger.warning(
                    "Engram vector store is INACTIVE (active=%s) — recall will return "
                    "nothing until pgvector/embedding is wired up. Memory writes still work.",
                    vs.get("active"),
                )
        except Exception:
            pass

    def system_prompt_block(self) -> str:
        if not self._client:
            return ""
        return (
            "# Engram Memory & Cognition\n"
            "Active. Engram (PostgreSQL + pgvector) supplies persistent, project-aware "
            "memory. Core directives (genome) and recalled context are injected before "
            "each turn. Use engram_remember / engram_recall / engram_forget for explicit "
            "control, and engram_consolidate / engram_decay / engram_contradiction to "
            "maintain the knowledge base."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if not self._client:
            return ""
        blocks: List[str] = []

        # Genome: always-on core directives (cached, no network).
        genome = self._genome[: self._genome_limit]
        if genome:
            lines = [f"- {(m.get('content') or '').strip()}" for m in genome if (m.get("content") or "").strip()]
            if lines:
                blocks.append("## Engram core directives (genome)\n" + "\n".join(lines))

        # Phenotype: similarity recall for this turn.
        if query:
            try:
                results = self._client.recall(query, limit=self._recall_limit, mode=self._recall_mode)
                if results:
                    lines = []
                    for r in results:
                        content = (r.get("content") or "").strip()
                        if not content:
                            continue
                        score = r.get("score")
                        line = f"- {content}"
                        if isinstance(score, (int, float)):
                            line += f"  (relevance: {score:.2f})"
                        lines.append(line)
                    if lines:
                        blocks.append("## Recalled from Engram memory (phenotype)\n" + "\n".join(lines))
            except Exception as e:
                logger.debug("Engram prefetch recall failed: %s", e)

        return "\n\n".join(blocks)

    # -- write path --------------------------------------------------------

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "", messages=None) -> None:
        """Option B: hand Engram the FULL turn so its extraction LLM decides storage.

        We do NOT pre-filter or summarize. If `messages` is supplied we pass the
        entire transcript (user msg + assistant reply + any tool calls/results);
        otherwise we fall back to the (user, assistant) pair. Engram classifies
        genome vs phenotype, sector, and decay — Hermes stays the orchestrator.
        """
        if not self._client or not assistant_content:
            return
        # Reconstruct the full turn when we have the message list (preferred).
        if messages:
            parts = []
            for m in messages:
                role = (m.get("role") or "").strip()
                body = m.get("content")
                if isinstance(body, list):  # tool calls / tool results
                    for blk in body:
                        if isinstance(blk, dict):
                            if blk.get("type") == "tool_use":
                                parts.append(f"TOOL_CALL: {blk.get('name')}({json.dumps(blk.get('input', {}))[:500]})")
                            elif blk.get("type") == "tool_result":
                                parts.append(f"TOOL_RESULT: {str(blk.get('content'))[:800]}")
                            elif blk.get("text"):
                                parts.append(f"{role.upper()}: {blk['text']}")
                elif isinstance(body, str) and body.strip():
                    parts.append(f"{role.upper()}: {body}")
            full = "\n\n".join(parts)
        else:
            full_user = (user_content or "").strip()
            full_asst = assistant_content.strip()
            full = f"USER: {full_user}\n\nASSISTANT: {full_asst}"
        if not full.strip():
            return
        try:
            meta = {"source": "hermes_sync_turn", "session_id": session_id or self._session_id}
            self._client.converse(user_content or "", assistant_content,
                                  session_id=session_id or self._session_id, metadata=meta)
        except Exception as e:
            logger.debug("Engram sync_turn (converse) failed: %s", e)

    def on_memory_write(self, action: str, target: str, content: str, metadata=None) -> None:
        # Explicit engram_remember tool writes go through /memories (user-directed).
        if action == "add" and self._client and content:
            try:
                self._client.remember(
                    content,
                    metadata={"source": "hermes_memory_tool", "target": target},
                )
            except Exception as e:
                logger.debug("Engram on_memory_write failed: %s", e)

    # -- session end: consolidate + refresh genome -------------------------

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        if not self._client:
            return
        try:
            self._client.consolidate()
            logger.info("Engram: session-end consolidation triggered")
        except Exception as e:
            logger.debug("Engram on_session_end consolidate failed: %s", e)
        # Refresh genome so newly-promoted directives show up next session.
        self._refresh_genome()

    # -- tool dispatch -----------------------------------------------------

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        if not self._client:
            return json.dumps({"error": "engram provider not initialized"})
        handlers = {
            "engram_remember": self._tool_remember,
            "engram_recall": self._tool_recall,
            "engram_forget": self._tool_forget,
            "engram_consolidate": self._tool_consolidate,
            "engram_decay": self._tool_decay,
            "engram_contradiction": self._tool_contradiction,
        }
        fn = handlers.get(tool_name)
        if fn is None:
            return json.dumps({"error": f"unknown tool: {tool_name}"})
        try:
            return fn(args)
        except Exception as e:
            logger.debug("Engram tool %s error: %s", tool_name, e)
            return json.dumps({"error": str(e)})

    def _tool_remember(self, args: dict) -> str:
        content = (args.get("content") or "").strip()
        if not content:
            return json.dumps({"error": "content required"})
        meta = {"source": "engram_remember"}
        if args.get("note"):
            meta["note"] = args["note"]
        payload: dict = {"content": content, "user_id": self._user_id, "metadata": meta}
        if self._project_id:
            payload["project_id"] = self._project_id
        if args.get("genome"):
            payload["is_genome"] = True  # promote to genome on write
        res = self._safe_post("/memories", payload)
        if not res:
            return json.dumps({"error": "engram unavailable or rejected request"})
        if args.get("genome"):
            self._refresh_genome()  # pick up the new directive immediately
        return json.dumps({
            "status": "stored",
            "id": res.get("id") or res.get("memory_id"),
            "memory": res.get("memory"),
        })

    def _tool_recall(self, args: dict) -> str:
        query = (args.get("query") or "").strip()
        if not query:
            return json.dumps({"error": "query required"})
        limit = int(args.get("limit", self._recall_limit))
        mode = args.get("mode", self._recall_mode)
        results = self._client.recall(query, limit=limit, mode=mode)
        return json.dumps({"count": len(results), "results": results})

    def _tool_forget(self, args: dict) -> str:
        memory_id = (args.get("memory_id") or "").strip()
        if not memory_id:
            return json.dumps({"error": "memory_id required"})
        ok = self._client.delete(memory_id)
        return json.dumps({"deleted": ok, "id": memory_id})

    def _tool_consolidate(self, args: dict) -> str:
        res = self._client.consolidate()
        if res is None:
            return json.dumps({"error": "engram unavailable"})
        self._refresh_genome()
        return json.dumps({"status": "consolidation_triggered", "response": res})

    def _tool_decay(self, args: dict) -> str:
        dry_run = bool(args.get("dry_run", True))
        limit = args.get("limit")
        res = self._client.decay(dry_run=dry_run, limit=int(limit) if limit else None)
        if res is None:
            return json.dumps({"error": "engram unavailable"})
        decay = (res or {}).get("decay", {})
        return json.dumps({
            "dry_run": dry_run,
            "scanned": decay.get("scanned"),
            "changed": decay.get("changed"),
            "memories": decay.get("memories", []),
        })

    def _tool_contradiction(self, args: dict) -> str:
        action = args.get("action")
        if action == "create":
            mid = (args.get("memory_id") or "").strip()
            cid = (args.get("contradicts_memory_id") or "").strip()
            if not mid or not cid:
                return json.dumps({"error": "memory_id and contradicts_memory_id required"})
            conf = args.get("confidence")
            res = self._client.contradiction_create(
                mid, cid, confidence=float(conf) if isinstance(conf, (int, float)) else None)
            if res is None:
                return json.dumps({"error": "engram unavailable"})
            return json.dumps({"status": "contradiction_created", "response": res})
        if action == "resolve":
            cid = (args.get("contradiction_id") or "").strip()
            resolution = (args.get("resolution") or "").strip()
            if not cid or not resolution:
                return json.dumps({"error": "contradiction_id and resolution required"})
            res = self._client.contradiction_resolve(cid, resolution)
            if res is None:
                return json.dumps({"error": "engram unavailable"})
            return json.dumps({"status": "contradiction_resolved", "response": res})
        return json.dumps({"error": "action must be 'create' or 'resolve'"})

    def _safe_post(self, path: str, payload: dict) -> Optional[dict]:
        try:
            return self._client._post(path, payload)  # noqa: SLF001 (internal helper)
        except Exception as e:
            logger.debug("Engram post %s failed: %s", path, e)
            return None

    # -- config schema (for `hermes memory setup`) -------------------------

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {"key": "base_url", "description": "Engram proxy base URL",
             "default": DEFAULT_BASE_URL, "env_var": "EG_BASE_URL"},
            {"key": "api_key", "description": "Engram API key (only if EG_REQUIRE_API_KEY is set)",
             "secret": True, "env_var": "EG_API_KEY"},
            {"key": "user_id", "description": "Scope writes to this user id",
             "default": DEFAULT_USER_ID, "env_var": "EG_USER_ID"},
            {"key": "recall_user_id", "description": "Scope recall queries (empty = no scope, sees system-stored extraction memories)",
             "default": DEFAULT_RECALL_USER_ID, "env_var": "EG_RECALL_USER_ID"},
            {"key": "project_id", "description": "Scope memories to a project (optional)", "default": ""},
            {"key": "recall_limit", "description": "Max phenotype memories injected per turn",
             "default": str(DEFAULT_RECALL_LIMIT)},
            {"key": "recall_mode", "description": "Recall mode",
             "choices": ["strict", "historical", "associative"], "default": DEFAULT_RECALL_MODE},
            {"key": "genome_limit", "description": "Max genome directives injected per turn",
             "default": str(DEFAULT_GENOME_LIMIT)},
        ]

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        from pathlib import Path
        config_path = Path(hermes_home) / "config.yaml"
        try:
            import yaml
            existing = {}
            if config_path.exists():
                with open(config_path, encoding="utf-8-sig") as f:
                    existing = yaml.safe_load(f) or {}
            existing.setdefault("plugins", {})
            existing["plugins"]["engram"] = values
            with open(config_path, "w", encoding="utf-8") as f:
                yaml.dump(existing, f, default_flow_style=False)
        except Exception as e:
            logger.debug("Engram save_config failed: %s", e)

    def shutdown(self) -> None:
        self._client = None
        self._genome = []


# ---------------------------------------------------------------------------
# Plugin entry point
# ---------------------------------------------------------------------------

def register(ctx) -> None:
    config = _load_plugin_config()
    provider = EngramMemoryProvider(config=config)
    ctx.register_memory_provider(provider)
