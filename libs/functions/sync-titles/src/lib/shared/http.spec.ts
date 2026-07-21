import { describe, expect, it, vi } from 'vitest';
import { createHttpCore, type HttpCoreConfig } from './http';

// Minimal Response-like object the http core relies on: status, headers.get,
// and json(). Mirrors the client specs' fake.
interface MockResponseInit {
  status: number;
  body?: unknown;
  retryAfter?: string;
}

function mockResponse({
  status,
  body,
  retryAfter,
}: MockResponseInit): Response {
  return {
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'retry-after' && retryAfter !== undefined
          ? retryAfter
          : null,
    },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function sequenceFetch(steps: MockResponseInit[]) {
  const fn = vi.fn((): Promise<Response> => {
    const step = steps.shift();
    if (!step) throw new Error('fetch called more times than queued');
    return Promise.resolve(mockResponse(step));
  });
  return fn as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

// A test error factory that carries the status so exhaustion assertions can read
// it (mirrors TmdbError/TraktError without importing either).
function errorFactory(
  message: string,
  status: number,
  endpoint: string,
): Error {
  return Object.assign(new Error(message), { status, endpoint });
}

function core(overrides: Partial<HttpCoreConfig>) {
  return createHttpCore({
    headers: {},
    fetch: sequenceFetch([]),
    baseUrl: 'https://example.test',
    maxRetries: 5,
    minRequestIntervalMs: 0, // no throttle sleeps — isolate the 429 backoff
    errorFactory,
    ...overrides,
  });
}

describe('createHttpCore — 429 backoff', () => {
  it('waits the exponential-backoff floor (growing) when Retry-After is absent, then succeeds', async () => {
    const sleeps: number[] = [];
    const sleep = vi.fn((ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    });
    const fetchMock = sequenceFetch([
      { status: 429 }, // no Retry-After
      { status: 429 }, // no Retry-After
      { status: 200, body: { ok: true } },
    ]);

    const http = core({
      fetch: fetchMock,
      backoffBaseMs: 100,
      sleep,
    });

    const result = await http.request<{ ok: boolean }>('/thing');

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    // attempt 1 floor: base*2^1 = 200 (+ jitter [0,100)); attempt 2: 400 (+jitter).
    expect(sleeps[0]).toBeGreaterThanOrEqual(200);
    expect(sleeps[0]).toBeLessThan(300);
    expect(sleeps[1]).toBeGreaterThanOrEqual(400);
    expect(sleeps[1]).toBeLessThan(500);
    // The wait grows across attempts (the whole point of the floor).
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]);
  });

  it('still honors Retry-After when present (waits at least the header value)', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const fetchMock = sequenceFetch([
      { status: 429, retryAfter: '5' }, // 5000ms — dominates the ~200ms floor
      { status: 200, body: { ok: true } },
    ]);

    const http = core({
      fetch: fetchMock,
      backoffBaseMs: 100,
      sleep,
    });

    const result = await http.request<{ ok: boolean }>('/thing');

    expect(result).toEqual({ ok: true });
    const waited = sleep.mock.calls[0][0] as number;
    expect(waited).toBeGreaterThanOrEqual(5000);
    expect(waited).toBe(5000);
  });

  it('retry budget is 5 (initial + 5 retries = 6 attempts) before throwing 429', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const fetchMock = sequenceFetch(
      Array.from({ length: 6 }, () => ({ status: 429 as const })),
    );

    const http = core({
      fetch: fetchMock,
      maxRetries: 5,
      backoffBaseMs: 100,
      sleep,
    });

    await expect(http.request('/thing')).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it('caps the backoff floor at MAX_RETRY_AFTER_MS (60s)', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    // base 40_000 → attempt 1 floor 80_000 (+jitter), capped to 60_000.
    const fetchMock = sequenceFetch([
      { status: 429 },
      { status: 200, body: { ok: true } },
    ]);

    const http = core({
      fetch: fetchMock,
      backoffBaseMs: 40_000,
      sleep,
    });

    await http.request('/thing');
    expect(sleep.mock.calls[0][0]).toBe(60_000);
  });
});
