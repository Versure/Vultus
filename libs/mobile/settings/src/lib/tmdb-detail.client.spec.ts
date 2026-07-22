import { describe, expect, it, vi } from 'vitest';
import { TmdbDetailError, createTmdbDetailClient } from './tmdb-detail.client';

const config = {
  apiBaseUrl: 'https://api.tmdb.org/3',
  imageBaseUrl: 'https://image.tmdb.org/t/p/w185',
  auth: { kind: 'apiKey' as const, apiKey: 'test-key' },
};

function makeFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

describe('createTmdbDetailClient — getDetail', () => {
  it('maps a movie payload (title, release_date year, poster, vote)', async () => {
    const fetch = makeFetch({
      id: 27205,
      title: 'Inception',
      release_date: '2010-07-16',
      overview: 'A thief who steals corporate secrets...',
      poster_path: '/poster.jpg',
      vote_average: 8.8,
    });
    const client = createTmdbDetailClient(config, fetch);
    const detail = await client.getDetail(27205, 'movie');
    expect(detail).toEqual({
      tmdbId: 27205,
      type: 'movie',
      title: 'Inception',
      year: 2010,
      overview: 'A thief who steals corporate secrets...',
      posterUrl: 'https://image.tmdb.org/t/p/w185/poster.jpg',
      posterPath: '/poster.jpg',
      voteAverage: 8.8,
    });
  });

  it('maps a tv payload (name, first_air_date year)', async () => {
    const fetch = makeFetch({
      id: 1396,
      name: 'Breaking Bad',
      first_air_date: '2008-01-20',
      overview: 'A chemistry teacher...',
      poster_path: '/bb.jpg',
      vote_average: 8.9,
    });
    const client = createTmdbDetailClient(config, fetch);
    const detail = await client.getDetail(1396, 'tv');
    expect(detail.type).toBe('tv');
    expect(detail.title).toBe('Breaking Bad');
    expect(detail.year).toBe(2008);
  });

  it('null poster / blank date / missing vote → null fields (no NaN)', async () => {
    const fetch = makeFetch({
      id: 5,
      title: 'No Meta',
      release_date: '',
      overview: '',
      poster_path: null,
    });
    const client = createTmdbDetailClient(config, fetch);
    const detail = await client.getDetail(5, 'movie');
    expect(detail.posterUrl).toBeNull();
    expect(detail.posterPath).toBeNull();
    expect(detail.year).toBeNull();
    expect(detail.voteAverage).toBeNull();
  });

  it('uses the typeHint endpoint with api_key auth + injected fetch', async () => {
    const fetch = makeFetch({ id: 1, title: 'X' });
    const client = createTmdbDetailClient(config, fetch);
    await client.getDetail(1, 'movie');
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = fetch.mock.calls[0][0] as string;
    expect(url).toContain('/movie/1?');
    expect(url).toContain('api_key=test-key');
  });

  it('uses bearer auth header when configured', async () => {
    const fetch = makeFetch({ id: 2, name: 'Y' });
    const client = createTmdbDetailClient(
      { ...config, auth: { kind: 'bearer', token: 'tok123' } },
      fetch,
    );
    await client.getDetail(2, 'tv');
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer tok123',
    );
    expect(fetch.mock.calls[0][0] as string).not.toContain('api_key');
  });

  it('no typeHint → tries movie then falls back to tv on 404', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            id: 9,
            name: 'TV Title',
            first_air_date: '2020-01-01',
          }),
      });
    const client = createTmdbDetailClient(config, fetch);
    const detail = await client.getDetail(9);
    expect(detail.type).toBe('tv');
    expect(fetch.mock.calls[0][0] as string).toContain('/movie/9');
    expect(fetch.mock.calls[1][0] as string).toContain('/tv/9');
  });

  // Regression (spec 0037): a non-404 error must NOT fall through to /tv — it
  // must propagate so the caller sees the real failure instead of a wrong title.
  it('no typeHint → non-404 error on movie re-throws without calling tv (0037)', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });
    const client = createTmdbDetailClient(config, fetch);
    await expect(client.getDetail(9)).rejects.toBeInstanceOf(TmdbDetailError);
    // The /tv endpoint must NOT have been called.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0] as string).toContain('/movie/9');
  });

  // Regression (spec 0037): network error (fetch rejects) must also re-throw,
  // not fall through to /tv.
  it('no typeHint → network error on movie re-throws without calling tv (0037)', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('Network failure'));
    const client = createTmdbDetailClient(config, fetch);
    await expect(client.getDetail(42)).rejects.toThrow('Network failure');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0] as string).toContain('/movie/42');
  });

  it('throws a typed TmdbDetailError on non-2xx', async () => {
    const fetch = makeFetch({ status_message: 'Not Found' }, 404);
    const client = createTmdbDetailClient(config, fetch);
    await expect(client.getDetail(1, 'movie')).rejects.toBeInstanceOf(
      TmdbDetailError,
    );
  });
});

describe('createTmdbDetailClient — getTvSeasonCount (spec 0098)', () => {
  it('maps number_of_seasons from a /tv/{id} payload', async () => {
    const fetch = makeFetch({
      id: 1396,
      name: 'Breaking Bad',
      number_of_seasons: 5,
    });
    const client = createTmdbDetailClient(config, fetch);
    const count = await client.getTvSeasonCount(1396);
    expect(count).toBe(5);
    const url = fetch.mock.calls[0][0] as string;
    expect(url).toContain('/tv/1396?');
    expect(url).toContain('api_key=test-key');
  });

  it('returns null when number_of_seasons is absent', async () => {
    const fetch = makeFetch({ id: 1396, name: 'Breaking Bad' });
    const client = createTmdbDetailClient(config, fetch);
    expect(await client.getTvSeasonCount(1396)).toBeNull();
  });

  it('returns null on a TMDB 404 (does not throw)', async () => {
    const fetch = makeFetch({ status_message: 'Not Found' }, 404);
    const client = createTmdbDetailClient(config, fetch);
    expect(await client.getTvSeasonCount(999999)).toBeNull();
  });

  it('throws TmdbDetailError on a 500 (not null)', async () => {
    const fetch = makeFetch({ status_message: 'Server Error' }, 500);
    const client = createTmdbDetailClient(config, fetch);
    await expect(client.getTvSeasonCount(1396)).rejects.toBeInstanceOf(
      TmdbDetailError,
    );
  });

  it('sends the bearer header when configured, no api_key', async () => {
    const fetch = makeFetch({ id: 1396, number_of_seasons: 1 });
    const client = createTmdbDetailClient(
      { ...config, auth: { kind: 'bearer', token: 'tok123' } },
      fetch,
    );
    await client.getTvSeasonCount(1396);
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer tok123',
    );
    expect(fetch.mock.calls[0][0] as string).not.toContain('api_key');
  });
});

describe('createTmdbDetailClient — getSeasonEpisodes (spec 0098)', () => {
  it('maps a season payload → Episode[] (season/episode/title/airDate)', async () => {
    const fetch = makeFetch({
      episodes: [
        {
          episode_number: 1,
          season_number: 1,
          name: 'Pilot',
          air_date: '2008-01-20',
        },
        {
          episode_number: 2,
          season_number: 1,
          name: "Cat's in the Bag...",
          air_date: '2008-01-27',
        },
      ],
    });
    const client = createTmdbDetailClient(config, fetch);
    const episodes = await client.getSeasonEpisodes(1396, 1);
    expect(episodes).toEqual([
      {
        season: 1,
        episode: 1,
        title: 'Pilot',
        airDate: new Date('2008-01-20T00:00:00.000Z').toISOString(),
      },
      {
        season: 1,
        episode: 2,
        title: "Cat's in the Bag...",
        airDate: new Date('2008-01-27T00:00:00.000Z').toISOString(),
      },
    ]);
    const url = fetch.mock.calls[0][0] as string;
    expect(url).toContain('/tv/1396/season/1?');
    expect(url).toContain('api_key=test-key');
  });

  it('skips episodes with null/empty/missing air_date', async () => {
    const fetch = makeFetch({
      episodes: [
        {
          episode_number: 1,
          season_number: 1,
          name: 'Aired',
          air_date: '2008-01-20',
        },
        {
          episode_number: 2,
          season_number: 1,
          name: 'Null date',
          air_date: null,
        },
        {
          episode_number: 3,
          season_number: 1,
          name: 'Empty date',
          air_date: '',
        },
        { episode_number: 4, season_number: 1, name: 'Missing date' },
      ],
    });
    const client = createTmdbDetailClient(config, fetch);
    const episodes = await client.getSeasonEpisodes(1396, 1);
    expect(episodes).toHaveLength(1);
    expect(episodes?.[0].episode).toBe(1);
  });

  it('falls back to the season argument when season_number is absent', async () => {
    const fetch = makeFetch({
      episodes: [
        { episode_number: 5, name: 'No season_number', air_date: '2010-03-21' },
      ],
    });
    const client = createTmdbDetailClient(config, fetch);
    const episodes = await client.getSeasonEpisodes(1396, 3);
    expect(episodes?.[0].season).toBe(3);
  });

  it('sets title to null when name is absent', async () => {
    const fetch = makeFetch({
      episodes: [
        { episode_number: 1, season_number: 1, air_date: '2008-01-20' },
      ],
    });
    const client = createTmdbDetailClient(config, fetch);
    const episodes = await client.getSeasonEpisodes(1396, 1);
    expect(episodes?.[0].title).toBeNull();
  });

  it('returns null on a TMDB 404 (does not throw)', async () => {
    const fetch = makeFetch({ status_message: 'Not Found' }, 404);
    const client = createTmdbDetailClient(config, fetch);
    expect(await client.getSeasonEpisodes(1396, 99)).toBeNull();
  });

  it('throws TmdbDetailError on a 500 (not null)', async () => {
    const fetch = makeFetch({ status_message: 'Server Error' }, 500);
    const client = createTmdbDetailClient(config, fetch);
    await expect(client.getSeasonEpisodes(1396, 1)).rejects.toBeInstanceOf(
      TmdbDetailError,
    );
  });

  it('uses type tv explicitly and the injected fetch with bearer auth', async () => {
    const fetch = makeFetch({ episodes: [] });
    const client = createTmdbDetailClient(
      { ...config, auth: { kind: 'bearer', token: 'tok123' } },
      fetch,
    );
    await client.getSeasonEpisodes(1396, 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = fetch.mock.calls[0][0] as string;
    expect(url).toContain('/tv/1396/season/1?');
    expect(url).not.toContain('api_key');
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer tok123',
    );
  });
});
