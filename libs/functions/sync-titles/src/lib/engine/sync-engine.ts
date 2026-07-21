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

// A per-title error is worth re-attempting only when it is transient: a rate
// limit (429) or a transport/network failure (status 0). A 401/403/5xx/4xx is
// deterministic for the day and must NOT be re-tried.
function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || status === 0;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSyncEngine(config: SyncEngineConfig): SyncEngine {
  const { tmdb, trakt, store } = config;
  const now = config.now ?? DEFAULT_NOW;
  const retryErroredPasses = config.retryErroredPasses ?? 0;
  const retryDelayMs = config.retryDelayMs ?? 0;

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

      // 2. Trakt id (tv only). Movies never call getShowTraktId. A cached,
      // non-null traktId is stable — reuse it and skip the (rate-limited) Trakt
      // call. A null/absent cached traktId still resolves via getShowTraktId.
      let traktId: number | null = null;
      if (type === 'tv') {
        const cached = await store.getEntry(tmdbId);
        // `??` short-circuits: a cached non-null traktId skips the Trakt call.
        traktId = cached?.traktId ?? (await trakt.getShowTraktId(tmdbId));
      }

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

  async function runPass(titles: SyncTitleInput[]): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    for (const title of titles) {
      results.push(await syncOne(title));
    }
    return results;
  }

  return {
    async sync(titles: SyncTitleInput[]): Promise<SyncResult[]> {
      const results = await runPass(titles);

      // Second-pass retry: re-run only the titles whose outcome is a RETRYABLE
      // error (429 / transport), up to `retryErroredPasses` additional passes,
      // sleeping `retryDelayMs` between passes. A later pass's synced/skipped
      // (or newer error) supersedes the earlier error, so each input title still
      // yields exactly one result in input order. Non-retryable errors (e.g.
      // 401) are never re-tried.
      for (let pass = 0; pass < retryErroredPasses; pass += 1) {
        const retryIndices: number[] = [];
        results.forEach((r, i) => {
          if (r.outcome === 'error' && isRetryableStatus(r.errorStatus)) {
            retryIndices.push(i);
          }
        });
        if (retryIndices.length === 0) break;

        await sleep(retryDelayMs);

        const retryResults = await runPass(retryIndices.map((i) => titles[i]));
        retryIndices.forEach((originalIndex, k) => {
          results[originalIndex] = retryResults[k];
        });
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
