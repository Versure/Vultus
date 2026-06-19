// Internal fetch/retry/throttle core for the TMDB client. Not exported from the
// barrel. Right-sized for a personal daily sync: serialized requests (effective
// concurrency ~1), 429 retried honoring `Retry-After`, no 5xx retry.
//
// Deferral note (spec 0006, YAGNI): this generic transport (min-interval
// throttle, 429/Retry-After retry, 404 sentinel, status -> TmdbError mapping) is
// intentionally slice-internal and TMDB-auth-specific for now. When the Trakt
// calendar client lands in this same slice it can reuse this transport by making
// the Authorization header injectable, rather than duplicating it. It stays
// in-slice (not hoisted to shared/) per the vertical-slice 3+-consumers rule.

import { TmdbError } from './tmdb-error';

// Distinct sentinel so callers can turn a 404 into `null` without a magic value
// collision with a real parsed body.
export const NOT_FOUND = Symbol('tmdb-not-found');

export interface HttpCoreConfig {
  readAccessToken: string;
  fetch: typeof fetch;
  baseUrl: string;
  maxRetries: number;
  minRequestIntervalMs: number;
}

// Cap a Retry-After-derived wait so a hostile/huge header can't stall the sync.
const MAX_RETRY_AFTER_MS = 60_000;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(header: string | null): number {
  if (!header) return 0;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

export function createHttpCore(config: HttpCoreConfig) {
  const {
    readAccessToken,
    fetch: fetchImpl,
    baseUrl,
    maxRetries,
    minRequestIntervalMs,
  } = config;

  // Serialize all requests onto a single tail-chained promise, and enforce a
  // minimum interval between the start of consecutive requests.
  let chain: Promise<unknown> = Promise.resolve();
  let lastStart = 0;

  async function throttle(): Promise<void> {
    const now = Date.now();
    const wait = lastStart + minRequestIntervalMs - now;
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
  }

  // `path` is a TMDB endpoint path beginning with '/', possibly with a query
  // string already appended (the query never contains the token).
  async function request<T>(path: string): Promise<T | typeof NOT_FOUND> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      // The token lives only in this header value — never in url/path/logs/errors.
      Authorization: `Bearer ${readAccessToken}`,
      Accept: 'application/json',
    };

    let attempt = 0;
    // Loop covers the initial try plus up to `maxRetries` 429 retries.
    for (;;) {
      await throttle();

      let response: Response;
      try {
        response = await fetchImpl(url, { method: 'GET', headers });
      } catch {
        // Transport / network failure — fetch rejected. Do not surface the
        // underlying cause (could in principle reference config); status 0.
        throw new TmdbError(`TMDB request failed (transport error)`, 0, path);
      }

      const status = response.status;

      if (status === 404) return NOT_FOUND;

      if (status === 429) {
        if (attempt < maxRetries) {
          attempt += 1;
          const waitMs = parseRetryAfterMs(response.headers.get('Retry-After'));
          await sleep(waitMs);
          continue;
        }
        throw new TmdbError(`TMDB rate limit exceeded (429)`, 429, path);
      }

      if (status >= 200 && status < 300) {
        return (await response.json()) as T;
      }

      // 401, any 5xx, or any other non-2xx/404/429 status → throw.
      throw new TmdbError(
        `TMDB request failed with status ${status}`,
        status,
        path,
      );
    }
  }

  // Public entry: queue the request behind any in-flight one so concurrency is
  // effectively 1 even when callers fire methods in parallel.
  function enqueue<T>(path: string): Promise<T | typeof NOT_FOUND> {
    const result = chain.then(() => request<T>(path));
    // Keep the chain alive regardless of individual success/failure.
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return { request: enqueue };
}
