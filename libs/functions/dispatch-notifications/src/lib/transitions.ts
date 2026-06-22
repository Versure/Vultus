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
 * Decide the notification kinds for a change. Availability kinds fire only on
 * an 'appeared' transition (decision 1C: 'removed' notifies nothing). The
 * episode-aired kind is orthogonal: it fires for tv titles that are currently
 * on flatrate with at least one episode whose air date is at or before `now`,
 * regardless of the transition. Movies never yield 'episode-aired'.
 */
export function decideKinds(input: {
  type: TitleType;
  transition: FlatrateTransition;
  hasFlatrateNow: boolean;
  episodeAirDates: string[]; // ISO 8601
  now: string; // ISO 8601
}): NotificationKind[] {
  const kinds: NotificationKind[] = [];

  if (input.transition === 'appeared') {
    if (input.type === 'movie') {
      kinds.push('movie-available');
    } else {
      kinds.push('show-came-to-platform');
    }
  }

  if (
    input.type === 'tv' &&
    input.hasFlatrateNow &&
    input.episodeAirDates.some((airDate) => airDate <= input.now)
  ) {
    kinds.push('episode-aired');
  }

  return kinds;
}
