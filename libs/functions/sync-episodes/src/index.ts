// @vultus/functions/sync-episodes — public surface. The Firebase-free
// episode-upsert engine (spec 0047): its factory, contract types, the episode
// id/doc helpers, and the ports that `apps/functions` wires to the Admin SDK +
// the sync-titles TmdbClient. No SDK and no `slice:sync-titles` import crosses
// this barrel.

export { createEpisodeSyncEngine } from './lib/engine/episode-sync-engine';
export { createEpisodeCacheEngine } from './lib/engine/episode-cache-engine';
export type {
  EpisodeSyncEngine,
  EpisodeSyncConfig,
  EpisodeUpsertResult,
  EpisodeCacheEngine,
  EpisodeCacheEngineConfig,
  CacheShowResult,
} from './lib/engine/types';

export { episodeId, newEpisodeDoc } from './lib/engine/episode-id';

export type {
  TmdbEpisodeSource,
  EpisodeStore,
  TitleCacheEpisodeStore,
  WatchlistTvSource,
  WatchlistTvShow,
  WatchlistDocRef,
  WatchlistStatusStore,
  WatchlistNextWatchableStore,
} from './lib/ports';
