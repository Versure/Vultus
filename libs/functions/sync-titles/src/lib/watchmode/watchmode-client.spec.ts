import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWatchmodeClient,
  type WatchmodeClientConfig,
} from './watchmode-client';
import { WatchmodeError } from './watchmode-error';

const API_KEY = 'test-watchmode-key';

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

type FetchStep = MockResponseInit | { reject: true };

function sequenceFetch(steps: FetchStep[]) {
  const fn = vi.fn((): Promise<Response> => {
    const step = steps.shift();
    if (!step) throw new Error('fetch called more times than queued');
    if ('reject' in step) return Promise.reject(new Error('network down'));
    return Promise.resolve(mockResponse(step));
  });
  return fn as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function client(
  fetchMock: typeof fetch,
  overrides: Partial<WatchmodeClientConfig> = {},
) {
  return createWatchmodeClient({
    apiKey: API_KEY,
    fetch: fetchMock,
    minRequestIntervalMs: 0,
    backoffBaseMs: 0,
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('resolveTitleId', () => {
  it('returns the first title_results id for a movie (tmdb_movie_id search)', async () => {
    const fetchMock = sequenceFetch([
      {
        status: 200,
        body: { title_results: [{ id: 3427892, name: 'Dune' }] },
      },
    ]);
    const result = await client(fetchMock).resolveTitleId(438631, 'movie');
    expect(result).toBe(3427892);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/search/?search_field=tmdb_movie_id');
    expect(url).toContain('search_value=438631');
  });

  it('uses tmdb_tv_id for tv titles', async () => {
    const fetchMock = sequenceFetch([
      { status: 200, body: { title_results: [{ id: 12345 }] } },
    ]);
    await client(fetchMock).resolveTitleId(1396, 'tv');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('search_field=tmdb_tv_id');
    expect(url).toContain('search_value=1396');
  });

  it('returns null on empty title_results (no match)', async () => {
    const fetchMock = sequenceFetch([
      { status: 200, body: { title_results: [] } },
    ]);
    expect(await client(fetchMock).resolveTitleId(999, 'movie')).toBeNull();
  });

  it('returns null on 404', async () => {
    const fetchMock = sequenceFetch([{ status: 404 }]);
    expect(await client(fetchMock).resolveTitleId(999, 'movie')).toBeNull();
  });
});

describe('getTitleSources', () => {
  it('maps DTO rows to WatchmodeSource[], filtering non-REGIONS and unknown types', async () => {
    const fetchMock = sequenceFetch([
      {
        status: 200,
        body: [
          { source_id: 203, type: 'sub', region: 'NL', name: 'Netflix' },
          { source_id: 26, type: 'rent', region: 'DE', name: 'Prime Video' },
          { source_id: 8, type: 'sub', region: 'JP' }, // non-REGIONS → dropped
          { source_id: 5, type: 'tv', region: 'NL' }, // unknown type → dropped
        ],
      },
    ]);
    const result = await client(fetchMock).getTitleSources(42, ['NL', 'DE']);
    expect(result).toEqual([
      { sourceId: 203, type: 'sub', region: 'NL' },
      { sourceId: 26, type: 'rent', region: 'DE' },
    ]);
  });

  it('sends the comma-separated regions param', async () => {
    const fetchMock = sequenceFetch([{ status: 200, body: [] }]);
    await client(fetchMock).getTitleSources(42, ['NL', 'DE', 'GB']);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/title/42/sources/?regions=NL,DE,GB');
  });

  it('returns [] when Watchmode returns an empty array', async () => {
    const fetchMock = sequenceFetch([{ status: 200, body: [] }]);
    expect(await client(fetchMock).getTitleSources(42, ['NL'])).toEqual([]);
  });

  it('returns null on 404', async () => {
    const fetchMock = sequenceFetch([{ status: 404 }]);
    expect(await client(fetchMock).getTitleSources(999, ['NL'])).toBeNull();
  });
});

describe('error handling + apiKey safety', () => {
  it('throws WatchmodeError with the failing status', async () => {
    const fetchMock = sequenceFetch([{ status: 401 }]);
    await expect(
      client(fetchMock).resolveTitleId(1, 'movie'),
    ).rejects.toMatchObject({ name: 'WatchmodeError', status: 401 });
    await expect(
      client(sequenceFetch([{ status: 503 }])).getTitleSources(1, ['NL']),
    ).rejects.toBeInstanceOf(WatchmodeError);
  });

  it('throws WatchmodeError with status 0 on transport failure', async () => {
    const fetchMock = sequenceFetch([{ reject: true }]);
    await expect(
      client(fetchMock).resolveTitleId(1, 'movie'),
    ).rejects.toMatchObject({ name: 'WatchmodeError', status: 0 });
  });

  it('sends apiKey on the fetched URL but NEVER in the thrown error endpoint/message', async () => {
    const fetchMock = sequenceFetch([{ status: 401 }]);
    try {
      await client(fetchMock).getTitleSources(42, ['NL']);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WatchmodeError);
      const e = err as WatchmodeError;
      // The credential must not leak into the diagnostic surface.
      expect(e.endpoint).not.toContain(API_KEY);
      expect(e.message).not.toContain(API_KEY);
      // The regions query IS part of the path (only the apiKey is stripped).
      expect(e.endpoint).toBe('/title/42/sources/?regions=NL');
    }
    // But it WAS appended to the real fetch URL.
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(`apiKey=${API_KEY}`);
  });

  it('does not log the apiKey', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const fetchMock = sequenceFetch([{ status: 401 }]);
    await expect(
      client(fetchMock).resolveTitleId(1, 'movie'),
    ).rejects.toBeInstanceOf(WatchmodeError);
    for (const spy of [logSpy, errSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(API_KEY);
      }
    }
  });
});

describe('retry', () => {
  it('retries a 429 honoring Retry-After then resolves', async () => {
    const fetchMock = sequenceFetch([
      { status: 429, retryAfter: '0' },
      { status: 200, body: { title_results: [{ id: 7 }] } },
    ]);
    const result = await client(fetchMock).resolveTitleId(1, 'movie');
    expect(result).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws WatchmodeError status 429 when retries are exhausted', async () => {
    const fetchMock = sequenceFetch([
      { status: 429, retryAfter: '0' },
      { status: 429, retryAfter: '0' },
    ]);
    await expect(
      client(fetchMock, { maxRetries: 1 }).resolveTitleId(1, 'movie'),
    ).rejects.toMatchObject({ name: 'WatchmodeError', status: 429 });
  });
});
