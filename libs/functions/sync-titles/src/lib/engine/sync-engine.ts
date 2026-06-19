// The sync engine: one factory, one method. Orchestrates the injected TMDB +
// Trakt clients and the injected TitleCacheStore port to refresh `title-cache`
// metadata + per-region availability and detect provider transitions against
// the previous snapshot. Firebase-free — it speaks only domain types through
// the port. Writes NO notifications and NO episodes (hard boundary).

import type { Region, WatchProvider } from '@vultus/shared/domain';
import { TmdbError } from '../tmdb/tmdb-error';
import { TraktError } from '../trakt/trakt-error';
import { detectTransitions } from './transitions';
import type {
  ProviderTransition,
  SyncEngine,
  SyncEngineConfig,
  SyncResult,
  SyncTitleInput,
} from './types';

const DEFAULT_NOW = (): string => new Date().toISOString();

export function createSyncEngine(config: SyncEngineConfig): SyncEngine {
  const { tmdb, trakt, store } = config;
  const now = config.now ?? DEFAULT_NOW;

  async function syncOne(title: SyncTitleInput): Promise<SyncResult> {
    const { tmdbId, type } = title;
    try {
      // 1. Metadata fetch — 404 → null → clean skip, no write.
      const metadata =
        type === 'movie'
          ? await tmdb.getMovie(tmdbId)
          : await tmdb.getTvShow(tmdbId);
      if (metadata === null) {
        return {
          tmdbId,
          type,
          outcome: 'skipped',
          transitions: [],
          reason: 'title not found in TMDB',
        };
      }

      // 2. Trakt id (tv only). Movies never call getShowTraktId.
      const traktId = type === 'tv' ? await trakt.getShowTraktId(tmdbId) : null;

      // 3. Write the refreshed entry.
      await store.putEntry(tmdbId, {
        type,
        traktId,
        metadata,
        lastSyncedAt: now(),
      });

      // 4. Availability fetch + per-region transition detection.
      const regionProviders = await tmdb.getWatchProviders(tmdbId, type);
      if (regionProviders === null) {
        return {
          tmdbId,
          type,
          outcome: 'synced',
          transitions: [],
          reason: 'no watch providers',
        };
      }

      const stored = await store.getAvailability(tmdbId);
      const transitions: ProviderTransition[] = [];

      for (const key of Object.keys(regionProviders)) {
        const region = key as Region;
        const next: WatchProvider[] = regionProviders[region] ?? [];
        // The diff baseline is the stored CURRENT providers (NOT the stored
        // previousSnapshot); absent → []. The new previousSnapshot is rolled to
        // be exactly this prior `providers`.
        const prev: WatchProvider[] = stored[region]?.providers ?? [];

        transitions.push(...detectTransitions(region, prev, next));

        await store.putAvailability(tmdbId, region, {
          providers: next,
          previousSnapshot: prev,
          lastSyncedAt: now(),
        });
      }

      return { tmdbId, type, outcome: 'synced', transitions };
    } catch (err) {
      // Per-title error isolation: catch any throw, record it, keep the batch
      // going. Capture status from a Tmdb/Trakt error; never embed a credential.
      const result: SyncResult = {
        tmdbId,
        type,
        outcome: 'error',
        transitions: [],
        reason: errorReason(err),
      };
      if (err instanceof TmdbError || err instanceof TraktError) {
        result.errorStatus = err.status;
      }
      return result;
    }
  }

  return {
    async sync(titles: SyncTitleInput[]): Promise<SyncResult[]> {
      const results: SyncResult[] = [];
      for (const title of titles) {
        results.push(await syncOne(title));
      }
      return results;
    },
  };
}

function errorReason(err: unknown): string {
  if (err instanceof TmdbError || err instanceof TraktError) {
    return `${err.name} (status ${err.status})`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return 'unknown error';
}
