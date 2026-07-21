// Ports (hexagonal adapters) for the notification dispatcher. The dispatcher
// core depends only on these interfaces — the firebase-admin / FCM-bound
// implementations live in `apps/functions`, keeping this lib Firebase-free.

import type {
  FcmToken,
  NotificationDoc,
  NotificationPrefs,
  Region,
  WatchStatus,
} from '@vultus/shared/domain';

export interface TrackingUser {
  uid: string;
  region: Region;
  notificationPrefs: NotificationPrefs;
  fcmTokens: FcmToken[];
  titleId: string; // the watchlist doc id for this user's tracking of the title
  /** The user's watch status for this title (spec 0088). Used by the dispatcher
   *  to suppress ALL notifications when the user is done with the title
   *  ('completed' or 'dropped'). A missing/legacy value is mapped by the adapter
   *  to a notifiable status ('watching'), never to an excluded one. */
  status: WatchStatus;
}

export interface WatchlistStore {
  /** Users tracking `tmdbId` (any region); caller filters by region. */
  findUsersTracking(tmdbId: number): Promise<TrackingUser[]>;
  /** Remove one stale FCM token from a user's fcmTokens array. */
  removeFcmToken(uid: string, token: string): Promise<void>;
}

export interface NotificationStore {
  /** Create/merge users/{uid}/notifications/{id}. The core owns id derivation
   *  for both paths (availability: `${tmdbId}-${region}-${kind}`; episode:
   *  `${tmdbId}-${region}-episode-aired-${episodeId}`). */
  write(uid: string, id: string, doc: NotificationDoc): Promise<void>;
  /** True when users/{uid}/notifications/{id} already exists. Used by the
   *  episode-aired path so the daily airing-scan notifies each episode exactly
   *  once even though the episode stays in the recency window for several runs
   *  (spec 0089 / D3). */
  exists(uid: string, id: string): Promise<boolean>;
}

export interface FcmSendResult {
  token: string;
  unregistered: boolean;
}

export interface FcmSender {
  send(token: string, data: Record<string, string>): Promise<FcmSendResult>;
}
