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

  it('no typeHint → tries movie then falls back to tv', async () => {
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

  it('throws a typed TmdbDetailError on non-2xx', async () => {
    const fetch = makeFetch({ status_message: 'Not Found' }, 404);
    const client = createTmdbDetailClient(config, fetch);
    await expect(client.getDetail(1, 'movie')).rejects.toBeInstanceOf(
      TmdbDetailError,
    );
  });

  // Spec 0036: the detail slice is wired to the larger w780 base (vs search's
  // w185) so the 530px hero renders sharp. Guard that posterUrl is built off
  // whatever base the config carries — a w780 base yields a w780 posterUrl.
  it('builds posterUrl from the configured (w780) detail base', async () => {
    const fetch = makeFetch({
      id: 27205,
      title: 'Inception',
      poster_path: '/poster.jpg',
    });
    const client = createTmdbDetailClient(
      { ...config, imageBaseUrl: 'https://image.tmdb.org/t/p/w780' },
      fetch,
    );
    const detail = await client.getDetail(27205, 'movie');
    expect(detail.posterUrl).toBe('https://image.tmdb.org/t/p/w780/poster.jpg');
    expect(detail.posterUrl).not.toContain('w185');
  });
});

describe('createTmdbDetailClient — getProviders', () => {
  const providerBody = {
    results: {
      NL: {
        flatrate: [
          { provider_id: 8, provider_name: 'Netflix', logo_path: '/n.jpg' },
        ],
        rent: [{ provider_id: 10, provider_name: 'Amazon Video' }],
        buy: [{ provider_id: 2, provider_name: 'Apple TV' }],
      },
    },
  };

  it('groups providers and drops the logo field', async () => {
    const fetch = makeFetch(providerBody);
    const client = createTmdbDetailClient(config, fetch);
    const groups = await client.getProviders(27205, 'movie', 'NL');
    expect(groups.flatrate).toEqual([
      { providerId: 8, name: 'Netflix', type: 'flatrate' },
    ]);
    expect(groups.rent).toEqual([
      { providerId: 10, name: 'Amazon Video', type: 'rent' },
    ]);
    expect(groups.buy).toEqual([
      { providerId: 2, name: 'Apple TV', type: 'buy' },
    ]);
    // No logo key leaks through.
    expect(groups.flatrate[0]).not.toHaveProperty('logo_path');
  });

  it('region absent from results → all-empty groups', async () => {
    const fetch = makeFetch({ results: { US: { flatrate: [] } } });
    const client = createTmdbDetailClient(config, fetch);
    const groups = await client.getProviders(1, 'movie', 'NL');
    expect(groups).toEqual({ flatrate: [], rent: [], buy: [] });
  });

  it('hits the watch/providers endpoint with the injected fetch', async () => {
    const fetch = makeFetch({ results: {} });
    const client = createTmdbDetailClient(config, fetch);
    await client.getProviders(42, 'tv', 'NL');
    expect(fetch.mock.calls[0][0] as string).toContain(
      '/tv/42/watch/providers',
    );
  });

  it('throws a typed error on non-2xx', async () => {
    const fetch = makeFetch({}, 500);
    const client = createTmdbDetailClient(config, fetch);
    await expect(client.getProviders(1, 'movie', 'NL')).rejects.toBeInstanceOf(
      TmdbDetailError,
    );
  });
});
