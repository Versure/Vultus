// Internal fetch/retry/throttle core shared in-slice by the TMDB client and the
// Trakt calendar client. Not exported from the barrel. Right-sized for a
// personal daily sync: serialized requests (effective concurrency ~1), 429
// retried honoring `Retry-After`, no 5xx retry.
//
// The transport is auth-agnostic: the identifying/auth headers and base URL are
// supplied per client (TMDB passes `Authorization: Bearer …` + `Accept`; Trakt
// passes `trakt-api-key` + `trakt-api-version` + `Content-Type`), and the thrown
// error type is injected via `errorFactory` so the core throws `TmdbError` for
// TMDB and `TraktError` for Trakt without knowing either. The credential lives
// ONLY in the caller-supplied header values — never in the url/path/logs/errors.
// It stays in-slice (not hoisted to shared/) per the vertical-slice 3+-consumers
// rule: there is still exactly one consuming slice.

// Distinct sentinel so callers can turn a 404 into `null`/`[]` without a magic
// value collision with a real parsed body. Client-agnostic.
export const NOT_FOUND = Symbol('http-not-found');

export interface HttpCoreConfig {
  /** Identifying/auth headers applied to every request. The credential lives
   *  only here — never in the path/url. */
  headers: Record<string, string>;
  fetch: typeof fetch;
  baseUrl: string;
  maxRetries: number;
  minRequestIntervalMs: number;
  /** Builds the client-specific error (`TmdbError` / `TraktError`) so the core
   *  stays error-type-agnostic. `status` is 0 for a transport/network failure. */
  errorFactory: (message: string, status: number, endpoint: string) => Error;
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
    headers,
    fetch: fetchImpl,
    baseUrl,
    maxRetries,
    minRequestIntervalMs,
    errorFactory,
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

  // `path` is an API endpoint path beginning with '/', possibly with a query
  // string already appended (the query never contains the credential).
  async function request<T>(path: string): Promise<T | typeof NOT_FOUND> {
    const url = `${baseUrl}${path}`;

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
        throw errorFactory(`Request failed (transport error)`, 0, path);
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
        throw errorFactory(`Rate limit exceeded (429)`, 429, path);
      }

      if (status >= 200 && status < 300) {
        return (await response.json()) as T;
      }

      // 401, any 5xx, or any other non-2xx/404/429 status → throw.
      throw errorFactory(`Request failed with status ${status}`, status, path);
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
