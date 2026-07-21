import { InjectionToken } from '@angular/core';
import type { TmdbDetailConfig } from './tmdb-detail.client';

/**
 * The TMDB detail client configuration (base URLs + auth) for the settings
 * slice's Plex-sync poster fetch (spec 0086), provided at the app root by
 * `apps/mobile` from `environment.tmdb` — the SAME value the search slice's
 * `TMDB_SEARCH_CONFIG` and the title-detail slice's `TMDB_DETAIL_CONFIG`
 * receive. Slices inject this token rather than reading `environment` directly
 * (which would cross the Sheriff boundary).
 *
 * Named `SETTINGS_TMDB_CONFIG` (NOT `TMDB_DETAIL_CONFIG`) to avoid a symbol
 * collision with the `TMDB_DETAIL_CONFIG` token already imported into
 * `apps/mobile` `app.config.ts` from `@vultus/mobile/title-detail`. Keeping the
 * tokens separate per slice preserves slice isolation (spec 0016 decision 2) at
 * the cost of one extra one-line root provider.
 */
export const SETTINGS_TMDB_CONFIG = new InjectionToken<TmdbDetailConfig>(
  'SETTINGS_TMDB_CONFIG',
);
