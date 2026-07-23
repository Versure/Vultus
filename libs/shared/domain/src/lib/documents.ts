// Firestore document shapes mapped 1:1 from PLAN §4. Persistence-agnostic:
// timestamps are ISO 8601 strings (no Date, no Firestore Timestamp, no Firebase
// import). The ISO ↔ Timestamp mapping lives in spec 0004's converters.

import type {
  AvailabilitySource,
  NotificationKind,
  Region,
  TitleType,
  WatchStatus,
} from './enums';
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
  /** Alert when a tracked MOVIE loses all flatrate providers in the user's
   *  region (spec 0057). Default true; legacy docs missing it → true. */
  movieLeavingPlatform: boolean;
  /** Alert when a tracked TV SHOW loses all flatrate providers (spec 0057).
   *  Default true; legacy docs missing it → true. */
  showLeavingPlatform: boolean;
  // Quiet-hours delivery preference (spec 0051). `null` = any time / no
  // preference; a number 0–23 restricts delivery to that UTC hour. Required
  // field: legacy docs lacking it map to `null` via the converter's `?? null`.
  deliveryHour: number | null;
}

/** One title the most recent completed Plex sync pass could NOT match to a
 *  TMDB id (or that errored). Diagnostic output for the Settings "couldn't
 *  match" list (spec 0097). NOT a user preference. */
export interface PlexUnmatchedTitle {
  /** The Plex library item's title (display only). */
  title: string;
  /** Why it wasn't matched:
   *  - 'no-guid': no tmdb/tvdb/imdb GUID at all → nothing to resolve;
   *  - 'guid-unresolved': had a tvdb/imdb GUID but TMDB /find returned no
   *    matching-media-type result;
   *  - 'error': processing the item threw (network / HTTP / timeout). */
  reason: 'no-guid' | 'guid-unresolved' | 'error';
}

/** Per-user Plex sync cursor + link metadata (spec 0073). The X-Plex-Token is
 *  NOT stored here — it lives on-device in @capacitor/preferences. This holds
 *  only the multi-device-safe additions cursor + display info. Absent/null =
 *  never linked (or unlinked). */
export interface PlexSyncMeta {
  /** ISO 8601 — when the current device linked this server. */
  linkedAt: string;
  /** ISO 8601 — completion time of the last successful sync; null until the
   *  first sync completes after linking. THE ADDITIONS CURSOR: items with Plex
   *  `addedAt` newer than this are "new". Initialized to `linkedAt` at link
   *  time (no backfill). */
  lastSyncAt: string | null;
  /** Human-readable PMS name for the connected-state UI; null if unknown. */
  serverName: string | null;
  /** Titles the most recent completed sync pass could not match to a TMDB id
   *  (or that errored). Capped at 50, replaced wholesale each completed pass
   *  (never appended); `[]` clears the UI. OPTIONAL: legacy `plexSync` docs and
   *  pre-0097 links lack it (absent/`undefined` = no diagnostics yet). Spec
   *  0097. */
  unmatched?: PlexUnmatchedTitle[];
}

export interface User {
  region: Region;
  notificationPrefs: NotificationPrefs;
  fcmTokens: FcmToken[];
  /** TMDB provider ids the user subscribes to (spec 0060). Open number[] so a
   *  later manual "provider" (Plex, spec 0061) can be layered in without a
   *  migration. Default []; legacy docs missing it → [] via the converter. */
  myProviderIds: number[];
  /** Whether the user uses a self-hosted Plex server (spec 0061). Set true on
   *  Plex link (spec 0073). Gates the per-title "watching via Plex" toggle in
   *  title-detail. A separate boolean — NOT a member of myProviderIds (Plex has
   *  no TMDB id). Default false; legacy docs missing it → false via the
   *  converter. */
  hasPlex: boolean;
  /** Plex sync cursor + link metadata (spec 0073). OPTIONAL/nullable so legacy
   *  docs and never-linked users need no migration; coalesced `?? null`. */
  plexSync?: PlexSyncMeta | null;
}

// provider-catalog/{region} — global, function-written cache (PLAN §4).
export interface ProviderCatalogDoc {
  providers: CatalogProvider[];
  lastSyncedAt: string; // ISO 8601
}

export interface WatchlistItem {
  type: TitleType; // 'movie' | 'tv'
  tmdbId: number;
  title: string;
  addedAt: string; // ISO 8601
  status: WatchStatus;
  posterPath?: string | null; // TMDB poster path, e.g. '/abc123.jpg'; null when unknown
  voteAverage?: number | null; // TMDB vote average 0–10; null when unknown
  releaseDate?: string | null; // plain ISO date, e.g. '2024-03-15'; null when unknown
  /** Air date (ISO 8601, same format as EpisodeDoc.airDate) of the EARLIEST
   *  currently-unwatched episode of this TV show; null when the item is a movie,
   *  the episodes subcollection is empty, or every episode is watched (spec 0081).
   *  Denormalized: written server-side on sync (Cloud Functions) and client-side
   *  after the user's own mark-watched actions. Legacy docs missing it → null via
   *  the converter. Never meaningfully set for movies. */
  nextUnwatchedEpisodeAirDate?: string | null;
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
  metadata: TitleMetadata;
  lastSyncedAt: string; // ISO 8601
  /** Cached Watchmode title id resolved once from the TMDB id (spec 0099), so
   *  subsequent daily syncs skip the id-resolution call. null = not resolved /
   *  no Watchmode match. Optional; legacy docs missing it → null via the
   *  converter. */
  watchmodeId?: number | null;
}

export interface RegionAvailability {
  providers: WatchProvider[];
  lastSyncedAt: string; // ISO 8601
  previousSnapshot: WatchProvider[]; // prior providers array, for transition detection
  /** Which source produced `providers` this pass (spec 0099). Optional; legacy
   *  docs missing it → 'tmdb' via the converter. */
  source?: AvailabilitySource;
}
