import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTmdbClient, type TmdbClientConfig } from './tmdb-client';
import { TmdbError } from './tmdb-error';

const TOKEN = 'test-token';

// Minimal Response-like object the http core relies on: status, headers.get,
// and json().
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

// fetch mock that returns a queued sequence of responses (or rejects).
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
  overrides: Partial<TmdbClientConfig> = {},
) {
  return createTmdbClient({
    readAccessToken: TOKEN,
    fetch: fetchMock,
    minRequestIntervalMs: 0,
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('getMovie', () => {
  it('maps the happy-path movie fields and normalizes the release date', async () => {
    const fetchMock = sequenceFetch([
      {
        status: 200,
        body: {
          title: 'The Matrix',
          overview: 'A hacker learns the truth.',
          poster_path: '/poster.jpg',
          release_date: '1999-03-31',
        },
      },
    ]);
    const result = await client(fetchMock).getMovie(603);
    expect(result).toEqual({
      title: 'The Matrix',
      overview: 'A hacker learns the truth.',
      posterPath: '/poster.jpg',
      releaseDate: '1999-03-31T00:00:00.000Z',
    });
  });

  it('maps missing overview to empty string and null poster/release', async () => {
    const fetchMock = sequenceFetch([
      {
        status: 200,
        body: { title: 'Unreleased', poster_path: null, release_date: '' },
      },
    ]);
    const result = await client(fetchMock).getMovie(1);
    expect(result).toEqual({
      title: 'Unreleased',
      overview: '',
      posterPath: null,
      releaseDate: null,
    });
  });

  it('returns null on 404', async () => {
    const fetchMock = sequenceFetch([{ status: 404 }]);
    expect(await client(fetchMock).getMovie(999)).toBeNull();
  });
});

describe('getTvShow', () => {
  it('maps name->title and first_air_date->releaseDate', async () => {
    const fetchMock = sequenceFetch([
      {
        status: 200,
        body: {
          // `title` should be IGNORED for tv; `name` wins.
          title: 'wrong',
          name: 'Breaking Bad',
          overview: 'A teacher cooks.',
          poster_path: '/bb.jpg',
          first_air_date: '2008-01-20',
        },
      },
    ]);
    const result = await client(fetchMock).getTvShow(1396);
    expect(result).toEqual({
      title: 'Breaking Bad',
      overview: 'A teacher cooks.',
      posterPath: '/bb.jpg',
      releaseDate: '2008-01-20T00:00:00.000Z',
    });
  });

  it('maps missing first_air_date to null releaseDate', async () => {
    const fetchMock = sequenceFetch([
      { status: 200, body: { name: 'New Show', poster_path: null } },
    ]);
    const result = await client(fetchMock).getTvShow(2);
    expect(result).toEqual({
      title: 'New Show',
      overview: '',
      posterPath: null,
      releaseDate: null,
    });
  });

  it('returns null on 404', async () => {
    const fetchMock = sequenceFetch([{ status: 404 }]);
    expect(await client(fetchMock).getTvShow(999)).toBeNull();
  });
});

describe('getWatchProviders', () => {
  const payload = {
    id: 603,
    results: {
      NL: {
        link: 'https://example/nl',
        flatrate: [
          {
            provider_id: 8,
            provider_name: 'Netflix',
            display_priority: 1,
            logo_path: '/n.jpg',
          },
        ],
        rent: [{ provider_id: 10, provider_name: 'Amazon Video' }],
        buy: [{ provider_id: 2, provider_name: 'Apple TV' }],
      },
      DE: {
        // Only ads/free → mapped to an empty array (key present).
        ads: [{ provider_id: 99, provider_name: 'AdSupported' }],
        free: [{ provider_id: 100, provider_name: 'FreeTV' }],
      },
      JP: {
        // Non-REGIONS country → dropped entirely.
        flatrate: [{ provider_id: 8, provider_name: 'Netflix' }],
      },
      // GB, US, FR, BE absent → keys absent.
    },
  };

  it('maps buckets to WatchProvider.type, drops non-REGIONS and ads/free', async () => {
    const fetchMock = sequenceFetch([{ status: 200, body: payload }]);
    const result = await client(fetchMock).getWatchProviders(603, 'movie');
    expect(result).not.toBeNull();
    expect(result?.NL).toEqual([
      { providerId: 8, name: 'Netflix', type: 'flatrate' },
      { providerId: 10, name: 'Amazon Video', type: 'rent' },
      { providerId: 2, name: 'Apple TV', type: 'buy' },
    ]);
    // REGIONS country present but only ads/free → key present, empty array.
    expect(result?.DE).toEqual([]);
    // Non-REGIONS dropped.
    expect(result).not.toHaveProperty('JP');
    // Absent REGIONS countries → no key.
    expect(result).not.toHaveProperty('GB');
    expect(result).not.toHaveProperty('US');
  });

  it('uses the movie endpoint for movies and tv endpoint for tv', async () => {
    const movieFetch = sequenceFetch([{ status: 200, body: { results: {} } }]);
    await client(movieFetch).getWatchProviders(603, 'movie');
    expect(movieFetch).toHaveBeenCalledWith(
      expect.stringContaining('/movie/603/watch/providers'),
      expect.anything(),
    );

    const tvFetch = sequenceFetch([{ status: 200, body: { results: {} } }]);
    await client(tvFetch).getWatchProviders(1396, 'tv');
    expect(tvFetch).toHaveBeenCalledWith(
      expect.stringContaining('/tv/1396/watch/providers'),
      expect.anything(),
    );
  });

  it('returns null on 404', async () => {
    const fetchMock = sequenceFetch([{ status: 404 }]);
    expect(await client(fetchMock).getWatchProviders(999, 'movie')).toBeNull();
  });
});

describe('getSeasonEpisodes', () => {
  it('maps episodes, skips null/empty/missing air_date, falls back season number', async () => {
    const fetchMock = sequenceFetch([
      {
        status: 200,
        body: {
          episodes: [
            { season_number: 1, episode_number: 1, air_date: '2008-01-20' },
            { season_number: 1, episode_number: 2, air_date: null },
            { season_number: 1, episode_number: 3, air_date: '' },
            { episode_number: 4 }, // missing air_date AND season_number
            { episode_number: 5, air_date: '2008-02-10' }, // missing season_number → fallback
          ],
        },
      },
    ]);
    const result = await client(fetchMock).getSeasonEpisodes(1396, 1);
    expect(result).toEqual([
      {
        season: 1,
        episode: 1,
        title: null,
        airDate: '2008-01-20T00:00:00.000Z',
      },
      {
        season: 1,
        episode: 5,
        title: null,
        airDate: '2008-02-10T00:00:00.000Z',
      },
    ]);
  });

  it('returns [] for a season with no episodes', async () => {
    const fetchMock = sequenceFetch([{ status: 200, body: { episodes: [] } }]);
    expect(await client(fetchMock).getSeasonEpisodes(1396, 5)).toEqual([]);
  });

  it('returns null on 404', async () => {
    const fetchMock = sequenceFetch([{ status: 404 }]);
    expect(await client(fetchMock).getSeasonEpisodes(999, 1)).toBeNull();
  });
});

describe('getRegionWatchProviders (spec 0060)', () => {
  const movieBody = {
    results: [
      { provider_id: 8, provider_name: 'Netflix', logo_path: '/n.jpg' },
      { provider_id: 337, provider_name: 'Disney Plus', logo_path: '/d.jpg' },
    ],
  };
  const tvBody = {
    results: [
      // Netflix also appears on the tv side (dedupe target).
      { provider_id: 8, provider_name: 'Netflix', logo_path: '/n.jpg' },
      { provider_id: 9, provider_name: 'Amazon Prime Video', logo_path: null },
    ],
  };

  it('merges both endpoints, deduped and sorted by name', async () => {
    const fetchMock = sequenceFetch([
      { status: 200, body: movieBody },
      { status: 200, body: tvBody },
    ]);
    const result = await client(fetchMock).getRegionWatchProviders('NL');
    expect(result).toEqual([
      { providerId: 9, name: 'Amazon Prime Video', logoPath: null },
      { providerId: 337, name: 'Disney Plus', logoPath: '/d.jpg' },
      { providerId: 8, name: 'Netflix', logoPath: '/n.jpg' },
    ]);
  });

  it('passes watch_region on both movie and tv endpoints', async () => {
    const fetchMock = sequenceFetch([
      { status: 200, body: { results: [] } },
      { status: 200, body: { results: [] } },
    ]);
    await client(fetchMock).getRegionWatchProviders('DE');
    const urls = (
      fetchMock as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[0] as string);
    expect(urls).toEqual([
      expect.stringContaining('/watch/providers/movie?watch_region=DE'),
      expect.stringContaining('/watch/providers/tv?watch_region=DE'),
    ]);
  });

  it('when the movie endpoint 404s, returns the tv side only', async () => {
    const fetchMock = sequenceFetch([
      { status: 404 },
      { status: 200, body: tvBody },
    ]);
    const result = await client(fetchMock).getRegionWatchProviders('NL');
    expect(result).toEqual([
      { providerId: 9, name: 'Amazon Prime Video', logoPath: null },
      { providerId: 8, name: 'Netflix', logoPath: '/n.jpg' },
    ]);
  });

  it('when the tv endpoint 404s, returns the movie side only', async () => {
    const fetchMock = sequenceFetch([
      { status: 200, body: movieBody },
      { status: 404 },
    ]);
    const result = await client(fetchMock).getRegionWatchProviders('NL');
    expect(result).toEqual([
      { providerId: 337, name: 'Disney Plus', logoPath: '/d.jpg' },
      { providerId: 8, name: 'Netflix', logoPath: '/n.jpg' },
    ]);
  });

  it('returns null only when BOTH endpoints 404', async () => {
    const fetchMock = sequenceFetch([{ status: 404 }, { status: 404 }]);
    expect(await client(fetchMock).getRegionWatchProviders('NL')).toBeNull();
  });

  it('returns [] when both endpoints return empty catalogs', async () => {
    const fetchMock = sequenceFetch([
      { status: 200, body: { results: [] } },
      { status: 200, body: {} }, // missing results → []
    ]);
    expect(await client(fetchMock).getRegionWatchProviders('NL')).toEqual([]);
  });

  it('keeps the token in the header, never in the url', async () => {
    const fetchMock = sequenceFetch([
      { status: 200, body: { results: [] } },
      { status: 200, body: { results: [] } },
    ]);
    await client(fetchMock).getRegionWatchProviders('NL');
    for (const call of (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls) {
      const url = call[0] as string;
      const init = call[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(url).not.toContain(TOKEN);
      expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    }
  });
});

describe('error handling', () => {
  it('throws TmdbError with status 401', async () => {
    const fetchMock = sequenceFetch([{ status: 401 }]);
    await expect(client(fetchMock).getMovie(1)).rejects.toMatchObject({
      name: 'TmdbError',
      status: 401,
    });
    await expect(
      client(sequenceFetch([{ status: 401 }])).getMovie(1),
    ).rejects.toBeInstanceOf(TmdbError);
  });

  it('throws TmdbError with the 5xx status', async () => {
    const fetchMock = sequenceFetch([{ status: 503 }]);
    await expect(client(fetchMock).getMovie(1)).rejects.toMatchObject({
      name: 'TmdbError',
      status: 503,
    });
  });

  it('throws TmdbError with status 0 on transport failure', async () => {
    const fetchMock = sequenceFetch([{ reject: true }]);
    await expect(client(fetchMock).getMovie(1)).rejects.toMatchObject({
      name: 'TmdbError',
      status: 0,
    });
  });
});

describe('retry / throttle', () => {
  it('retries a 429 honoring Retry-After then resolves on 200', async () => {
    const fetchMock = sequenceFetch([
      { status: 429, retryAfter: '0' },
      {
        status: 200,
        body: { title: 'Retried', release_date: '2000-01-01' },
      },
    ]);
    const result = await client(fetchMock).getMovie(1);
    expect(result?.title).toBe('Retried');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws TmdbError status 429 when retries are exhausted', async () => {
    // maxRetries=1 → initial + 1 retry = 2 calls, both 429.
    const fetchMock = sequenceFetch([
      { status: 429, retryAfter: '0' },
      { status: 429, retryAfter: '0' },
    ]);
    await expect(
      client(fetchMock, { maxRetries: 1 }).getMovie(1),
    ).rejects.toMatchObject({ name: 'TmdbError', status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('auth + token safety', () => {
  it('sends Authorization Bearer and Accept headers on every request', async () => {
    const fetchMock = sequenceFetch([
      { status: 200, body: { title: 'A' } },
      { status: 200, body: { results: {} } },
    ]);
    const c = client(fetchMock);
    await c.getMovie(1);
    await c.getWatchProviders(1, 'movie');
    for (const call of (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls) {
      const init = call[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
      expect(headers['Accept']).toBe('application/json');
      // Regression after the http.ts generalization: TMDB must NOT send any
      // Trakt headers through the now-shared core.
      expect(headers['trakt-api-key']).toBeUndefined();
      expect(headers['trakt-api-version']).toBeUndefined();
    }
  });

  it('never leaks the token in TmdbError message or endpoint', async () => {
    const cases: FetchStep[] = [
      { status: 401 },
      { status: 500 },
      { reject: true },
    ];
    for (const step of cases) {
      const fetchMock = sequenceFetch([step]);
      try {
        await client(fetchMock).getMovie(42);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(TmdbError);
        const e = err as TmdbError;
        expect(e.message).not.toContain(TOKEN);
        expect(e.endpoint).not.toContain(TOKEN);
        expect(e.endpoint).toBe('/movie/42?language=en-US');
      }
    }
  });

  it('does not log the token', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const fetchMock = sequenceFetch([{ status: 401 }]);
    await expect(client(fetchMock).getMovie(1)).rejects.toBeInstanceOf(
      TmdbError,
    );
    for (const spy of [logSpy, errSpy, warnSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(TOKEN);
      }
    }
  });
});
