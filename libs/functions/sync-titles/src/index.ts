// @vultus/functions/sync-titles — public surface (spec 0006). Exposes the TMDB
// client factory, its config/contract types, and the slice-internal error.
// Internal DTOs and the http/mapper internals are intentionally NOT exported.

export { createTmdbClient } from './lib/tmdb-client';
export type {
  TmdbClientConfig,
  TmdbClient,
  RegionProviders,
} from './lib/tmdb-client';
export { TmdbError } from './lib/tmdb-error';
