# Engram Hermes Plugin

A native **memory-provider plugin** that wires [FTR10 Engram](../../readme.md) into
[Hermes Agent](https://github.com/NousResearch/Hermes) — no MCP server, stdlib `urllib` only.

## What it does

Engram becomes Hermes's **memory + cognition sidecar**. Hermes stays the orchestrator
(it talks to its own LLM, e.g. OpenRouter); Engram is never the chat proxy.

- **Before each turn** → `prefetch()` injects cached **genome** directives + **phenotype**
  recall (`POST /recall`) into the user message as a `<memory-context>` block.
- **After each turn** → `sync_turn()` hands the **full turn** (user msg + assistant reply +
  tool I/O) to `POST /ingest/conversation`, so Engram's own extraction LLM decides what to
  store (genome vs phenotype, sector, decay). Hermes never pre-filters — Engram is the
  memory authority.
- **Maintenance tools** → `engram_consolidate`, `engram_decay`, `engram_contradiction`,
  plus explicit `engram_remember` / `engram_recall` / `engram_forget`. Consolidation also
  runs automatically on session end.

Engram's chat proxy, compaction engine, and auto-search are **not** used in this mode
(Hermes already does orchestration + compression + web search).

## Files

- `plugin.yaml` — plugin metadata (name, version, description).
- `__init__.py` — the `EngramMemoryProvider` implementing Hermes's `MemoryProvider` ABC.

## Requirements

- A running Engram instance (default `http://localhost:8098`). See the root
  [readme.md](../../readme.md) for setup.
- Hermes Agent with the memory-provider plugin loader (the `plugins/memory/*` mechanism).

## Install

1. **Copy this directory** into Hermes's plugin folder:

   ```bash
   mkdir -p ~/.hermes/plugins/engram
   cp plugin.yaml __init__.py ~/.hermes/plugins/engram/
   ```

2. **Point Hermes at the Engram backend.** Use the CLI (direct edits to
   `~/.hermes/config.yaml` are blocked by a security guard):

   ```bash
   hermes config set memory.provider engram
   hermes config set plugins.engram.base_url "http://localhost:8098"
   ```

   Optional tuning (all under `plugins.engram` or the env var in parentheses):

   | Key | Env var | Default | Meaning |
   |-----|---------|---------|---------|
   | `base_url` | `EG_BASE_URL` | `http://localhost:8098` | Engram API base URL |
   | `api_key` | `EG_API_KEY` | _(empty)_ | Engram API key (only if `EG_REQUIRE_API_KEY` is set) |
   | `user_id` | `EG_USER_ID` | `hermes` | Scope written memories to this user |
   | `recall_user_id` | `EG_RECALL_USER_ID` | _(empty)_ | Scope recall queries; empty = see all (incl. system-stored extraction) |
   | `project_id` | — | _(empty)_ | Scope to a project |
   | `recall_limit` | — | `5` | Max phenotype memories injected per turn |
   | `recall_mode` | — | `associative` | `strict` \| `historical` \| `associative` |
   | `genome_limit` | — | `15` | Max genome directives injected per turn |

3. **Restart Hermes** (or start a new session). The plugin loads on boot.

## Verify it's live

- The Web GUI **Activity** tab (port 8099) shows `OUT recall` firing on every Hermes
  prefetch and `IN` writes on every turn — concrete proof the integration is working.
- Or hit Engram directly:

  ```bash
  curl -s -X POST http://localhost:8098/recall -H 'Content-Type: application/json' \
    -d '{"query":"something you know is stored","mode":"associative","limit":5}'
  ```

## Notes

- Genome auto-promotion from chat is **disabled** in the extraction path
  (`/ingest/conversation` passes `allowGenome: false`). Genome is reserved for explicit
  `engram_remember(genome: true)` calls, which prevents chat narration from being promoted
  to immutable, always-injected directives.
- Only one external memory provider may be active at a time; select it via
  `memory.provider` in `config.yaml`.
