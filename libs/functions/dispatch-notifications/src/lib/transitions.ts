// Pure transition logic — no I/O, no Firebase. Decides which notification kinds
// a flatrate-availability change warrants. The heart of the slice's testable
// behaviour (PLAN §5 unit pyramid).

import type {
  NotificationKind,
  TitleType,
  WatchProvider,
} from '@vultus/shared/domain';

export type FlatrateTransition = 'appeared' | 'removed' | 'unchanged';

function flatrateCount(providers: WatchProvider[]): number {
  return providers.filter((p) => p.type === 'flatrate').length;
}

/**
 * Classify the flatrate transition between two provider snapshots. Only
 * flatrate providers count — rent/buy changes never affect the transition.
 * `0 → ≥1` = 'appeared'; `≥1 → 0` = 'removed'; otherwise 'unchanged'.
 */
export function classifyFlatrateTransition(
  previous: WatchProvider[],
  next: WatchProvider[],
): FlatrateTransition {
  const before = flatrateCount(previous);
  const after = flatrateCount(next);
  if (before === 0 && after >= 1) return 'appeared';
  if (before >= 1 && after === 0) return 'removed';
  return 'unchanged';
}

/** True if `next` has at least one flatrate provider. */
export function hasFlatrate(next: WatchProvider[]): boolean {
  return flatrateCount(next) >= 1;
}

/**
 * Decide the notification kinds for an availability change. An 'appeared'
 * transition yields 'movie-available' (movie) or 'show-came-to-platform' (tv);
 * a 'removed' transition yields 'movie-leaving-platform' (movie) or
 * 'show-leaving-platform' (tv) — reinstating removal notifications behind a
 * per-kind opt-in (spec 0057, reopening spec 0012 decision 1C).
 *
 * `episode-aired` is NOT emitted here (spec 0089 / D3): it is owned
 * exclusively by the daily airing-scan (`dispatchEpisodeAired`), driven by an
 * episode actually crossing into the recency window rather than by an
 * availability write. The availability path no longer reads episodes.
 */
export function decideKinds(input: {
  type: TitleType;
  transition: FlatrateTransition;
}): NotificationKind[] {
  const kinds: NotificationKind[] = [];

  if (input.transition === 'appeared') {
    if (input.type === 'movie') {
      kinds.push('movie-available');
    } else {
      kinds.push('show-came-to-platform');
    }
  }

  if (input.transition === 'removed') {
    kinds.push(
      input.type === 'movie'
        ? 'movie-leaving-platform'
        : 'show-leaving-platform',
    );
  }

  return kinds;
}

/**
 * True when `airDate` is within `[now - windowDays, now]` (inclusive). ISO 8601
 * lexical/temporal comparison against a computed lower bound; guards the
 * back-catalog storm on a user's first add (spec 0089 / D3). A future `airDate`
 * (`> now`) is out of window (false); an `airDate` exactly at `now` or exactly
 * at the lower bound `now - windowDays` is in window (true).
 */
export function isEpisodeRecentlyAired(
  airDate: string,
  now: string,
  windowDays: number,
): boolean {
  const nowMs = new Date(now).getTime();
  const airMs = new Date(airDate).getTime();
  const lowerMs = nowMs - windowDays * 24 * 60 * 60 * 1000;
  return airMs >= lowerMs && airMs <= nowMs;
}

/**
 * True when an FCM push is allowed now for this delivery-hour preference.
 * null = any time. Compares the user's chosen UTC hour to `now`'s UTC hour.
 *
 * `== null` (not `=== null`) is intentional: it catches both `null` and
 * `undefined`, so legacy docs whose `deliveryHour` is absent are treated as
 * "any time".
 */
export function isWithinDeliveryWindow(
  deliveryHour: number | null,
  now: Date,
): boolean {
  return deliveryHour == null || now.getUTCHours() === deliveryHour;
}
