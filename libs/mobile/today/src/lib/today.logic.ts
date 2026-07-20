// Slice-local pure logic for the Watch Today tab (spec 0083). Every function is
// deterministic — "now" is ALWAYS injected as a parameter (never read via
// `new Date()` here) so unit tests need no clock mocking.
//
// D5 date-comparison mechanics (a real correctness trap — follow exactly):
//   - `WatchlistItem.releaseDate` (movies) is a DATE-ONLY ISO string, e.g.
//     '2024-03-15'. It is compared against `todayDateOnly` (YYYY-MM-DD).
//   - `WatchlistItem.nextUnwatchedEpisodeAirDate` and `EpisodeDoc.airDate` (TV)
//     are FULL ISO 8601 datetime strings, e.g. '2026-01-02T00:00:00.000Z'. They
//     are compared against the full `nowISO`.
// The two formats are NEVER conflated here: the caller (`TodayPage`) computes
// both `nowISO` and `todayDateOnly` once and passes them in; these functions do
// a plain lexical string `<=` compare (ISO strings sort correctly as strings —
// the precedented idiom at
// libs/functions/dispatch-notifications/src/lib/transitions.ts).

import type {
  EpisodeDoc,
  RegionAvailability,
  WatchlistItem,
} from '@vultus/shared/domain';

/** Only these statuses are ever considered for the Watch Today tab; dropped and
 *  completed are excluded regardless of date. */
function isConsidered(item: WatchlistItem): boolean {
  return item.status === 'watching' || item.status === 'planned';
}

/**
 * A movie is watchable today iff status ∈ {watching, planned}, `releaseDate` is
 * present (non-null), and `releaseDate <= todayDateOnly` (both DATE-ONLY
 * `YYYY-MM-DD` strings; lexical compare).
 */
export function isMovieWatchableToday(
  item: WatchlistItem,
  todayDateOnly: string,
): boolean {
  if (!isConsidered(item)) {
    return false;
  }
  const releaseDate = item.releaseDate;
  if (releaseDate == null) {
    return false;
  }
  return releaseDate <= todayDateOnly;
}

/**
 * A TV show is watchable today iff status ∈ {watching, planned},
 * `nextUnwatchedEpisodeAirDate` is non-null, and
 * `nextUnwatchedEpisodeAirDate <= nowISO` (both FULL ISO 8601 datetime strings;
 * lexical compare).
 */
export function isTvWatchableToday(
  item: WatchlistItem,
  nowISO: string,
): boolean {
  if (!isConsidered(item)) {
    return false;
  }
  const airDate = item.nextUnwatchedEpisodeAirDate;
  if (airDate == null) {
    return false;
  }
  return airDate <= nowISO;
}

/**
 * Partitions the full item set into the two rendered sections, applying the
 * type-specific gate above. Movies gate on `todayDateOnly` (date-only), TV shows
 * gate on `nowISO` (full datetime); dropped/completed are excluded via the gates.
 */
export function partitionWatchableToday(
  items: WatchlistItem[],
  nowISO: string,
  todayDateOnly: string,
): { movies: WatchlistItem[]; tvShows: WatchlistItem[] } {
  const movies: WatchlistItem[] = [];
  const tvShows: WatchlistItem[] = [];
  for (const item of items) {
    if (item.type === 'movie') {
      if (isMovieWatchableToday(item, todayDateOnly)) {
        movies.push(item);
      }
    } else if (isTvWatchableToday(item, nowISO)) {
      tvShows.push(item);
    }
  }
  return { movies, tvShows };
}

/**
 * Subtitle copy from the TOTAL watchable count (movies + tvShows). EXACT
 * strings: 1 → "1 thing ready to watch"; N (incl. 0) → "N things ready to
 * watch".
 */
export function watchableSubtitle(count: number): string {
  const noun = count === 1 ? 'thing' : 'things';
  return `${count} ${noun} ready to watch`;
}

/**
 * The "S{season}E{episode} available" label for a TV card, from the earliest
 * currently-unwatched episode: min `airDate` via ISO lexical compare, tie-broken
 * by (season, episode) ascending. Season and episode are rendered UNPADDED (e.g.
 * "S3E5 available", NOT "S03E005"). null when there is no unwatched episode.
 */
export function nextEpisodeLabel(episodes: EpisodeDoc[]): string | null {
  let earliest: EpisodeDoc | null = null;
  for (const ep of episodes) {
    if (ep.watched === true) {
      continue;
    }
    if (earliest === null || isEarlier(ep, earliest)) {
      earliest = ep;
    }
  }
  if (earliest === null) {
    return null;
  }
  return `S${earliest.season}E${earliest.episode} available`;
}

/** True when `a` should sort before `b`: min airDate (ISO lexical), tie-broken
 *  by (season, episode) ascending. */
function isEarlier(a: EpisodeDoc, b: EpisodeDoc): boolean {
  if (a.airDate !== b.airDate) {
    return a.airDate < b.airDate;
  }
  if (a.season !== b.season) {
    return a.season < b.season;
  }
  return a.episode < b.episode;
}

/**
 * Slice-local copy of watchlist's `partitionAvailabilityPill` (D3 — DELIBERATE
 * 2-slice duplication, below the PLAN §3 3+-slice extract threshold; do NOT
 * import `@vultus/mobile/watchlist`). Filters to FLATRATE providers only, then:
 *   - `mine` — the first flatrate provider whose id ∈ `myProviderIds`;
 *   - `elsewhere` — else the first flatrate provider;
 *   - `null` — no flatrate provider → no pill.
 */
export type AvailabilityPill =
  | { kind: 'mine'; name: string }
  | { kind: 'elsewhere'; name: string };

export function partitionAvailabilityPill(
  availability: RegionAvailability | null,
  myProviderIds: readonly number[],
): AvailabilityPill | null {
  const flatrate = (availability?.providers ?? []).filter(
    (p) => p.type === 'flatrate',
  );
  if (flatrate.length === 0) {
    return null;
  }
  const mine = flatrate.find((p) => myProviderIds.includes(p.providerId));
  if (mine) {
    return { kind: 'mine', name: mine.name };
  }
  return { kind: 'elsewhere', name: flatrate[0].name };
}
