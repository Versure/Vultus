// Ports (hexagonal adapters) for the notification dispatcher. The dispatcher
// core depends only on these interfaces — the firebase-admin / FCM-bound
// implementations live in `apps/functions`, keeping this lib Firebase-free.

import type {
  FcmToken,
  NotificationDoc,
  NotificationPrefs,
  Region,
} from '@vultus/shared/domain';

export interface TrackingUser {
  uid: string;
  region: Region;
  notificationPrefs: NotificationPrefs;
  fcmTokens: FcmToken[];
  titleId: string; // the watchlist doc id for this user's tracking of the title
}

export interface WatchlistStore {
  /** Users tracking `tmdbId` (any region); caller filters by region. */
  findUsersTracking(tmdbId: number): Promise<TrackingUser[]>;
  /** Remove one stale FCM token from a user's fcmTokens array. */
  removeFcmToken(uid: string, token: string): Promise<void>;
}

export interface TrackedEpisode {
  airDate: string; // ISO 8601
  season: number;
  episode: number;
}

export interface EpisodeStore {
  getEpisodes(
    uid: string,
    titleId: string,
    tmdbId: number,
  ): Promise<TrackedEpisode[]>;
}

export interface NotificationStore {
  write(uid: string, doc: NotificationDoc): Promise<void>;
}

export interface FcmSendResult {
  token: string;
  unregistered: boolean;
}

export interface FcmSender {
  send(token: string, data: Record<string, string>): Promise<FcmSendResult>;
}
