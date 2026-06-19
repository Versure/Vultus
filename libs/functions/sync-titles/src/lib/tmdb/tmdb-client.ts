// Typed TMDB v3 client. Wires the http core + mappers into four methods, all
// with 404 → null semantics. Auth is an injected v4 read-access bearer token;
// the client never reads it from env/secret.

import type {
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
} from './tmdb-mappers';
import { TmdbError } from './tmdb-error';
import type {
  TmdbMovieResponse,
  TmdbSeasonResponse,
  TmdbTvResponse,
  TmdbWatchProvidersResponse,
} from './tmdb-dtos';

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
  /** 429 retry cap; default 3. */
  maxRetries?: number;
  /** Throttle floor between requests in ms; default 250. */
  minRequestIntervalMs?: number;
}

export interface TmdbClient {
  getMovie(tmdbId: number): Promise<TitleMetadata | null>;
  getTvShow(tmdbId: number): Promise<TitleMetadata | null>;
  getWatchProviders(
    tmdbId: number,
    type: TitleType,
  ): Promise<RegionProviders | null>;
  getSeasonEpisodes(
    tmdbId: number,
    seasonNumber: number,
  ): Promise<Episode[] | null>;
}

const DEFAULT_BASE_URL = 'https://api.themoviedb.org/3';
const DEFAULT_LANGUAGE = 'en-US';
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 250;

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
  };
}
