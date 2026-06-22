// Firestore document shapes mapped 1:1 from PLAN §4. Persistence-agnostic:
// timestamps are ISO 8601 strings (no Date, no Firestore Timestamp, no Firebase
// import). The ISO ↔ Timestamp mapping lives in spec 0004's converters.

import type { NotificationKind, Region, TitleType, WatchStatus } from './enums';
import type { WatchProvider } from './entities';

export interface FcmToken {
  token: string;
  deviceId: string;
  createdAt: string; // ISO 8601
}

// Provisional minimal shape — see Risks. Per-kind opt-in toggles aligned to
// NotificationKind.
export interface NotificationPrefs {
  episodeAired: boolean;
  movieAvailable: boolean;
  cameToPlatform: boolean;
}

export interface User {
  region: Region;
  notificationPrefs: NotificationPrefs;
  fcmTokens: FcmToken[];
}

export interface WatchlistItem {
  type: TitleType; // 'movie' | 'tv'
  tmdbId: number;
  traktId: number | null;
  title: string;
  addedAt: string; // ISO 8601
  status: WatchStatus;
}

// users/{userId}/watchlist/{titleId}/episodes/{episodeId} — tv only.
export interface EpisodeDoc {
  season: number;
  episode: number;
  airDate: string; // ISO 8601
  watched: boolean;
  watchedAt: string | null; // ISO 8601 or null
}

// Provisional minimal payload — see Risks. Firms up when dispatch-notifications
// is specced. Typed object, NOT `any`.
export interface NotificationPayload {
  tmdbId: number;
  titleId: string;
  title: string;
  region: Region;
  providerName?: string; // present for availability/platform kinds
}

export interface NotificationDoc {
  titleId: string;
  kind: NotificationKind;
  payload: NotificationPayload;
  sentAt: string; // ISO 8601
  readAt: string | null; // ISO 8601 or null
}

// Provisional metadata — see Risks. Minimal cached TMDB fields now.
export interface TitleMetadata {
  title: string;
  overview: string;
  posterPath: string | null;
  releaseDate: string | null; // ISO 8601 or null
}

export interface TitleCacheEntry {
  type: TitleType;
  traktId: number | null; // Trakt show id (tv only); null for movies and unresolved
  metadata: TitleMetadata;
  lastSyncedAt: string; // ISO 8601
}

export interface RegionAvailability {
  providers: WatchProvider[];
  lastSyncedAt: string; // ISO 8601
  previousSnapshot: WatchProvider[]; // prior providers array, for transition detection
}
