// The sync engine: one factory, one method. Orchestrates the injected TMDB
// client and the injected TitleCacheStore port to refresh `title-cache`
// metadata + per-region availability and detect provider transitions against
// the previous snapshot. Firebase-free — it speaks only domain types through
// the port. Writes NO notifications and NO episodes (hard boundary).

import {
  REGIONS,
  type Region,
  type WatchProvider,
} from '@vultus/shared/domain';
import { TmdbError } from '../tmdb/tmdb-error';
import { mapSourcesToFlatrateProviders } from '../watchmode/watchmode-mappers';
import { WATCHMODE_TO_TMDB_PROVIDER } from '../watchmode/watchmode-provider-map';
import { detectTransitions } from './transitions';
import type {
  ProviderTransition,
  SyncEngine,
  SyncEngineConfig,
  SyncResult,
  SyncTitleInput,
} from './types';

const DEFAULT_NOW = (): string => new Date().toISOString();

const REGION_SET = new Set<string>(REGIONS);

// Dedupe a provider list by providerId, keeping the FIRST occurrence. The
// engine passes TMDB entries first so they always win over a same-providerId
// Watchmode fill (decision 1: Watchmode never overrides/removes TMDB).
function dedupeByProviderId(list: WatchProvider[]): WatchProvider[] {
  const seen = new Set<number>();
  const out: WatchProvider[] = [];
  for (const p of list) {
    if (seen.has(p.providerId)) continue;
    seen.add(p.providerId);
    out.push(p);
  }
  return out;
}

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
  const { tmdb, store } = config;
  const watchmode = config.watchmode;
  const activeRegions = (config.activeRegions ?? []).filter((r) =>
    REGION_SET.has(r),
  );
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

      // 2. Load the cached entry only when a configured Watchmode fallback needs
      // it (watchmodeId reuse/preserve). With no Watchmode client the entry is
      // never read — byte-for-byte today.
      const cachedEntry = watchmode ? await store.getEntry(tmdbId) : null;

      // 3. Write the refreshed entry, preserving any cached Watchmode id so it
      // is not erased (the converter coalesces a missing watchmodeId → null).
      const entrySyncedAt = now();
      let watchmodeId = cachedEntry?.watchmodeId ?? null;
      await store.putEntry(tmdbId, {
        type,
        metadata,
        lastSyncedAt: entrySyncedAt,
        watchmodeId,
      });

      // 4. Availability fetch + per-region transition detection. A null TMDB
      // provider block (404 / no block) is treated as an EMPTY region map (the
      // former early return is gone) so a fully-null title is still a Watchmode
      // gap candidate for its active regions (spec 0099).
      const regionProviders = await tmdb.getWatchProviders(tmdbId, type);
      const regions = regionProviders ?? {};
      const stored = await store.getAvailability(tmdbId);
      const transitions: ProviderTransition[] = [];
      let wroteAnyAvailability = false;

      if (!watchmode) {
        // No Watchmode client → behave exactly as today: iterate ONLY the
        // regions TMDB returned; write each as source 'tmdb'. No union
        // expansion, no gap-fill, no carry-forward (graceful no-key degrade).
        for (const key of Object.keys(regions)) {
          if (!REGION_SET.has(key)) continue;
          const region = key as Region;
          const next: WatchProvider[] = regions[region] ?? [];
          const prev: WatchProvider[] = stored[region]?.providers ?? [];
          transitions.push(...detectTransitions(region, prev, next));
          await store.putAvailability(tmdbId, region, {
            providers: next,
            previousSnapshot: prev,
            lastSyncedAt: now(),
            source: 'tmdb',
          });
          wroteAnyAvailability = true;
        }
      } else {
        // Watchmode configured → consider the union of TMDB-returned regions and
        // the active regions, gap-filling active regions with no TMDB flatrate.
        const activeSet = new Set<Region>(activeRegions);
        const regionUnion = new Set<Region>();
        for (const key of Object.keys(regions)) {
          if (REGION_SET.has(key)) regionUnion.add(key as Region);
        }
        for (const region of activeSet) regionUnion.add(region);

        // Gap regions = active regions with NO TMDB flatrate provider.
        const gapRegions: Region[] = [];
        for (const region of regionUnion) {
          const tmdbNext = regions[region] ?? [];
          const hasFlatrate = tmdbNext.some((p) => p.type === 'flatrate');
          if (activeSet.has(region) && !hasFlatrate) gapRegions.push(region);
        }

        // Watchmode fill: one resolveTitleId (only if uncached) + one
        // multi-region getTitleSources. Any throw / null / unresolved id marks
        // Watchmode UNAVAILABLE for ALL gap regions this pass.
        let fill: Partial<Record<Region, WatchProvider[]>> = {};
        let watchmodeUnavailable = false;
        if (gapRegions.length > 0) {
          try {
            if (watchmodeId == null) {
              const resolved = await watchmode.resolveTitleId(tmdbId, type);
              if (resolved != null) {
                watchmodeId = resolved;
                // Persist the resolved id so the next sync skips resolution.
                await store.putEntry(tmdbId, {
                  type,
                  metadata,
                  lastSyncedAt: entrySyncedAt,
                  watchmodeId,
                });
              }
            }
            if (watchmodeId != null) {
              const sources = await watchmode.getTitleSources(
                watchmodeId,
                gapRegions,
              );
              if (sources === null) {
                watchmodeUnavailable = true;
              } else {
                const mapped = mapSourcesToFlatrateProviders(
                  sources,
                  WATCHMODE_TO_TMDB_PROVIDER,
                );
                fill = mapped.fill;
                if (mapped.dropped > 0) {
                  // Decision 3: an unmapped Watchmode source_id is counted, never
                  // guessed. Surface it so crosswalk staleness is diagnosable.
                  console.warn(
                    `[sync-titles] watchmode: dropped ${mapped.dropped} unmapped source_id(s) for tmdbId ${tmdbId}`,
                  );
                }
              }
            } else {
              // resolveTitleId → null (unresolved title id) → unavailable.
              watchmodeUnavailable = true;
            }
          } catch {
            // HTTP error / rate-limited / transport failure → unavailable. The
            // title does NOT error — the fallback degrades to carry-forward.
            watchmodeUnavailable = true;
          }
        }

        const gapSet = new Set<Region>(gapRegions);
        for (const region of regionUnion) {
          const tmdbNext = regions[region] ?? [];
          const prev: WatchProvider[] = stored[region]?.providers ?? [];
          const isGap = gapSet.has(region);

          if (isGap && watchmodeUnavailable) {
            // Transition-safety carry-forward: TMDB empty for an active region
            // AND Watchmode unavailable → SKIP the write entirely so a transient
            // gap does not fire a false 'removed'. The stored providers /
            // previousSnapshot / source carry forward unchanged (spec 0099).
            continue;
          }

          let next: WatchProvider[];
          let source: 'tmdb' | 'watchmode';
          if (isGap) {
            // Watchmode available for this gap region: merge TMDB (winning) with
            // the fill; empty fill = Watchmode CONFIRMED zero flatrate.
            const regionFill = fill[region] ?? [];
            next = dedupeByProviderId([...tmdbNext, ...regionFill]);
            source = regionFill.length > 0 ? 'watchmode' : 'tmdb';
          } else {
            // Non-active region, or active-with-flatrate: exactly as today.
            next = tmdbNext;
            source = 'tmdb';
          }

          transitions.push(...detectTransitions(region, prev, next));
          await store.putAvailability(tmdbId, region, {
            providers: next,
            previousSnapshot: prev,
            lastSyncedAt: now(),
            source,
          });
          wroteAnyAvailability = true;
        }
      }

      // A fully-null TMDB title that wrote nothing (no active region / no fill)
      // reports the unchanged no-fallback outcome.
      if (regionProviders === null && !wroteAnyAvailability) {
        return {
          tmdbId,
          type,
          outcome: 'synced',
          transitions: [],
          reason: 'no watch providers',
        };
      }

      return { tmdbId, type, outcome: 'synced', transitions };
    } catch (err) {
      // Per-title error isolation: catch any throw, record it, keep the batch
      // going. Capture status from a TmdbError; never embed a credential.
      const result: SyncResult = {
        tmdbId,
        type,
        outcome: 'error',
        transitions: [],
        reason: errorReason(err),
      };
      if (err instanceof TmdbError) {
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
  if (err instanceof TmdbError) {
    return `${err.name} (status ${err.status})`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return 'unknown error';
}
