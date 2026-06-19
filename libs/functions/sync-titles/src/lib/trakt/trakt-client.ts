// Typed Trakt API v2 client. Wires the in-slice http core + Trakt mappers into
// two methods. Auth is an injected Client ID (api key) sent as the
// `trakt-api-key` header — the client never reads it from env/secret. No OAuth.
// The all-shows calendar (api-key only) is used; a `404` maps to `[]` for the
// calendar and `null` for the id lookup.

import type { Episode } from '@vultus/shared/domain';
import { createHttpCore, NOT_FOUND } from '../shared/http';
import { TraktError } from './trakt-error';
import { extractShowTraktId, mapCalendar } from './trakt-mappers';
import type { TraktCalendarEntryDto, TraktSearchResultDto } from './trakt-dtos';

/** A single show episode airing in the calendar window. Slice-internal contract
 *  for the sync engine — NOT a `@vultus/shared/domain` type (the domain
 *  `Episode` carries no show identity). */
export interface TraktCalendarEntry {
  /** Trakt show id (the all-shows calendar is keyed by it). */
  traktId: number;
  /** Show's TMDB id from Trakt's `show.ids.tmdb`; null when Trakt has none. */
  tmdbId: number | null;
  /** Show title (diagnostics / fallback display). */
  showTitle: string;
  /** The airing episode as the domain value type. */
  episode: Episode;
}

export interface TraktClientConfig {
  /** Trakt application Client ID, sent as the `trakt-api-key` header.
   *  INJECTED by the caller — the client NEVER reads it from env/secret. */
  clientId: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Defaults to 'https://api.trakt.tv'. */
  baseUrl?: string;
  /** 429 retry cap; default 3. */
  maxRetries?: number;
  /** Throttle floor between requests in ms; default 250. */
  minRequestIntervalMs?: number;
}

export interface TraktClient {
  /** Every show airing in [startDate, startDate + days). Filtering to tracked
   *  titles is the sync engine's job. */
  getCalendar(startDate: string, days: number): Promise<TraktCalendarEntry[]>;
  /** Resolve a TMDB show id to its Trakt show id. No match / 404 → null. */
  getShowTraktId(tmdbId: number): Promise<number | null>;
}

const DEFAULT_BASE_URL = 'https://api.trakt.tv';
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 250;
const TRAKT_API_VERSION = '2';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_DAYS = 1;
const MAX_DAYS = 33;

// `days` is documented max 33; coerce a non-integer via Math.trunc, clamp into
// [1, 33]. The client does NOT inject a default window — the caller passes it.
function clampDays(days: number): number {
  const truncated = Math.trunc(days);
  if (truncated < MIN_DAYS) return MIN_DAYS;
  if (truncated > MAX_DAYS) return MAX_DAYS;
  return truncated;
}

export function createTraktClient(config: TraktClientConfig): TraktClient {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'TraktClient requires a `fetch` implementation (global fetch unavailable).',
    );
  }

  const core = createHttpCore({
    // The client id lives only in this header value — never in url/path/logs/
    // errors. No Authorization header (no OAuth).
    headers: {
      'trakt-api-key': config.clientId,
      'trakt-api-version': TRAKT_API_VERSION,
      'Content-Type': 'application/json',
    },
    fetch: fetchImpl,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    minRequestIntervalMs:
      config.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS,
    errorFactory: (message, status, endpoint) =>
      new TraktError(`Trakt ${message}`, status, endpoint),
  });

  return {
    async getCalendar(
      startDate: string,
      days: number,
    ): Promise<TraktCalendarEntry[]> {
      // Malformed startDate is a programming error, not an HTTP failure — throw
      // a plain TypeError synchronously, BEFORE any fetch.
      if (typeof startDate !== 'string' || !DATE_RE.test(startDate)) {
        throw new TypeError(
          `Invalid startDate: expected YYYY-MM-DD, received "${startDate}".`,
        );
      }
      const clampedDays = clampDays(days);
      const result = await core.request<TraktCalendarEntryDto[]>(
        `/calendars/all/shows/${startDate}/${clampedDays}`,
      );
      // 404 (if Trakt ever returns one for this path) → [].
      return result === NOT_FOUND ? [] : mapCalendar(result);
    },

    async getShowTraktId(tmdbId: number): Promise<number | null> {
      const result = await core.request<TraktSearchResultDto[]>(
        `/search/tmdb/${tmdbId}?type=show`,
      );
      return result === NOT_FOUND ? null : extractShowTraktId(result);
    },
  };
}
