// Pure read/write converters mapping each domain document to/from its Firestore
// wire shape. WRITE: domain ISO string → JS `Date` (Firestore — both SDKs —
// persists a Date as a Timestamp automatically, so this lib never constructs an SDK
// Timestamp). READ: structural FirestoreTimestampLike → ISO string via
// `.toDate().toISOString()`. Nullable timestamps map null → null. Non-timestamp
// fields (providers, previousSnapshot, metadata, payload, notificationPrefs) pass
// straight through; fcmTokens is mapped element-wise. No validation; no firebase/SDK
// import; no SDK Timestamp constructed.

import type {
  Episode,
  EpisodeDoc,
  FcmToken,
  NotificationDoc,
  ProviderCatalogDoc,
  RegionAvailability,
  SyncRun,
  TitleCacheEntry,
  User,
  WatchlistItem,
} from '@vultus/shared/domain';

import type {
  CachedEpisodeReadData,
  CachedEpisodeWriteData,
  EpisodeReadData,
  EpisodeWriteData,
  FcmTokenReadData,
  FcmTokenWriteData,
  NotificationReadData,
  NotificationWriteData,
  ProviderCatalogReadData,
  ProviderCatalogWriteData,
  RegionAvailabilityReadData,
  RegionAvailabilityWriteData,
  SyncRunReadData,
  SyncRunWriteData,
  TitleCacheReadData,
  TitleCacheWriteData,
  UserReadData,
  UserWriteData,
  WatchlistItemReadData,
  WatchlistItemWriteData,
} from './data-types';

// --- User ---
export function userToData(user: User): UserWriteData {
  return {
    region: user.region,
    notificationPrefs: user.notificationPrefs,
    fcmTokens: user.fcmTokens.map(fcmTokenToData),
    myProviderIds: user.myProviderIds,
    hasPlex: user.hasPlex,
    // Plain nested object of ISO strings — passes through like notificationPrefs;
    // never-linked/unlinked coalesces to null (spec 0073).
    plexSync: user.plexSync ?? null,
  };
}
export function dataToUser(data: UserReadData): User {
  return {
    region: data.region,
    notificationPrefs: {
      episodeAired: data.notificationPrefs.episodeAired,
      movieAvailable: data.notificationPrefs.movieAvailable,
      cameToPlatform: data.notificationPrefs.cameToPlatform,
      // Legacy docs (pre-0057) lack these per-kind opt-ins; coalesce missing →
      // true (opt-out default: existing users receive the new alerts unless
      // they turn them off — spec 0057).
      movieLeavingPlatform: data.notificationPrefs.movieLeavingPlatform ?? true,
      showLeavingPlatform: data.notificationPrefs.showLeavingPlatform ?? true,
      // Legacy docs (pre-0051) lack deliveryHour; coalesce missing → null.
      deliveryHour: data.notificationPrefs.deliveryHour ?? null,
    },
    fcmTokens: (data.fcmTokens ?? []).map(dataToFcmToken),
    // Legacy docs (pre-0060) lack myProviderIds; coalesce missing → [].
    myProviderIds: data.myProviderIds ?? [],
    // Legacy docs (pre-0061) lack hasPlex; coalesce missing → false.
    hasPlex: data.hasPlex ?? false,
    // Legacy docs (pre-0073) lack plexSync; coalesce missing → null.
    plexSync: data.plexSync ?? null,
  };
}

function fcmTokenToData(token: FcmToken): FcmTokenWriteData {
  return {
    token: token.token,
    deviceId: token.deviceId,
    createdAt: new Date(token.createdAt),
  };
}
function dataToFcmToken(data: FcmTokenReadData): FcmToken {
  return {
    token: data.token,
    deviceId: data.deviceId,
    createdAt: data.createdAt.toDate().toISOString(),
  };
}

// --- WatchlistItem ---
export function watchlistItemToData(
  item: WatchlistItem,
): WatchlistItemWriteData {
  return {
    type: item.type,
    tmdbId: item.tmdbId,
    traktId: item.traktId,
    title: item.title,
    addedAt: new Date(item.addedAt),
    status: item.status,
    posterPath: item.posterPath ?? null,
    voteAverage: item.voteAverage ?? null,
    releaseDate: item.releaseDate ?? null,
    nextUnwatchedEpisodeAirDate: item.nextUnwatchedEpisodeAirDate ?? null,
    watchingViaPlex: item.watchingViaPlex ?? false,
  };
}
export function dataToWatchlistItem(
  data: WatchlistItemReadData,
): WatchlistItem {
  return {
    type: data.type,
    tmdbId: data.tmdbId,
    traktId: data.traktId,
    title: data.title,
    addedAt: data.addedAt.toDate().toISOString(),
    status: data.status,
    posterPath: data.posterPath ?? null,
    voteAverage: data.voteAverage ?? null,
    releaseDate: data.releaseDate ?? null,
    // Legacy docs (pre-0081) lack nextUnwatchedEpisodeAirDate; coalesce → null.
    nextUnwatchedEpisodeAirDate: data.nextUnwatchedEpisodeAirDate ?? null,
    // Legacy docs (pre-0061) lack watchingViaPlex; coalesce missing → false.
    watchingViaPlex: data.watchingViaPlex ?? false,
  };
}

// --- EpisodeDoc ---
export function episodeToData(ep: EpisodeDoc): EpisodeWriteData {
  return {
    season: ep.season,
    episode: ep.episode,
    title: ep.title ?? null,
    airDate: new Date(ep.airDate),
    watched: ep.watched,
    watchedAt: ep.watchedAt === null ? null : new Date(ep.watchedAt),
  };
}
export function dataToEpisode(data: EpisodeReadData): EpisodeDoc {
  return {
    season: data.season,
    episode: data.episode,
    title: data.title ?? null,
    airDate: data.airDate.toDate().toISOString(),
    watched: data.watched,
    watchedAt:
      data.watchedAt === null ? null : data.watchedAt.toDate().toISOString(),
  };
}

// --- CachedEpisode (title-cache/{tmdbId}/episodes) ---
// Converts the domain `Episode` ({ season, episode, title, airDate }) plus a
// `lastSyncedAt` ISO string into the global-cache wire shape. Both `airDate` and
// `lastSyncedAt` cross the Timestamp boundary exactly as `episodeToData` does for
// `airDate` (ISO string → `Date`; read back via `.toDate().toISOString()`). The
// cache stores ONLY TMDB facts — no per-user `watched`/`watchedAt` (spec 0101).
export function cachedEpisodeToData(
  ep: Episode,
  lastSyncedAt: string,
): CachedEpisodeWriteData {
  return {
    season: ep.season,
    episode: ep.episode,
    title: ep.title,
    airDate: new Date(ep.airDate),
    lastSyncedAt: new Date(lastSyncedAt),
  };
}
export function dataToCachedEpisode(
  data: CachedEpisodeReadData,
): Episode & { lastSyncedAt: string } {
  return {
    season: data.season,
    episode: data.episode,
    title: data.title,
    airDate: data.airDate.toDate().toISOString(),
    lastSyncedAt: data.lastSyncedAt.toDate().toISOString(),
  };
}

// --- NotificationDoc ---
export function notificationToData(n: NotificationDoc): NotificationWriteData {
  return {
    titleId: n.titleId,
    kind: n.kind,
    payload: n.payload,
    sentAt: new Date(n.sentAt),
    readAt: n.readAt === null ? null : new Date(n.readAt),
  };
}
export function dataToNotification(
  data: NotificationReadData,
): NotificationDoc {
  return {
    titleId: data.titleId,
    kind: data.kind,
    payload: data.payload,
    sentAt: data.sentAt.toDate().toISOString(),
    readAt: data.readAt === null ? null : data.readAt.toDate().toISOString(),
  };
}

// --- TitleCacheEntry ---
export function titleCacheToData(t: TitleCacheEntry): TitleCacheWriteData {
  return {
    type: t.type,
    traktId: t.traktId,
    metadata: t.metadata,
    lastSyncedAt: new Date(t.lastSyncedAt),
    // Legacy/unresolved coalesces to null (spec 0099).
    watchmodeId: t.watchmodeId ?? null,
  };
}
export function dataToTitleCache(data: TitleCacheReadData): TitleCacheEntry {
  return {
    type: data.type,
    traktId: data.traktId,
    metadata: data.metadata,
    lastSyncedAt: data.lastSyncedAt.toDate().toISOString(),
    // Legacy docs (pre-0099) lack watchmodeId; coalesce missing → null.
    watchmodeId: data.watchmodeId ?? null,
  };
}

// --- ProviderCatalogDoc ---
export function providerCatalogToData(
  doc: ProviderCatalogDoc,
): ProviderCatalogWriteData {
  return {
    providers: doc.providers,
    lastSyncedAt: new Date(doc.lastSyncedAt),
  };
}
export function dataToProviderCatalog(
  data: ProviderCatalogReadData,
): ProviderCatalogDoc {
  return {
    providers: data.providers,
    lastSyncedAt: data.lastSyncedAt.toDate().toISOString(),
  };
}

// --- SyncRun ---
export function syncRunToData(run: SyncRun): SyncRunWriteData {
  return {
    runId: run.runId,
    kind: run.kind,
    userId: run.userId,
    startedAt: new Date(run.startedAt),
    completedAt: new Date(run.completedAt),
    durationMs: run.durationMs,
    titlesGathered: run.titlesGathered,
    titlesUpdated: run.titlesUpdated,
    errorCount: run.errorCount,
    errors: run.errors,
  };
}
export function dataToSyncRun(data: SyncRunReadData): SyncRun {
  return {
    runId: data.runId,
    kind: data.kind,
    userId: data.userId,
    startedAt: data.startedAt.toDate().toISOString(),
    completedAt: data.completedAt.toDate().toISOString(),
    durationMs: data.durationMs,
    titlesGathered: data.titlesGathered,
    titlesUpdated: data.titlesUpdated,
    errorCount: data.errorCount,
    errors: data.errors,
  };
}

// --- RegionAvailability ---
export function availabilityToData(
  a: RegionAvailability,
): RegionAvailabilityWriteData {
  return {
    providers: a.providers,
    lastSyncedAt: new Date(a.lastSyncedAt),
    previousSnapshot: a.previousSnapshot,
    // Legacy/unmarked coalesces to 'tmdb' (spec 0099).
    source: a.source ?? 'tmdb',
  };
}
export function dataToAvailability(
  data: RegionAvailabilityReadData,
): RegionAvailability {
  return {
    providers: data.providers,
    lastSyncedAt: data.lastSyncedAt.toDate().toISOString(),
    previousSnapshot: data.previousSnapshot,
    // Legacy docs (pre-0099) lack source; coalesce missing → 'tmdb'.
    source: data.source ?? 'tmdb',
  };
}
