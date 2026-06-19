// Public contract types for the sync engine: the per-title input, the factory
// config (injected clients + store + clock), the engine surface, and the
// structured per-title result + transition types. All domain-typed and
// Firebase-free.

import type {
  Region,
  TitleType,
  WatchProviderType,
} from '@vultus/shared/domain';
import type { TmdbClient } from '../tmdb/tmdb-client';
import type { TraktClient } from '../trakt/trakt-client';
import type { TitleCacheStore } from './store';

/** One title to sync. The engine does NOT know the watchlist — the caller (#12)
 *  supplies the tracked titles. */
export interface SyncTitleInput {
  tmdbId: number;
  type: TitleType;
}

export interface SyncEngineConfig {
  /** TMDB client (getMovie / getTvShow / getWatchProviders). */
  tmdb: TmdbClient;
  /** Trakt client (getShowTraktId — tv only). */
  trakt: TraktClient;
  /** Domain-typed persistence port; the engine never imports a Firebase SDK. */
  store: TitleCacheStore;
  /** Injectable clock for deterministic `lastSyncedAt`. Default
   *  `() => new Date().toISOString()`. */
  now?: () => string;
}

export interface SyncEngine {
  /** Run one sync pass over the supplied titles. Per-title failures are
   *  isolated — one title's error never aborts the batch. */
  sync(titles: SyncTitleInput[]): Promise<SyncResult[]>;
}

/** One provider's change in one region during a sync pass. */
export interface ProviderTransition {
  region: Region;
  providerId: number;
  name: string;
  type: WatchProviderType;
  /** 'added'  = present now, absent in previousSnapshot (newly available);
   *  'removed' = absent now, present in previousSnapshot (gone). */
  kind: 'added' | 'removed';
}

export type SyncOutcome = 'synced' | 'skipped' | 'error';

export interface SyncResult {
  tmdbId: number;
  type: TitleType;
  outcome: SyncOutcome;
  /** Region transitions detected this pass (empty when nothing changed or on
   *  skip/error). Drives no notifications here — for diagnostics and #12/#14. */
  transitions: ProviderTransition[];
  /** Set when outcome === 'skipped' (e.g. TMDB 404 → metadata null) or
   *  'error'. A human-readable reason; never embeds a credential. */
  reason?: string;
  /** Set when outcome === 'error': the caught error's status if it is a
   *  TmdbError/TraktError (for diagnostics). */
  errorStatus?: number;
}
