// Typed TMDB v3 client. Wires the http core + mappers into four methods, all
// with 404 → null semantics. Auth is an injected v4 read-access bearer token;
// the client never reads it from env/secret.

import type {
  CatalogProvider,
  Episode,
  Region,
  TitleMetadata,
  TitleType,
  WatchProvider,
} from '@vultus/shared/domain';
import { createHttpCore, NOT_FOUND } from '../shared/http';
import {
  mapMovie,
  mapSeasonEpisodes,
  mapTvShow,
  mapWatchProviders,
  mergeCatalogProviders,
} from './tmdb-mappers';
import { TmdbError } from './tmdb-error';
import type {
  TmdbMovieResponse,
  TmdbSeasonResponse,
  TmdbTvResponse,
  TmdbWatchProviderListResponse,
  TmdbWatchProvidersResponse,
} from './tmdb-dtos';
import { mapTvSeasonCount } from './tmdb-mappers';

/** Per-region streaming-availability map returned by `getWatchProviders`. */
export type RegionProviders = Partial<Record<Region, WatchProvider[]>>;

export interface TmdbClientConfig {
  /** TMDB v4 read-access token, sent as `Authorization: Bearer <token>`.
   *  INJECTED by the caller — the client NEVER reads it from env/secret. */
  readAccessToken: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Defaults to 'https://api.themoviedb.org/3'. */
  baseUrl?: string;
  /** Metadata language for overview/title/poster selection. Defaults to 'en-US'. */
  language?: string;
  /** 429 retry cap; default 5. */
  maxRetries?: number;
  /** Throttle floor between requests in ms; default 250. */
  minRequestIntervalMs?: number;
  /** Base (ms) for the exponential backoff floor on a `429` retry; default 500.
   *  See `createHttpCore` — the wait is `max(Retry-After, base*2^attempt+jitter)`. */
  backoffBaseMs?: number;
}

export interface TmdbClient {
  getMovie(tmdbId: number): Promise<TitleMetadata | null>;
  getTvShow(tmdbId: number): Promise<TitleMetadata | null>;
  /** Returns the show's total season count, or null on TMDB 404. Added for the
   *  episode-sync consumer (spec 0047). */
  getTvSeasonCount(tmdbId: number): Promise<number | null>;
  getWatchProviders(
    tmdbId: number,
    type: TitleType,
  ): Promise<RegionProviders | null>;
  getSeasonEpisodes(
    tmdbId: number,
    seasonNumber: number,
  ): Promise<Episode[] | null>;
  /** Fetches the region's flatrate/rent/buy provider CATALOG (movie + tv merged,
   *  deduped by providerId) from GET /watch/providers/{movie,tv}?watch_region=…
   *  (spec 0060). Returns [] when TMDB returns an empty catalog; null on a TMDB
   *  404 (consistent with the other methods). */
  getRegionWatchProviders(region: Region): Promise<CatalogProvider[] | null>;
}

const DEFAULT_BASE_URL = 'https://api.themoviedb.org/3';
const DEFAULT_LANGUAGE = 'en-US';
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 250;
const DEFAULT_BACKOFF_BASE_MS = 500;

export function createTmdbClient(config: TmdbClientConfig): TmdbClient {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'TmdbClient requires a `fetch` implementation (global fetch unavailable).',
    );
  }

  const language = config.language ?? DEFAULT_LANGUAGE;
  const core = createHttpCore({
    // The token lives only in this header value — never in url/path/logs/errors.
    headers: {
      Authorization: `Bearer ${config.readAccessToken}`,
      Accept: 'application/json',
    },
    fetch: fetchImpl,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    minRequestIntervalMs:
      config.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS,
    backoffBaseMs: config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
    errorFactory: (message, status, endpoint) =>
      new TmdbError(`TMDB ${message}`, status, endpoint),
  });

  const langQuery = `language=${encodeURIComponent(language)}`;

  return {
    async getMovie(tmdbId: number): Promise<TitleMetadata | null> {
      const result = await core.request<TmdbMovieResponse>(
        `/movie/${tmdbId}?${langQuery}`,
      );
      return result === NOT_FOUND ? null : mapMovie(result);
    },

    async getTvShow(tmdbId: number): Promise<TitleMetadata | null> {
      const result = await core.request<TmdbTvResponse>(
        `/tv/${tmdbId}?${langQuery}`,
      );
      return result === NOT_FOUND ? null : mapTvShow(result);
    },

    async getTvSeasonCount(tmdbId: number): Promise<number | null> {
      const result = await core.request<TmdbTvResponse>(
        `/tv/${tmdbId}?${langQuery}`,
      );
      return result === NOT_FOUND ? null : mapTvSeasonCount(result);
    },

    async getWatchProviders(
      tmdbId: number,
      type: TitleType,
    ): Promise<RegionProviders | null> {
      const segment = type === 'movie' ? 'movie' : 'tv';
      const result = await core.request<TmdbWatchProvidersResponse>(
        `/${segment}/${tmdbId}/watch/providers`,
      );
      return result === NOT_FOUND ? null : mapWatchProviders(result);
    },

    async getSeasonEpisodes(
      tmdbId: number,
      seasonNumber: number,
    ): Promise<Episode[] | null> {
      const result = await core.request<TmdbSeasonResponse>(
        `/tv/${tmdbId}/season/${seasonNumber}?${langQuery}`,
      );
      return result === NOT_FOUND
        ? null
        : mapSeasonEpisodes(result, seasonNumber);
    },

    async getRegionWatchProviders(
      region: Region,
    ): Promise<CatalogProvider[] | null> {
      // `region` is an ISO-3166-1 alpha-2 code (same as REGIONS) that maps
      // directly onto the `watch_region` query param. The credential stays in
      // the header (createHttpCore); never in the url.
      const regionQuery = `watch_region=${encodeURIComponent(region)}`;
      const [movie, tv] = await Promise.all([
        core.request<TmdbWatchProviderListResponse>(
          `/watch/providers/movie?${regionQuery}`,
        ),
        core.request<TmdbWatchProviderListResponse>(
          `/watch/providers/tv?${regionQuery}`,
        ),
      ]);
      // Per-side 404 → treat that side as []; only both sides 404 → null
      // (mirrors the other methods' 404 → null contract).
      if (movie === NOT_FOUND && tv === NOT_FOUND) return null;
      return mergeCatalogProviders(
        movie === NOT_FOUND ? [] : (movie.results ?? []),
        tv === NOT_FOUND ? [] : (tv.results ?? []),
      );
    },
  };
}
