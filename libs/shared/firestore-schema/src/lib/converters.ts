// Pure read/write converters mapping each domain document to/from its Firestore
// wire shape. WRITE: domain ISO string → JS `Date` (Firestore — both SDKs —
// persists a Date as a Timestamp automatically, so this lib never constructs an SDK
// Timestamp). READ: structural FirestoreTimestampLike → ISO string via
// `.toDate().toISOString()`. Nullable timestamps map null → null. Non-timestamp
// fields (providers, previousSnapshot, metadata, payload, notificationPrefs) pass
// straight through; fcmTokens is mapped element-wise. No validation; no firebase/SDK
// import; no SDK Timestamp constructed.

import type {
  EpisodeDoc,
  FcmToken,
  NotificationDoc,
  RegionAvailability,
  TitleCacheEntry,
  User,
  WatchlistItem,
} from '@vultus/shared/domain';

import type {
  EpisodeReadData,
  EpisodeWriteData,
  FcmTokenReadData,
  FcmTokenWriteData,
  NotificationReadData,
  NotificationWriteData,
  RegionAvailabilityReadData,
  RegionAvailabilityWriteData,
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
  };
}
export function dataToUser(data: UserReadData): User {
  return {
    region: data.region,
    notificationPrefs: data.notificationPrefs,
    fcmTokens: (data.fcmTokens ?? []).map(dataToFcmToken),
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
  };
}
export function dataToTitleCache(data: TitleCacheReadData): TitleCacheEntry {
  return {
    type: data.type,
    traktId: data.traktId,
    metadata: data.metadata,
    lastSyncedAt: data.lastSyncedAt.toDate().toISOString(),
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
  };
}
export function dataToAvailability(
  data: RegionAvailabilityReadData,
): RegionAvailability {
  return {
    providers: data.providers,
    lastSyncedAt: data.lastSyncedAt.toDate().toISOString(),
    previousSnapshot: data.previousSnapshot,
  };
}
