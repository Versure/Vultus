// Compile-time type-assertions. This is a regular lib SOURCE file (not a
// .spec.ts), so it is compiled by the `typecheck` target
// (`tsc --noEmit -p tsconfig.lib.json`) — the real enforcement gate. A false
// assertion here makes `typecheck` fail. It is intentionally NOT re-exported
// from index.ts; it exists solely so its type errors surface under typecheck.
//
// No Firebase import, no runtime behavior.

import {
  NOTIFICATION_KINDS,
  REGIONS,
  WATCH_STATUSES,
  type NotificationKind,
  type Region,
  type WatchStatus,
} from './enums';
import type { Title } from './entities';
import type {
  EpisodeDoc,
  NotificationDoc,
  RegionAvailability,
  TitleCacheEntry,
  User,
  WatchlistItem,
} from './documents';

// Bidirectional equality helper: resolves to `true` only when A and B are
// mutually assignable; otherwise resolves to `never`, turning the `= true`
// assignment below into a compile error.
type AssertEqual<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

// Each union must equal the type derived from its const array.
const _watchEq: AssertEqual<WatchStatus, (typeof WATCH_STATUSES)[number]> =
  true;
const _regionEq: AssertEqual<Region, (typeof REGIONS)[number]> = true;
const _kindEq: AssertEqual<
  NotificationKind,
  (typeof NOTIFICATION_KINDS)[number]
> = true;

// Exhaustive `never` switch over each union — catches a union member added
// without a corresponding array entry.
function assertWatchExhaustive(s: WatchStatus): void {
  switch (s) {
    case 'watching':
    case 'completed':
    case 'dropped':
    case 'planned':
      return;
    default: {
      const _never: never = s;
      return _never;
    }
  }
}

function assertRegionExhaustive(r: Region): void {
  switch (r) {
    case 'NL':
    case 'DE':
    case 'GB':
    case 'US':
    case 'FR':
    case 'BE':
    case 'ES':
    case 'IT':
    case 'CA':
    case 'AU':
      return;
    default: {
      const _never: never = r;
      return _never;
    }
  }
}

function assertKindExhaustive(k: NotificationKind): void {
  switch (k) {
    case 'episode-aired':
    case 'movie-available':
    case 'show-came-to-platform':
      return;
    default: {
      const _never: never = k;
      return _never;
    }
  }
}

// Reverse direction: every array entry must be a member of the union — catches
// an array entry with no union member.
const _regionsLiteral = [...REGIONS] satisfies Region[];
const _statusesLiteral = [...WATCH_STATUSES] satisfies WatchStatus[];
const _kindsLiteral = [...NOTIFICATION_KINDS] satisfies NotificationKind[];

// Representative document literals — prove the shapes compile and that
// timestamps accept ISO strings.
const _user = {
  region: 'NL',
  notificationPrefs: {
    episodeAired: true,
    movieAvailable: false,
    cameToPlatform: true,
    deliveryHour: null,
  },
  fcmTokens: [
    { token: 'abc', deviceId: 'dev-1', createdAt: '2026-06-18T10:00:00.000Z' },
  ],
} satisfies User;

const _watchlistItem = {
  type: 'tv',
  tmdbId: 1399,
  traktId: null,
  title: 'Game of Thrones',
  addedAt: '2026-06-18T10:00:00.000Z',
  status: 'watching',
} satisfies WatchlistItem;

const _episodeDoc = {
  season: 1,
  episode: 1,
  title: 'Winter Is Coming',
  airDate: '2011-04-17T00:00:00.000Z',
  watched: true,
  watchedAt: '2026-06-18T10:00:00.000Z',
} satisfies EpisodeDoc;

const _episodeDocUnwatched = {
  season: 1,
  episode: 2,
  title: null,
  airDate: '2011-04-24T00:00:00.000Z',
  watched: false,
  watchedAt: null,
} satisfies EpisodeDoc;

const _notificationDoc = {
  titleId: 'tmdb-1399',
  kind: 'show-came-to-platform',
  payload: {
    tmdbId: 1399,
    titleId: 'tmdb-1399',
    title: 'Game of Thrones',
    region: 'NL',
    providerName: 'Netflix',
  },
  sentAt: '2026-06-18T10:00:00.000Z',
  readAt: null,
} satisfies NotificationDoc;

const _titleCacheEntry = {
  type: 'movie',
  traktId: null,
  metadata: {
    title: 'Dune',
    overview: 'A noble family...',
    posterPath: '/poster.jpg',
    releaseDate: '2021-10-22T00:00:00.000Z',
  },
  lastSyncedAt: '2026-06-18T10:00:00.000Z',
} satisfies TitleCacheEntry;

const _regionAvailability = {
  providers: [{ providerId: 8, name: 'Netflix', type: 'flatrate' }],
  lastSyncedAt: '2026-06-18T10:00:00.000Z',
  previousSnapshot: [],
} satisfies RegionAvailability;

// Title narrows on `type`.
function assertTitleNarrows(t: Title): string {
  switch (t.type) {
    case 'movie':
      return t.title;
    case 'tv':
      return t.title;
    default: {
      const _never: never = t;
      return _never;
    }
  }
}

// Reference the bindings so noUnusedLocals (if enabled) stays quiet; this file
// is purely a type gate.
export const __TYPE_ASSERTIONS__ = [
  _watchEq,
  _regionEq,
  _kindEq,
  assertWatchExhaustive,
  assertRegionExhaustive,
  assertKindExhaustive,
  _regionsLiteral,
  _statusesLiteral,
  _kindsLiteral,
  _user,
  _watchlistItem,
  _episodeDoc,
  _episodeDocUnwatched,
  _notificationDoc,
  _titleCacheEntry,
  _regionAvailability,
  assertTitleNarrows,
] as const;
