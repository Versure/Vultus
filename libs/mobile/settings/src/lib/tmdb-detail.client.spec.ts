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

describe('createTmdbDetailClient — findByExternalId (spec 0097)', () => {
  it('tvdb id (tv) → returns tv_results[0].id', async () => {
    const fetch = makeFetch({
      tv_results: [{ id: 1396 }, { id: 999 }],
      movie_results: [],
    });
    const client = createTmdbDetailClient(config, fetch);
    const id = await client.findByExternalId('81189', 'tvdb_id', 'tv');
    expect(id).toBe(1396);
    // Builds /find/{id}?external_source=... with the same api_key auth.
    const url = fetch.mock.calls[0][0] as string;
    expect(url).toContain('/find/81189?');
    expect(url).toContain('external_source=tvdb_id');
    expect(url).toContain('api_key=test-key');
  });

  it('imdb id (movie) → returns movie_results[0].id', async () => {
    const fetch = makeFetch({
      movie_results: [{ id: 550 }],
      tv_results: [],
    });
    const client = createTmdbDetailClient(config, fetch);
    const id = await client.findByExternalId('tt0137523', 'imdb_id', 'movie');
    expect(id).toBe(550);
    const url = fetch.mock.calls[0][0] as string;
    expect(url).toContain('external_source=imdb_id');
  });

  it('media-type mismatch: a tvdb id yielding only movie_results for a tv request → null', async () => {
    const fetch = makeFetch({ movie_results: [{ id: 550 }], tv_results: [] });
    const client = createTmdbDetailClient(config, fetch);
    const id = await client.findByExternalId('81189', 'tvdb_id', 'tv');
    expect(id).toBeNull();
  });

  it('empty results → null', async () => {
    const fetch = makeFetch({ movie_results: [], tv_results: [] });
    const client = createTmdbDetailClient(config, fetch);
    expect(
      await client.findByExternalId('tt0000000', 'imdb_id', 'movie'),
    ).toBeNull();
  });

  it('non-2xx → throws TmdbDetailError (→ caller counts "error")', async () => {
    const fetch = makeFetch({}, 429);
    const client = createTmdbDetailClient(config, fetch);
    await expect(
      client.findByExternalId('81189', 'tvdb_id', 'tv'),
    ).rejects.toBeInstanceOf(TmdbDetailError);
  });

  it('transport error (fetch rejects) → rethrows', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('network down'));
    const client = createTmdbDetailClient(config, fetch);
    await expect(
      client.findByExternalId('81189', 'tvdb_id', 'tv'),
    ).rejects.toThrow('network down');
  });
});
