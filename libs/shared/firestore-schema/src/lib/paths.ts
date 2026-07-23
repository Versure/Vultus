// SDK-agnostic Firestore path builders (PLAN §4). Each returns a plain `string`
// path — slices feed it into their own SDK's doc()/collection(). Document paths
// have an even segment count, collection paths an odd count. No firebase/SDK import.

import type { Region } from '@vultus/shared/domain';

// Collection-id segment constants (single source for the path structure).
export const COLLECTIONS = {
  users: 'users',
  watchlist: 'watchlist',
  episodes: 'episodes',
  notifications: 'notifications',
  titleCache: 'title-cache',
  availability: 'availability',
  syncRuns: 'sync-runs',
  providerCatalog: 'provider-catalog',
} as const;

// Tiny private joiner — no leading/trailing slash, segments joined by '/'.
function join(...segments: string[]): string {
  return segments.join('/');
}

// users/{userId}
export function userPath(userId: string): string {
  return join(COLLECTIONS.users, userId);
}

// users/{userId}/watchlist           (collection)
export function watchlistPath(userId: string): string {
  return join(userPath(userId), COLLECTIONS.watchlist);
}
// users/{userId}/watchlist/{titleId}
export function watchlistItemPath(userId: string, titleId: string): string {
  return join(watchlistPath(userId), titleId);
}

// users/{userId}/watchlist/{titleId}/episodes            (collection)
export function episodesPath(userId: string, titleId: string): string {
  return join(watchlistItemPath(userId, titleId), COLLECTIONS.episodes);
}
// users/{userId}/watchlist/{titleId}/episodes/{episodeId}
export function episodePath(
  userId: string,
  titleId: string,
  episodeId: string,
): string {
  return join(episodesPath(userId, titleId), episodeId);
}

// users/{userId}/notifications                 (collection)
export function notificationsPath(userId: string): string {
  return join(userPath(userId), COLLECTIONS.notifications);
}
// users/{userId}/notifications/{notificationId}
export function notificationPath(
  userId: string,
  notificationId: string,
): string {
  return join(notificationsPath(userId), notificationId);
}

// title-cache              (collection)
export function titleCachePath(): string {
  return COLLECTIONS.titleCache;
}
// title-cache/{tmdbId} — document id is the tmdb id (PLAN §4)
export function titleCacheDocPath(tmdbId: number): string {
  return join(titleCachePath(), String(tmdbId));
}

// title-cache/{tmdbId}/availability            (collection)
export function availabilityPath(tmdbId: number): string {
  return join(titleCacheDocPath(tmdbId), COLLECTIONS.availability);
}
// title-cache/{tmdbId}/availability/{region}   — region is a domain Region
export function availabilityDocPath(tmdbId: number, region: Region): string {
  return join(availabilityPath(tmdbId), region);
}

// title-cache/{tmdbId}/episodes                (collection) — global episode cache (tv only, spec 0101)
export function titleCacheEpisodesPath(tmdbId: number): string {
  return join(titleCacheDocPath(tmdbId), COLLECTIONS.episodes);
}
// title-cache/{tmdbId}/episodes/{episodeId}    — episodeId = s{SS}e{EEE}
export function titleCacheEpisodeDocPath(
  tmdbId: number,
  episodeId: string,
): string {
  return join(titleCacheEpisodesPath(tmdbId), episodeId);
}

// provider-catalog              (collection)
export function providerCatalogPath(): string {
  return COLLECTIONS.providerCatalog;
}
// provider-catalog/{region} — document id is the domain Region code (spec 0060)
export function providerCatalogDocPath(region: Region): string {
  return join(providerCatalogPath(), region);
}

// sync-runs                 (collection)
export function syncRunsCollection(): string {
  return COLLECTIONS.syncRuns;
}
// sync-runs/{runId} — document id is the run id (== runId field; PLAN §4)
export function syncRunDocPath(runId: string): string {
  return join(syncRunsCollection(), runId);
}
