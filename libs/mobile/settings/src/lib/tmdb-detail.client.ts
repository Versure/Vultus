import type { Episode, TitleType } from '@vultus/shared/domain';

/**
 * The resolved detail the settings Plex sync consumes. Only posterPath /
 * voteAverage are read by PlexSyncService (never posterUrl), so imageBaseUrl is
 * irrelevant to this slice — but the field is kept for structural parity with
 * the title-detail slice's own local `TitleDetail`.
 *
 * This is a DELIBERATE per-slice duplicate of the title-detail slice's detail
 * shape (spec 0016 decision 2, reaffirmed by spec 0086): the settings slice
 * must NOT import `TitleDetail` from `@vultus/mobile/title-detail` (Sheriff
 * forbids the cross-slice edge) and must NOT promote this to `shared/domain`.
 * The local name `TmdbDetail` is intentional and pinned by the spec.
 */
export interface TmdbDetail {
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
 * Injected config — base URLs + auth. NEVER read from a secret by the client.
 * Same shape as the search / title-detail slices' config (deliberate per-slice
 * duplication — spec 0016 decision 2; neither other slice is imported).
 */
export interface TmdbDetailConfig {
  apiBaseUrl: string; // e.g. https://api.themoviedb.org/3
  imageBaseUrl: string; // e.g. https://image.tmdb.org/t/p/w780
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
   * GET /movie/{id} or /tv/{id}; maps to TmdbDetail. `typeHint` (the Plex
   * library item's `type`) picks the endpoint; absent → try movie then tv.
   * Throws a typed error on non-2xx so the caller can catch a TMDB failure.
   */
  getDetail(
    tmdbId: number,
    typeHint?: TitleType,
    signal?: AbortSignal,
  ): Promise<TmdbDetail>;
  /**
   * GET /tv/{id} → `number_of_seasons`; `null` on TMDB 404 (spec 0098).
   * Replicates functions `getTvSeasonCount` (tmdb-client.ts) + mapper
   * `mapTvSeasonCount` (tmdb-mappers.ts). Non-404 non-2xx → throw
   * `TmdbDetailError` (5xx / network / abort surface as a real failure).
   */
  getTvSeasonCount(
    tmdbId: number,
    signal?: AbortSignal,
  ): Promise<number | null>;
  /**
   * GET /tv/{id}/season/{n} → the season's episodes with a NON-NULL air_date;
   * `null` on TMDB 404 (spec 0098). Episodes with a null/empty/missing
   * `air_date` are SKIPPED (`EpisodeDoc.airDate` is non-null). `season` falls
   * back to the `season` argument when TMDB omits `season_number`; `title` =
   * TMDB `name ?? null`. Replicates functions `getSeasonEpisodes` +
   * `mapSeasonEpisodes` (tmdb-mappers.ts). Non-404 non-2xx → throw
   * `TmdbDetailError`. Uses `type: 'tv'` explicitly (no movie fallback).
   */
  getSeasonEpisodes(
    tmdbId: number,
    season: number,
    signal?: AbortSignal,
  ): Promise<Episode[] | null>;
}

/** A typed error so the caller can map a TMDB failure without inspecting fetch internals. */
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
  number_of_seasons?: number; // tv — consumed by getTvSeasonCount (spec 0098)
}

/**
 * Raw `/tv/{id}/season/{n}` payload (spec 0098). Slice-local DTO mirroring the
 * functions' `TmdbSeasonResponse` — only the fields the episode mapper reads.
 */
interface RawTmdbSeason {
  episodes?: {
    air_date?: string;
    episode_number: number;
    season_number?: number;
    name?: string;
  }[];
}

function parseYear(date: string | undefined): number | null {
  const raw = date?.substring(0, 4)?.trim();
  if (!raw) return null;
  const year = parseInt(raw, 10);
  return Number.isNaN(year) ? null : year;
}

/**
 * A present, non-empty date-only `YYYY-MM-DD` → full ISO-8601 UTC instant;
 * null / missing / empty → null (→ the episode is skipped, since
 * `EpisodeDoc.airDate` is non-null). Mirrors the functions' `normalizeDate`.
 */
function normalizeAirDate(date: string | null | undefined): string | null {
  if (!date) return null;
  return new Date(`${date}T00:00:00.000Z`).toISOString();
}

/**
 * Build a slice-local TMDB detail client. The optional `fetchImpl` exists for
 * tests; production uses the global `fetch`. The client is framework-light (no
 * Angular decorator), performs NO Firestore access, and NEVER writes
 * `title-cache` (spec 0016 decision 2 / spec 0086).
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
  ): TmdbDetail {
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

  /**
   * Map a raw season payload → `Episode[]`, replicating the functions'
   * `mapSeasonEpisodes`: skip episodes with a null/empty/missing `air_date`;
   * `season_number` falls back to the `season` argument; `title = name ?? null`.
   */
  function mapSeasonEpisodes(raw: RawTmdbSeason, season: number): Episode[] {
    const episodes: Episode[] = [];
    for (const entry of raw.episodes ?? []) {
      const airDate = normalizeAirDate(entry.air_date);
      if (airDate === null) continue;
      episodes.push({
        season: entry.season_number ?? season,
        episode: entry.episode_number,
        title: entry.name ?? null,
        airDate,
      });
    }
    return episodes;
  }

  async function fetchDetailFor(
    tmdbId: number,
    type: TitleType,
    signal?: AbortSignal,
  ): Promise<TmdbDetail> {
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

  return {
    async getDetail(
      tmdbId: number,
      typeHint?: TitleType,
      signal?: AbortSignal,
    ): Promise<TmdbDetail> {
      if (typeHint) {
        return fetchDetailFor(tmdbId, typeHint, signal);
      }
      // No hint: try movie, fall back to tv ONLY on a genuine 404.
      try {
        return await fetchDetailFor(tmdbId, 'movie', signal);
      } catch (err) {
        if (err instanceof TmdbDetailError && err.status === 404) {
          return fetchDetailFor(tmdbId, 'tv', signal);
        }
        throw err; // 5xx / network / abort → surface as error, not a wrong title
      }
    },

    async getTvSeasonCount(
      tmdbId: number,
      signal?: AbortSignal,
    ): Promise<number | null> {
      const { headers, apiKey } = authParts();
      const url = buildUrl(`/tv/${tmdbId}`, apiKey);
      const response = await doFetch(url, { headers, signal });
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new TmdbDetailError(
          `TMDB season count failed: ${response.status}`,
          response.status,
        );
      }
      const body = (await response.json()) as RawTmdbDetail;
      return body.number_of_seasons ?? null;
    },

    async getSeasonEpisodes(
      tmdbId: number,
      season: number,
      signal?: AbortSignal,
    ): Promise<Episode[] | null> {
      const { headers, apiKey } = authParts();
      const url = buildUrl(`/tv/${tmdbId}/season/${season}`, apiKey);
      const response = await doFetch(url, { headers, signal });
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new TmdbDetailError(
          `TMDB season episodes failed: ${response.status}`,
          response.status,
        );
      }
      const body = (await response.json()) as RawTmdbSeason;
      return mapSeasonEpisodes(body, season);
    },
  };
}
