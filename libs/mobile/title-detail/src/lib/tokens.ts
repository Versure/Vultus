import { InjectionToken } from '@angular/core';
import type { TmdbDetailConfig } from './tmdb-detail.client';

/**
 * The TMDB detail client configuration (base URLs + auth), provided at the app
 * root by `apps/mobile` from `environment.tmdb` — the SAME value the search
 * slice's `TMDB_SEARCH_CONFIG` receives. Slices inject this token rather than
 * reading `environment` directly (which would cross the Sheriff boundary).
 *
 * Keeping `TMDB_SEARCH_CONFIG` and `TMDB_DETAIL_CONFIG` as separate tokens
 * preserves slice isolation (neither slice imports the other's token) at the
 * cost of one extra one-line root provider.
 */
export const TMDB_DETAIL_CONFIG = new InjectionToken<TmdbDetailConfig>(
  'TMDB_DETAIL_CONFIG',
);
