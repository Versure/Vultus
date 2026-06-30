// Firestore wire (stored) shapes for each domain document. The domain types
// (@vultus/shared/domain) carry timestamps as ISO 8601 strings; Firestore stores
// them as Timestamps. These per-document data types describe the persistence
// boundary: the READ shape types timestamps as the structural FirestoreTimestampLike
// (the value an SDK hands back), and the WRITE shape types them as JS `Date` (which
// both Firebase SDKs coerce to a Timestamp on write). Non-timestamp fields reuse the
// domain types directly. No firebase/SDK import: the read side is structural, the
// write side is a plain `Date`.

import type {
  NotificationKind,
  NotificationPayload,
  NotificationPrefs,
  Region,
  TitleMetadata,
  TitleType,
  WatchProvider,
  WatchStatus,
} from '@vultus/shared/domain';

// Minimal structural shape that BOTH the client SDK Timestamp and the Admin SDK
// Timestamp satisfy. The lib never imports either SDK; the read converters accept
// anything with toDate(). Slices pass the SDK's own Timestamp instance straight
// in — do NOT pre-convert before calling the read converter.
export interface FirestoreTimestampLike {
  toDate(): Date;
}

// --- User: nested timestamp inside fcmTokens[] ---
export interface FcmTokenReadData {
  token: string;
  deviceId: string;
  createdAt: FirestoreTimestampLike;
}
export interface FcmTokenWriteData {
  token: string;
  deviceId: string;
  createdAt: Date;
}
export interface UserReadData {
  region: Region;
  notificationPrefs: NotificationPrefs; // passes through
  fcmTokens: FcmTokenReadData[]; // per-element mapped
}
export interface UserWriteData {
  region: Region;
  notificationPrefs: NotificationPrefs;
  fcmTokens: FcmTokenWriteData[];
}

// --- WatchlistItem: addedAt ---
export interface WatchlistItemReadData {
  type: TitleType;
  tmdbId: number;
  traktId: number | null;
  title: string;
  addedAt: FirestoreTimestampLike;
  status: WatchStatus;
  posterPath?: string | null;
  voteAverage?: number | null;
  releaseDate?: string | null; // plain ISO date string; NOT a Timestamp
}
export interface WatchlistItemWriteData {
  type: TitleType;
  tmdbId: number;
  traktId: number | null;
  title: string;
  addedAt: Date;
  status: WatchStatus;
  posterPath?: string | null;
  voteAverage?: number | null;
  releaseDate?: string | null; // plain ISO date string; NOT a Timestamp
}

// --- EpisodeDoc: airDate + nullable watchedAt + nullable title (spec 0034) ---
export interface EpisodeReadData {
  season: number;
  episode: number;
  title?: string | null; // optional on read: stored docs pre-0034 lack this field
  airDate: FirestoreTimestampLike;
  watched: boolean;
  watchedAt: FirestoreTimestampLike | null; // null → null
}
export interface EpisodeWriteData {
  season: number;
  episode: number;
  title: string | null;
  airDate: Date;
  watched: boolean;
  watchedAt: Date | null;
}

// --- NotificationDoc: sentAt + nullable readAt; payload passes through ---
export interface NotificationReadData {
  titleId: string;
  kind: NotificationKind;
  payload: NotificationPayload;
  sentAt: FirestoreTimestampLike;
  readAt: FirestoreTimestampLike | null; // null → null
}
export interface NotificationWriteData {
  titleId: string;
  kind: NotificationKind;
  payload: NotificationPayload;
  sentAt: Date;
  readAt: Date | null;
}

// --- TitleCacheEntry: lastSyncedAt; metadata passes through ---
export interface TitleCacheReadData {
  type: TitleType;
  traktId: number | null;
  metadata: TitleMetadata;
  lastSyncedAt: FirestoreTimestampLike;
}
export interface TitleCacheWriteData {
  type: TitleType;
  traktId: number | null;
  metadata: TitleMetadata;
  lastSyncedAt: Date;
}

// --- RegionAvailability: lastSyncedAt; providers + previousSnapshot pass through ---
export interface RegionAvailabilityReadData {
  providers: WatchProvider[];
  lastSyncedAt: FirestoreTimestampLike;
  previousSnapshot: WatchProvider[];
}
export interface RegionAvailabilityWriteData {
  providers: WatchProvider[];
  lastSyncedAt: Date;
  previousSnapshot: WatchProvider[];
}
