// Typed Watchmode v1 client. Mirrors the TMDB client shape: injected apiKey,
// injectable `fetch`, the shared in-slice http core, 404 → null, WatchmodeError
// on any other non-2xx. The one auth difference from TMDB: Watchmode
// authenticates via an `?apiKey=…` QUERY param, so the key is passed to the
// http core as `authQuery` (appended to the fetch URL, EXCLUDED from the error
// endpoint/logs — see shared/http.ts). The client NEVER reads the key from
// env/secret; the composition root injects it.

import type { Region, TitleType } from '@vultus/shared/domain';
import { createHttpCore, NOT_FOUND } from '../shared/http';
import { WatchmodeError } from './watchmode-error';
import type {
  WatchmodeSearchResponse,
  WatchmodeSourceDto,
} from './watchmode-dtos';
import {
  mapSearchToWatchmodeId,
  mapSourcesDtoToWatchmodeSources,
} from './watchmode-mappers';

export interface WatchmodeClientConfig {
  /** Watchmode API key, sent as the `apiKey` query param. INJECTED by the
   *  caller — the client NEVER reads it from env/secret. */
  apiKey: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Defaults to 'https://api.watchmode.com/v1'. */
  baseUrl?: string;
  /** 429 retry cap; default 5. */
  maxRetries?: number;
  /** Throttle floor between requests in ms; default 250. */
  minRequestIntervalMs?: number;
  /** Base (ms) for the exponential backoff floor on a `429` retry; default 500. */
  backoffBaseMs?: number;
}

/** One raw Watchmode source row (post-DTO map): the Watchmode source_id, its
 *  availability bucket, and the region it applies to (filtered to REGIONS). */
export interface WatchmodeSource {
  /** Watchmode source_id — NOT a TMDB providerId; resolved via the crosswalk. */
  sourceId: number;
  type: 'sub' | 'rent' | 'buy' | 'free';
  region: Region;
}

export interface WatchmodeClient {
  /** Resolve the Watchmode title id from a TMDB id via `/search/`
   *  (search_field = tmdb_movie_id | tmdb_tv_id). No match / 404 → null. */
  resolveTitleId(tmdbId: number, type: TitleType): Promise<number | null>;
  /** Fetch the title's sources for the given regions via
   *  `/title/{watchmodeId}/sources/?regions={csv}`. Returns the mapped rows
   *  (regions filtered to REGIONS); 404 → null. */
  getTitleSources(
    watchmodeId: number,
    regions: Region[],
  ): Promise<WatchmodeSource[] | null>;
}

const DEFAULT_BASE_URL = 'https://api.watchmode.com/v1';
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 250;
const DEFAULT_BACKOFF_BASE_MS = 500;

export function createWatchmodeClient(
  config: WatchmodeClientConfig,
): WatchmodeClient {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'WatchmodeClient requires a `fetch` implementation (global fetch unavailable).',
    );
  }

  const core = createHttpCore({
    // Watchmode has no auth header — the credential rides the query string via
    // `authQuery`, which the http core appends to the fetch URL but keeps OUT
    // of the error endpoint/logs.
    headers: { Accept: 'application/json' },
    authQuery: { apiKey: config.apiKey },
    fetch: fetchImpl,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    minRequestIntervalMs:
      config.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS,
    backoffBaseMs: config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
    errorFactory: (message, status, endpoint) =>
      new WatchmodeError(`Watchmode ${message}`, status, endpoint),
  });

  return {
    async resolveTitleId(
      tmdbId: number,
      type: TitleType,
    ): Promise<number | null> {
      const searchField = type === 'movie' ? 'tmdb_movie_id' : 'tmdb_tv_id';
      const result = await core.request<WatchmodeSearchResponse>(
        `/search/?search_field=${searchField}&search_value=${tmdbId}`,
      );
      return result === NOT_FOUND ? null : mapSearchToWatchmodeId(result);
    },

    async getTitleSources(
      watchmodeId: number,
      regions: Region[],
    ): Promise<WatchmodeSource[] | null> {
      const regionsCsv = regions.map((r) => encodeURIComponent(r)).join(',');
      const result = await core.request<WatchmodeSourceDto[]>(
        `/title/${watchmodeId}/sources/?regions=${regionsCsv}`,
      );
      return result === NOT_FOUND
        ? null
        : mapSourcesDtoToWatchmodeSources(result ?? []);
    },
  };
}
