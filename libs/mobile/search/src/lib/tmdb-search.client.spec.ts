import { describe, it, expect, vi } from 'vitest';
import { createTmdbSearchClient } from './tmdb-search.client';

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

const movieResult = {
  id: 1,
  media_type: 'movie',
  title: 'Test Movie',
  release_date: '2023-05-10',
  poster_path: '/poster.jpg',
};
const tvResult = {
  id: 2,
  media_type: 'tv',
  name: 'Test Show',
  first_air_date: '2022-01-01',
  poster_path: null,
};
const personResult = { id: 3, media_type: 'person', name: 'John' };

describe('createTmdbSearchClient', () => {
  it('maps movie + tv results, drops person', async () => {
    const fetch = makeFetch({ results: [movieResult, tvResult, personResult] });
    const client = createTmdbSearchClient(config, fetch);
    const results = await client.searchMulti('test');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      tmdbId: 1,
      type: 'movie',
      title: 'Test Movie',
      year: 2023,
      posterUrl: 'https://image.tmdb.org/t/p/w185/poster.jpg',
    });
    expect(results[1]).toMatchObject({
      tmdbId: 2,
      type: 'tv',
      title: 'Test Show',
      year: 2022,
      posterUrl: null,
    });
  });

  it('returns null poster when poster_path is null', async () => {
    const fetch = makeFetch({ results: [tvResult] });
    const client = createTmdbSearchClient(config, fetch);
    const [r] = await client.searchMulti('show');
    expect(r.posterUrl).toBeNull();
  });

  it('returns null year when date is missing', async () => {
    const fetch = makeFetch({
      results: [{ id: 5, media_type: 'movie', title: 'No Date' }],
    });
    const client = createTmdbSearchClient(config, fetch);
    const [r] = await client.searchMulti('q');
    expect(r.year).toBeNull();
  });

  it('uses api_key auth in URL', async () => {
    const fetch = makeFetch({ results: [] });
    const client = createTmdbSearchClient(config, fetch);
    await client.searchMulti('hello');
    const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('api_key=test-key');
    expect(url).toContain('query=hello');
  });

  it('uses bearer auth header', async () => {
    const bearerConfig = {
      ...config,
      auth: { kind: 'bearer' as const, token: 'tok123' },
    };
    const fetch = makeFetch({ results: [] });
    const client = createTmdbSearchClient(bearerConfig, fetch);
    await client.searchMulti('test');
    const init = (fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer tok123',
    );
  });

  it('throws on non-2xx response', async () => {
    const fetch = makeFetch({ status_message: 'Unauthorized' }, 401);
    const client = createTmdbSearchClient(config, fetch);
    await expect(client.searchMulti('q')).rejects.toThrow('401');
  });

  it('drops results with no id', async () => {
    const fetch = makeFetch({ results: [{ media_type: 'movie', title: 'X' }] });
    const client = createTmdbSearchClient(config, fetch);
    const results = await client.searchMulti('q');
    expect(results).toHaveLength(0);
  });
});
