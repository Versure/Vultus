import type {
  Region,
  TitleType,
  WatchProvider,
  WatchProviderType,
} from '@vultus/shared/domain';

/**
 * The resolved detail view model the page renders — produced by EITHER the
 * title-cache read OR the live TMDB fallback (decision 2), so both paths share
 * one shape.
 */
export interface TitleDetail {
  tmdbId: number;
  type: TitleType; // 'movie' | 'tv'
  title: string;
  year: number | null; // from release_date (movie) / first_air_date (tv)
  overview: string;
  posterUrl: string | null; // full image URL or null
  posterPath: string | null; // raw TMDB poster path (for the watchlist denormalized field)
  voteAverage: number | null; // TMDB 0–10 vote average (for the watchlist denormalized field), null if unknown
}

/**
 * Providers for one region, grouped by type (decision 5). Each WatchProvider is
 * rendered as a TEXT chip (provider.name) — there is no logo field.
 */
export interface GroupedProviders {
  flatrate: WatchProvider[];
  rent: WatchProvider[];
  buy: WatchProvider[];
}

/**
 * Injected config — base URLs + auth. NEVER read from a secret by the client.
 * Same shape as the search slice's TmdbSearchConfig (deliberate per-slice
 * duplication — decision 2; the search slice is NOT imported).
 */
export interface TmdbDetailConfig {
  apiBaseUrl: string; // e.g. https://api.themoviedb.org/3
  imageBaseUrl: string; // e.g. https://image.tmdb.org/t/p/w780 (detail hero, spec 0036)
  auth: { kind: 'bearer'; token: string } | { kind: 'apiKey'; apiKey: string };
  /**
   * Optional fetch override — used in mock/dev environments. Production leaves
   * this unset and the global `fetch` is used; tests inject via the factory's
   * second param.
   */
  fetchImpl?: typeof fetch;
}

export interface TmdbDetailClient {
  /**
   * GET /movie/{id} or /tv/{id}; maps to TitleDetail. `typeHint` (from the
   * watchlist doc when tracked) picks the endpoint; absent → try movie then tv.
   * Throws a typed error on non-2xx so the service can surface a not-found view.
   */
  getDetail(
    tmdbId: number,
    typeHint?: TitleType,
    signal?: AbortSignal,
  ): Promise<TitleDetail>;

  /**
   * GET /{type}/{id}/watch/providers; returns the providers for `region`
   * grouped by type, or empty groups when the region is absent in the response.
   */
  getProviders(
    tmdbId: number,
    type: TitleType,
    region: Region,
    signal?: AbortSignal,
  ): Promise<GroupedProviders>;
}

/** A typed error so the service can map a TMDB failure to the not-found state. */
export class TmdbDetailError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TmdbDetailError';
  }
}

interface RawTmdbDetail {
  id?: number;
  title?: string; // movie
  name?: string; // tv
  release_date?: string; // movie
  first_air_date?: string; // tv
  overview?: string;
  poster_path?: string | null;
  vote_average?: number;
}

interface RawProviderEntry {
  provider_id?: number;
  provider_name?: string;
}

interface RawProviderRegion {
  flatrate?: RawProviderEntry[];
  rent?: RawProviderEntry[];
  buy?: RawProviderEntry[];
}

interface RawProviderResponse {
  results?: Record<string, RawProviderRegion | undefined>;
}

function parseYear(date: string | undefined): number | null {
  const raw = date?.substring(0, 4)?.trim();
  if (!raw) return null;
  const year = parseInt(raw, 10);
  return Number.isNaN(year) ? null : year;
}

/**
 * Build a slice-local TMDB detail client. The optional `fetchImpl` exists for
 * tests; production uses the global `fetch`. The client is framework-light (no
 * Angular decorator), performs NO Firestore access, and NEVER writes
 * `title-cache` (decision 2).
 */
export function createTmdbDetailClient(
  config: TmdbDetailConfig,
  fetchImpl?: typeof fetch,
): TmdbDetailClient {
  const doFetch = config.fetchImpl ?? fetchImpl ?? fetch;

  function authParts(): { headers: Record<string, string>; apiKey?: string } {
    if (config.auth.kind === 'bearer') {
      return { headers: { Authorization: `Bearer ${config.auth.token}` } };
    }
    return { headers: {}, apiKey: config.auth.apiKey };
  }

  function buildUrl(path: string, apiKey?: string): string {
    const params = new URLSearchParams({ language: 'en-US' });
    if (apiKey) {
      params.set('api_key', apiKey);
    }
    return `${config.apiBaseUrl}${path}?${params.toString()}`;
  }

  function mapDetail(
    raw: RawTmdbDetail,
    type: TitleType,
    tmdbId: number,
  ): TitleDetail {
    const isMovie = type === 'movie';
    return {
      tmdbId,
      type,
      title: (isMovie ? raw.title : raw.name) ?? '',
      year: parseYear(isMovie ? raw.release_date : raw.first_air_date),
      overview: raw.overview ?? '',
      posterUrl: raw.poster_path ? config.imageBaseUrl + raw.poster_path : null,
      posterPath: raw.poster_path ?? null,
      voteAverage:
        typeof raw.vote_average === 'number' ? raw.vote_average : null,
    };
  }

  async function fetchDetailFor(
    tmdbId: number,
    type: TitleType,
    signal?: AbortSignal,
  ): Promise<TitleDetail> {
    const { headers, apiKey } = authParts();
    const url = buildUrl(`/${type}/${tmdbId}`, apiKey);
    const response = await doFetch(url, { headers, signal });
    if (!response.ok) {
      throw new TmdbDetailError(
        `TMDB detail failed: ${response.status}`,
        response.status,
      );
    }
    const body = (await response.json()) as RawTmdbDetail;
    return mapDetail(body, type, tmdbId);
  }

  function mapProviders(
    entries: RawProviderEntry[] | undefined,
    type: WatchProviderType,
  ): WatchProvider[] {
    return (entries ?? [])
      .filter(
        (
          e,
        ): e is RawProviderEntry & {
          provider_id: number;
          provider_name: string;
        } =>
          typeof e.provider_id === 'number' &&
          typeof e.provider_name === 'string',
      )
      .map((e) => ({ providerId: e.provider_id, name: e.provider_name, type }));
  }

  return {
    async getDetail(
      tmdbId: number,
      typeHint?: TitleType,
      signal?: AbortSignal,
    ): Promise<TitleDetail> {
      if (typeHint) {
        return fetchDetailFor(tmdbId, typeHint, signal);
      }
      // No hint: try movie, fall back to tv on a 404/error.
      try {
        return await fetchDetailFor(tmdbId, 'movie', signal);
      } catch {
        return fetchDetailFor(tmdbId, 'tv', signal);
      }
    },

    async getProviders(
      tmdbId: number,
      type: TitleType,
      region: Region,
      signal?: AbortSignal,
    ): Promise<GroupedProviders> {
      const { headers, apiKey } = authParts();
      const url = buildUrl(`/${type}/${tmdbId}/watch/providers`, apiKey);
      const response = await doFetch(url, { headers, signal });
      if (!response.ok) {
        throw new TmdbDetailError(
          `TMDB providers failed: ${response.status}`,
          response.status,
        );
      }
      const body = (await response.json()) as RawProviderResponse;
      const regionBlock = body.results?.[region];
      return {
        flatrate: mapProviders(regionBlock?.flatrate, 'flatrate'),
        rent: mapProviders(regionBlock?.rent, 'rent'),
        buy: mapProviders(regionBlock?.buy, 'buy'),
      };
    },
  };
}
