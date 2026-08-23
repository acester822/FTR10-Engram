/*
 - filename: packages/engram-js/tests/setup.ts
 - what is the file used for: vitest global setup. Loads the live app_settings
   into the in-memory settings cache (exactly as the server does at startup) so
   that getSetting()-based model resolution (generative/embedding/judge) behaves
   the same in tests as in production. Safe no-op if the DB is unreachable.
*/

import { loadSettings } from "../src/services/settingsService";

// Best-effort: if there's no DB (e.g. unit-only runs), this just leaves the
// cache empty and getSetting() falls back to env — which is the correct
// behavior for tests that don't need a live store.
await loadSettings().catch(() => {});
