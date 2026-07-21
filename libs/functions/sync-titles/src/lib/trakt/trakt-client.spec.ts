import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTraktClient, type TraktClientConfig } from './trakt-client';
import { TraktError } from './trakt-error';

const CLIENT_ID = 'test-client-id';

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
  overrides: Partial<TraktClientConfig> = {},
) {
  return createTraktClient({
    clientId: CLIENT_ID,
    fetch: fetchMock,
    minRequestIntervalMs: 0,
    backoffBaseMs: 0, // disable the 429 backoff floor so retry tests stay fast
    ...overrides,
  });
}

function calendarPayload() {
  return [
    {
      first_aired: '2026-06-20T01:00:00.000Z',
      episode: { season: 2, number: 5, title: 'Ep 5' },
      show: {
        title: 'Severance',
        year: 2022,
        ids: { trakt: 152334, slug: 'severance', tmdb: 95396 },
      },
    },
    {
      first_aired: '2026-06-21T02:00:00.000Z',
      episode: { season: 1, number: 8 },
      show: { title: 'Show B', ids: { trakt: 2, tmdb: null } },
    },
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('getCalendar happy path', () => {
  it('maps each entry show identity + nested Episode', async () => {
    const fetchMock = sequenceFetch([{ status: 200, body: calendarPayload() }]);
    const result = await client(fetchMock).getCalendar('2026-06-20', 7);
    expect(result).toEqual([
      {
        traktId: 152334,
        tmdbId: 95396,
        showTitle: 'Severance',
        episode: {
          season: 2,
          episode: 5,
          title: null,
          airDate: '2026-06-20T01:00:00.000Z',
        },
      },
      {
        traktId: 2,
        tmdbId: null,
        showTitle: 'Show B',
        episode: {
          season: 1,
          episode: 8,
          title: null,
          airDate: '2026-06-21T02:00:00.000Z',
        },
      },
    ]);
  });

  it('passes first_aired to airDate unchanged (no synthesis/truncation)', async () => {
    const fetchMock = sequenceFetch([
      {
        status: 200,
        body: [
          {
            first_aired: '2026-12-31T23:30:45.123Z',
            episode: { season: 1, number: 1 },
            show: { title: 'X', ids: { trakt: 1, tmdb: 1 } },
          },
        ],
      },
    ]);
    const [entry] = await client(fetchMock).getCalendar('2026-12-31', 1);
    expect(entry.episode.airDate).toBe('2026-12-31T23:30:45.123Z');
    expect(entry.episode.airDate).not.toContain('T00:00:00.000Z');
  });

  it('skips entries missing first_aired/season/number, keeps the rest', async () => {
    const fetchMock = sequenceFetch([
      {
        status: 200,
        body: [
          {
            first_aired: null,
            episode: { season: 1, number: 1 },
            show: { title: 'NoDate', ids: { trakt: 1 } },
          },
          {
            first_aired: '',
            episode: { season: 1, number: 1 },
            show: { title: 'EmptyDate', ids: { trakt: 2 } },
          },
          {
            first_aired: '2026-06-20T00:00:00.000Z',
            episode: { number: 1 },
            show: { title: 'NoSeason', ids: { trakt: 3 } },
          },
          {
            first_aired: '2026-06-20T00:00:00.000Z',
            episode: { season: 1 },
            show: { title: 'NoNumber', ids: { trakt: 4 } },
          },
          {
            first_aired: '2026-06-20T00:00:00.000Z',
            episode: { season: 1, number: 1 },
            show: { title: 'Good', ids: { trakt: 5, tmdb: 50 } },
          },
        ],
      },
    ]);
    const result = await client(fetchMock).getCalendar('2026-06-20', 7);
    expect(result).toHaveLength(1);
    expect(result[0].traktId).toBe(5);
  });

  it('keeps an entry whose tmdb id is null (tmdbId: null, not dropped)', async () => {
    const fetchMock = sequenceFetch([
      {
        status: 200,
        body: [
          {
            first_aired: '2026-06-20T00:00:00.000Z',
            episode: { season: 1, number: 1 },
            show: { title: 'Y', ids: { trakt: 9 } },
          },
        ],
      },
    ]);
    const [entry] = await client(fetchMock).getCalendar('2026-06-20', 7);
    expect(entry.tmdbId).toBeNull();
  });

  it('returns [] for an empty calendar (200 [])', async () => {
    const fetchMock = sequenceFetch([{ status: 200, body: [] }]);
    expect(await client(fetchMock).getCalendar('2026-06-20', 7)).toEqual([]);
  });

  it('returns [] on 404', async () => {
    const fetchMock = sequenceFetch([{ status: 404 }]);
    expect(await client(fetchMock).getCalendar('2026-06-20', 7)).toEqual([]);
  });
});

describe('getCalendar input validation', () => {
  it.each(['2026/06/20', 'June 20', '', '2026-6-2', '20260620'])(
    'throws a plain Error (NOT TraktError) and never fetches for malformed startDate %p',
    async (bad) => {
      const fetchMock = sequenceFetch([]);
      await expect(
        client(fetchMock).getCalendar(bad, 7),
      ).rejects.toBeInstanceOf(Error);
      await expect(
        client(fetchMock).getCalendar(bad, 7),
      ).rejects.not.toBeInstanceOf(TraktError);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    [0, 1],
    [50, 33],
    [7.9, 7],
    [-3, 1],
    [33.9, 33],
  ])(
    'clamps/truncates days %p to %p in the request path',
    async (input, expected) => {
      const fetchMock = sequenceFetch([{ status: 200, body: [] }]);
      await client(fetchMock).getCalendar('2026-06-20', input);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/calendars/all/shows/2026-06-20/${expected}`),
        expect.anything(),
      );
    },
  );
});

describe('getShowTraktId', () => {
  it('returns the first type === show result trakt id', async () => {
    const fetchMock = sequenceFetch([
      {
        status: 200,
        body: [
          { type: 'show', score: 99, show: { title: 'A', ids: { trakt: 42 } } },
          { type: 'show', score: 1, show: { title: 'B', ids: { trakt: 99 } } },
        ],
      },
    ]);
    expect(await client(fetchMock).getShowTraktId(603)).toBe(42);
  });

  it('returns null for an empty result (200 [])', async () => {
    const fetchMock = sequenceFetch([{ status: 200, body: [] }]);
    expect(await client(fetchMock).getShowTraktId(603)).toBeNull();
  });

  it('returns null when no entry is type === show', async () => {
    const fetchMock = sequenceFetch([
      {
        status: 200,
        body: [{ type: 'movie', show: { title: 'M', ids: { trakt: 7 } } }],
      },
    ]);
    expect(await client(fetchMock).getShowTraktId(603)).toBeNull();
  });

  it('returns null on 404', async () => {
    const fetchMock = sequenceFetch([{ status: 404 }]);
    expect(await client(fetchMock).getShowTraktId(999)).toBeNull();
  });
});

describe('error handling', () => {
  it.each([401, 403, 500, 503])(
    'throws TraktError with status %i',
    async (status) => {
      const fetchMock = sequenceFetch([{ status }]);
      await expect(client(fetchMock).getShowTraktId(1)).rejects.toMatchObject({
        name: 'TraktError',
        status,
      });
      await expect(
        client(sequenceFetch([{ status }])).getShowTraktId(1),
      ).rejects.toBeInstanceOf(TraktError);
    },
  );

  it('throws TraktError with status 0 on transport failure', async () => {
    const fetchMock = sequenceFetch([{ reject: true }]);
    await expect(client(fetchMock).getShowTraktId(1)).rejects.toMatchObject({
      name: 'TraktError',
      status: 0,
    });
  });
});

describe('retry / throttle', () => {
  it('retries a 429 honoring Retry-After then resolves', async () => {
    const fetchMock = sequenceFetch([
      { status: 429, retryAfter: '0' },
      {
        status: 200,
        body: [{ type: 'show', show: { title: 'R', ids: { trakt: 5 } } }],
      },
    ]);
    expect(await client(fetchMock).getShowTraktId(1)).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws TraktError status 429 when retries are exhausted', async () => {
    const fetchMock = sequenceFetch([
      { status: 429, retryAfter: '0' },
      { status: 429, retryAfter: '0' },
    ]);
    await expect(
      client(fetchMock, { maxRetries: 1 }).getShowTraktId(1),
    ).rejects.toMatchObject({ name: 'TraktError', status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('headers + client id safety', () => {
  it('sends trakt-api-key, trakt-api-version, Content-Type and NO Authorization', async () => {
    const fetchMock = sequenceFetch([
      { status: 200, body: [] },
      { status: 200, body: [] },
    ]);
    const c = client(fetchMock);
    await c.getShowTraktId(1);
    await c.getCalendar('2026-06-20', 7);
    for (const call of (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls) {
      const init = call[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['trakt-api-key']).toBe(CLIENT_ID);
      expect(headers['trakt-api-version']).toBe('2');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Authorization']).toBeUndefined();
    }
  });

  it('never leaks the client id in the request url/path', async () => {
    const fetchMock = sequenceFetch([{ status: 200, body: [] }]);
    await client(fetchMock).getShowTraktId(603);
    const url = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(url).toContain('/search/tmdb/603?type=show');
    expect(url).not.toContain(CLIENT_ID);
  });

  it('never leaks the client id in TraktError message/endpoint', async () => {
    const cases: FetchStep[] = [
      { status: 401 },
      { status: 500 },
      { reject: true },
    ];
    for (const step of cases) {
      const fetchMock = sequenceFetch([step]);
      try {
        await client(fetchMock).getShowTraktId(42);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(TraktError);
        const e = err as TraktError;
        expect(e.message).not.toContain(CLIENT_ID);
        expect(e.endpoint).not.toContain(CLIENT_ID);
        expect(e.endpoint).toBe('/search/tmdb/42?type=show');
      }
    }
  });

  it('does not log the client id', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const fetchMock = sequenceFetch([{ status: 401 }]);
    await expect(client(fetchMock).getShowTraktId(1)).rejects.toBeInstanceOf(
      TraktError,
    );
    for (const spy of [logSpy, errSpy, warnSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(CLIENT_ID);
      }
    }
  });
});
