// Firestore document shapes mapped 1:1 from PLAN §4. Persistence-agnostic:
// timestamps are ISO 8601 strings (no Date, no Firestore Timestamp, no Firebase
// import). The ISO ↔ Timestamp mapping lives in spec 0004's converters.

import type { NotificationKind, Region, TitleType, WatchStatus } from './enums';
import type { CatalogProvider, WatchProvider } from './entities';

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
  // Quiet-hours delivery preference (spec 0051). `null` = any time / no
  // preference; a number 0–23 restricts delivery to that UTC hour. Required
  // field: legacy docs lacking it map to `null` via the converter's `?? null`.
  deliveryHour: number | null;
}

export interface User {
  region: Region;
  notificationPrefs: NotificationPrefs;
  fcmTokens: FcmToken[];
  /** TMDB provider ids the user subscribes to (spec 0060). Open number[] so a
   *  later manual "provider" (Plex, spec 0061) can be layered in without a
   *  migration. Default []; legacy docs missing it → [] via the converter. */
  myProviderIds: number[];
  /** Whether the user uses a self-hosted Plex server (spec 0061). Gates the
   *  per-title "watching via Plex" toggle in title-detail. A separate boolean —
   *  NOT a member of myProviderIds (Plex has no TMDB id). Default false; legacy
   *  docs missing it → false via the converter. */
  hasPlex: boolean;
}

// provider-catalog/{region} — global, function-written cache (PLAN §4).
export interface ProviderCatalogDoc {
  providers: CatalogProvider[];
  lastSyncedAt: string; // ISO 8601
}

export interface WatchlistItem {
  type: TitleType; // 'movie' | 'tv'
  tmdbId: number;
  traktId: number | null;
  title: string;
  addedAt: string; // ISO 8601
  status: WatchStatus;
  posterPath?: string | null; // TMDB poster path, e.g. '/abc123.jpg'; null when unknown
  voteAverage?: number | null; // TMDB vote average 0–10; null when unknown
  releaseDate?: string | null; // plain ISO date, e.g. '2024-03-15'; null when unknown
  /** Manual per-title override: the user watches THIS title via their Plex
   *  server, regardless of TMDB availability (spec 0061, GitHub #140). Additive
   *  to — never a replacement for — the TMDB availability framing (spec 0060).
   *  Default false; legacy docs missing it → false via the converter. */
  watchingViaPlex: boolean;
}

// users/{userId}/watchlist/{titleId}/episodes/{episodeId} — tv only.
export interface EpisodeDoc {
  season: number;
  episode: number;
  title: string | null; // episode title; null when unknown / not yet synced (spec 0034)
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

/** A single completed sync-pipeline run, written by Cloud Functions to the
 *  global `sync-runs/{runId}` collection and read by the settings slice. */
export interface SyncRun {
  /** == the Firestore document ID. */
  runId: string;
  /** Which entry point wrote this run. */
  kind: 'cron' | 'manual';
  /** The calling UID for a manual run; `null` for a cron run (covers all users). */
  userId: string | null;
  /** ISO 8601 — when the run started. */
  startedAt: string;
  /** ISO 8601 — when the run completed. */
  completedAt: string;
  /** Wall-clock duration of the run, ms. */
  durationMs: number;
  /** Distinct titles gathered for this run. */
  titlesGathered: number;
  /** Titles the engine reported as `outcome: 'synced'`. */
  titlesUpdated: number;
  /** Number of titles the engine reported as `outcome: 'error'`. */
  errorCount: number;
  /** First ~10 error messages (credential-free); `[]` when none. */
  errors: string[];
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
