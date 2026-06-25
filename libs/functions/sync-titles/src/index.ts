// @vultus/functions/sync-titles — public surface. Exposes the TMDB client
// (spec 0006), the Trakt calendar client (spec 0007), and the title-cache sync
// engine (spec 0008): their factories, config/contract types, and the
// slice-internal errors. Internal DTOs and the http/mapper internals are
// intentionally NOT exported.

export { createTmdbClient } from './lib/tmdb/tmdb-client';
export type {
  TmdbClientConfig,
  TmdbClient,
  RegionProviders,
} from './lib/tmdb/tmdb-client';
export { TmdbError } from './lib/tmdb/tmdb-error';

export { createTraktClient } from './lib/trakt/trakt-client';
export type {
  TraktClientConfig,
  TraktClient,
  TraktCalendarEntry,
} from './lib/trakt/trakt-client';
export { TraktError } from './lib/trakt/trakt-error';

export { createSyncEngine } from './lib/engine/sync-engine';
export type { TitleCacheStore } from './lib/engine/store';
export type {
  SyncEngine,
  SyncEngineConfig,
  SyncTitleInput,
  SyncResult,
  ProviderTransition,
  SyncOutcome,
} from './lib/engine/types';

// The Admin-SDK adapter that implements the engine's TitleCacheStore port
// against firebase-admin Firestore (spec 0009). This is the only SDK-bound
// export; the engine itself stays Firebase-free.
export { createFirestoreTitleCacheStore } from './lib/store/firestore-title-cache-store';

// Per-user watchlist gather for the manual `triggerSync` callable (spec 0025):
// reads ONE user's `users/{uid}/watchlist` and projects to distinct
// `{ tmdbId, type }`. Consumed by `apps/functions` `triggerSync`.
export { gatherUserWatchlistTitles } from './lib/gather/user-gather';
export type { GatheredUserTitle } from './lib/gather/user-gather';
