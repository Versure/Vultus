import { InjectionToken } from '@angular/core';
import type { TmdbSearchConfig } from './tmdb-search.client';

/**
 * The TMDB client configuration (base URLs + auth), provided at the app root
 * by `apps/mobile` from `environment.tmdb`. Slices inject this token rather
 * than reading `environment` directly (which would cross the Sheriff boundary).
 */
export const TMDB_SEARCH_CONFIG = new InjectionToken<TmdbSearchConfig>(
  'TMDB_SEARCH_CONFIG',
);
