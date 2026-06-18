/*
 - filename: packages/engram-js/src/utils/retry.ts
 - what is the file used for: Retry with exponential backoff + simple circuit breaker for upstream LLM calls
*/

/**
 * Per-host circuit breaker state.
 * Opens after N consecutive failures, resets after cooldown period.
 */
const circuitState = new Map<string, { failures: number; openedAt: number }>();

const CIRCUIT_BREAKER_THRESHOLD = 3;       // consecutive failures to open
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000; // 30s before half-open retry

function isCircuitOpen(host: string): boolean {
  const state = circuitState.get(host);
  if (!state) return false;
  if (state.failures < CIRCUIT_BREAKER_THRESHOLD) return false;
  if (Date.now() - state.openedAt > CIRCUIT_BREAKER_COOLDOWN_MS) {
    circuitState.delete(host); // half-open: allow next request through
    return false;
  }
  return true;
}

function recordFailure(host: string) {
  const state = circuitState.get(host) || { failures: 0, openedAt: 0 };
  state.failures++;
  if (state.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    state.openedAt = Date.now();
  }
  circuitState.set(host, state);
}

function recordSuccess(host: string) {
  circuitState.delete(host);
}

/**
 * Extract host from a URL for circuit breaker keying.
 */
function extractHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ── Retry helper ─────────────────────────────────────────────────────

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** HTTP status codes that should be retried (e.g., 408, 429, 500-503) */
  retryOnStatus?: (status: number) => boolean;
  /** Circuit breaker host key — if set, circuit breaker is used */
  circuitBreakerHost?: string;
}

const DEFAULT_RETRYABLE_STATUS = (status: number) =>
  status === 408 || status === 429 || status === 502 || status === 503 || status === 504;

/**
 * fetch() with exponential backoff + jitter and optional circuit breaker.
 *
 * Example:
 *   const response = await retryFetch("http://ollama:11434/api/generate", { method: "POST", ... });
 */
export async function retryFetch(
  url: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const {
    retries = 2,
    baseDelayMs = 1000,
    maxDelayMs = 10_000,
    retryOnStatus = DEFAULT_RETRYABLE_STATUS,
    circuitBreakerHost,
  } = options;

  // Circuit breaker check
  const host = circuitBreakerHost || extractHost(url);
  if (isCircuitOpen(host)) {
    throw new Error(`Circuit breaker open for ${host} — skipping request`);
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, init);

      if (response.ok) {
        recordSuccess(host);
        return response;
      }

      // Non-OK response
      if (attempt < retries && retryOnStatus(response.status)) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt) + Math.random() * 500, maxDelayMs);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      recordFailure(host);
      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < retries) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt) + Math.random() * 500, maxDelayMs);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
  }

  recordFailure(host);
  throw lastError || new Error(`fetch failed after ${retries + 1} attempts`);
}
