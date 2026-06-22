import type { TitleType } from '@vultus/shared/domain';

/**
 * A single normalized TMDB search hit, ready for the UI/state layer. Person
 * results and anything without an id are dropped by the client.
 */
export interface SearchResult {
  tmdbId: number;
  type: TitleType; // 'movie' | 'tv'
  title: string;
  year: number | null;
  posterUrl: string | null;
}

/**
 * Configuration for the slice-local TMDB client. Provided at the app root via
 * `TMDB_SEARCH_CONFIG` (see `./tokens`). `auth` supports either a v4 bearer
 * token or a v3 api_key query param.
 */
export interface TmdbSearchConfig {
  apiBaseUrl: string; // e.g. https://api.themoviedb.org/3
  imageBaseUrl: string; // e.g. https://image.tmdb.org/t/p/w185
  auth: { kind: 'bearer'; token: string } | { kind: 'apiKey'; apiKey: string };
}

export interface TmdbSearchClient {
  searchMulti(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
}

interface RawTmdbResult {
  id?: number;
  media_type?: string;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
}

interface RawTmdbResponse {
  results?: RawTmdbResult[];
}

function parseYear(date: string | undefined): number | null {
  const raw = date?.substring(0, 4)?.trim();
  if (!raw) return null;
  const year = parseInt(raw, 10);
  return Number.isNaN(year) ? null : year;
}

/**
 * Build a slice-local TMDB `search/multi` client. The optional `fetchImpl`
 * exists for tests; production uses the global `fetch`.
 */
export function createTmdbSearchClient(
  config: TmdbSearchConfig,
  fetchImpl?: typeof fetch,
): TmdbSearchClient {
  const doFetch = fetchImpl ?? fetch;

  return {
    async searchMulti(
      query: string,
      signal?: AbortSignal,
    ): Promise<SearchResult[]> {
      const params = new URLSearchParams({
        query,
        language: 'en-US',
        page: '1',
      });
      const headers: Record<string, string> = {};
      if (config.auth.kind === 'bearer') {
        headers['Authorization'] = `Bearer ${config.auth.token}`;
      } else {
        params.set('api_key', config.auth.apiKey);
      }

      const url = `${config.apiBaseUrl}/search/multi?${params.toString()}`;
      const response = await doFetch(url, { headers, signal });

      if (!response.ok) {
        throw new Error(`TMDB search failed: ${response.status}`);
      }

      const body = (await response.json()) as RawTmdbResponse;
      const raw = body.results ?? [];

      return raw
        .filter(
          (r): r is RawTmdbResult & { id: number } =>
            typeof r.id === 'number' &&
            (r.media_type === 'movie' || r.media_type === 'tv'),
        )
        .map((r) => {
          const isMovie = r.media_type === 'movie';
          const type: TitleType = isMovie ? 'movie' : 'tv';
          return {
            tmdbId: r.id,
            type,
            title: (isMovie ? r.title : r.name) ?? '',
            year: parseYear(isMovie ? r.release_date : r.first_air_date),
            posterUrl: r.poster_path
              ? config.imageBaseUrl + r.poster_path
              : null,
          };
        });
    },
  };
}
