// @vultus/functions/sync-titles — public surface. Exposes the TMDB client
// (spec 0006) and the Trakt calendar client (spec 0007): their factories,
// config/contract types, and the slice-internal errors. Internal DTOs and the
// http/mapper internals are intentionally NOT exported.

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
