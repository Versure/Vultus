// The notification dispatcher core. Given an availability change, finds the
// in-region users tracking the title, decides notification kinds, writes the
// per-user notification docs, and pushes data-only FCM messages — pruning any
// FCM tokens the platform reports unregistered. It also owns the episode-aired
// path (spec 0089 / D3): a per-episode, idempotent dispatch driven by the daily
// airing-scan. Firebase-free: it talks only to the injected ports (see
// `ports.ts`).

import type {
  FcmToken,
  NotificationDoc,
  NotificationKind,
  NotificationPrefs,
  Region,
  TitleType,
  WatchProvider,
  WatchStatus,
} from '@vultus/shared/domain';
import type {
  FcmSender,
  NotificationStore,
  TrackingUser,
  WatchlistStore,
} from './ports';
import {
  classifyFlatrateTransition,
  decideKinds,
  isEpisodeRecentlyAired,
  isWithinDeliveryWindow,
  type FlatrateTransition,
} from './transitions';

/** Recency window (days) for the episode-aired airing-scan: an episode is a
 *  candidate when its `airDate` is within `[now - N, now]` (spec 0089 / D3). */
export const EPISODE_RECENCY_WINDOW_DAYS = 3;

export interface AvailabilityChange {
  tmdbId: number;
  type: TitleType;
  region: Region;
  previousProviders: WatchProvider[];
  newProviders: WatchProvider[];
}

/** One newly-created episode to consider for an episode-aired notification
 *  (spec 0089). Does NOT carry the show title — the FCM body's show name is
 *  bound per-title in the sender by the airing-scan wiring. */
export interface EpisodeAiredChange {
  tmdbId: number;
  region: Region; // the owner user's region
  uid: string;
  titleId: string;
  status: WatchStatus; // for the 0088 completed/dropped gate
  notificationPrefs: NotificationPrefs;
  fcmTokens: FcmToken[];
  episodeId: string; // the s{SS}e{EEE} path segment (per-episode id dimension)
  airDate: string; // ISO 8601
  hasFlatrateNow: boolean; // from title-cache availability in `region`
}

export interface DispatcherConfig {
  watchlist: WatchlistStore;
  notifications: NotificationStore;
  fcm: FcmSender;
  now?: () => string;
}

export interface DispatchSummary {
  tmdbId: number;
  region: Region;
  transition: FlatrateTransition;
  usersConsidered: number;
  notificationsWritten: number;
  fcmSent: number;
  staleTokensPruned: number;
}

export interface NotificationDispatcher {
  dispatch(change: AvailabilityChange): Promise<DispatchSummary>;
  /** Dispatch an episode-aired notification for one user/episode (spec 0089).
   *  No-op (returns notified:false) when: status is completed/dropped (self-
   *  implemented 0088 gate), prefs.episodeAired is false, not on flatrate, airDate
   *  is outside the recency window, OR the per-episode notification id already
   *  exists (already notified — the daily scan re-sees an episode for up to 3 days).
   *  When it DOES notify: the inbox doc is written and FCM is sent only within the
   *  delivery window (0051); stale tokens pruned. Idempotent on the per-episode id
   *  via `NotificationStore.exists`. */
  dispatchEpisodeAired(
    change: EpisodeAiredChange,
  ): Promise<{ notified: boolean; fcmSent: number; staleTokensPruned: number }>;
}

// Maps a notification kind to its per-user opt-in preference. A kind only fires
// when its toggle is enabled (default-deny on unknown kinds).
function isKindEnabled(
  kind: NotificationKind,
  prefs: NotificationPrefs,
): boolean {
  switch (kind) {
    case 'movie-available':
      return prefs.movieAvailable;
    case 'show-came-to-platform':
      return prefs.cameToPlatform;
    case 'episode-aired':
      return prefs.episodeAired;
    // Legacy docs (pre-0057) lack these; treat a missing value as enabled —
    // only an explicit false opts out (spec 0057 decision 4 / Data model).
    case 'movie-leaving-platform':
      return prefs.movieLeavingPlatform !== false;
    case 'show-leaving-platform':
      return prefs.showLeavingPlatform !== false;
    default:
      return false;
  }
}

function notificationId(
  tmdbId: number,
  region: Region,
  kind: NotificationKind,
): string {
  // Deterministic per (title, region, kind) so a re-fired trigger reuses the
  // same id (best-effort idempotency, decision 3) and the app can dedupe.
  return `${tmdbId}-${region}-${kind}`;
}

function episodeNotificationId(
  tmdbId: number,
  region: Region,
  episodeId: string,
): string {
  // Per-episode id so multiple episodes of the same title/region do not collide
  // onto one doc and the airing-scan notifies each episode exactly once (D3).
  return `${tmdbId}-${region}-episode-aired-${episodeId}`;
}

function isStatusSuppressed(status: WatchStatus): boolean {
  // Completed/dropped: the user is done with the title → zero notifications.
  return status === 'completed' || status === 'dropped';
}

export function createNotificationDispatcher(
  config: DispatcherConfig,
): NotificationDispatcher {
  const { watchlist, notifications, fcm } = config;
  const now = config.now ?? (() => new Date().toISOString());

  async function dispatchForUser(
    change: AvailabilityChange,
    user: TrackingUser,
    transition: FlatrateTransition,
    timestamp: string,
    counters: {
      notificationsWritten: number;
      fcmSent: number;
      staleTokensPruned: number;
    },
  ): Promise<void> {
    const kinds = decideKinds({
      type: change.type,
      transition,
    });

    const enabledKinds = kinds.filter((kind) =>
      isKindEnabled(kind, user.notificationPrefs),
    );

    // Delivery-window gate (spec 0051): the FCM push is suppressed outside the
    // user's chosen UTC hour, but the inbox doc is ALWAYS written (decision 3).
    // Evaluated once per user against the single dispatch timestamp.
    const withinWindow = isWithinDeliveryWindow(
      user.notificationPrefs.deliveryHour,
      new Date(timestamp),
    );
    if (!withinWindow) {
      console.debug(
        'Skipping FCM for uid ' + user.uid + ': outside delivery window',
      );
    }

    for (const kind of enabledKinds) {
      const id = notificationId(change.tmdbId, change.region, kind);
      const doc: NotificationDoc = {
        titleId: user.titleId,
        kind,
        payload: {
          tmdbId: change.tmdbId,
          titleId: user.titleId,
          // Title name is not carried by the change; the app reads it from its
          // own cache. Empty string for v1 (decision: payload kept minimal).
          title: '',
          region: change.region,
        },
        sentAt: timestamp,
        readAt: null,
      };

      await notifications.write(user.uid, id, doc);
      counters.notificationsWritten += 1;

      const data: Record<string, string> = {
        notificationId: id,
        titleId: user.titleId,
        kind,
        region: change.region,
        tmdbId: String(change.tmdbId),
      };

      if (withinWindow) {
        for (const fcmToken of user.fcmTokens) {
          const result = await fcm.send(fcmToken.token, data);
          counters.fcmSent += 1;
          if (result.unregistered) {
            await watchlist.removeFcmToken(user.uid, fcmToken.token);
            counters.staleTokensPruned += 1;
          }
        }
      }
    }
  }

  return {
    async dispatch(change: AvailabilityChange): Promise<DispatchSummary> {
      const transition = classifyFlatrateTransition(
        change.previousProviders,
        change.newProviders,
      );
      const timestamp = now();

      const allUsers = await watchlist.findUsersTracking(change.tmdbId);
      // Region filter + completed/dropped suppression (spec 0088): once a user
      // is done with a title, they get ZERO notifications about it (all kinds).
      // Applied BEFORE usersConsidered is computed, so usersConsidered counts
      // only users this dispatch would actually consider notifying.
      const users = allUsers.filter(
        (u) => u.region === change.region && !isStatusSuppressed(u.status),
      );

      const counters = {
        notificationsWritten: 0,
        fcmSent: 0,
        staleTokensPruned: 0,
      };

      for (const user of users) {
        try {
          await dispatchForUser(change, user, transition, timestamp, counters);
        } catch {
          // Per-user error isolation: one user's failure must not abort the
          // rest of the dispatch (decision: best-effort, resilient delivery).
        }
      }

      return {
        tmdbId: change.tmdbId,
        region: change.region,
        transition,
        usersConsidered: users.length,
        notificationsWritten: counters.notificationsWritten,
        fcmSent: counters.fcmSent,
        staleTokensPruned: counters.staleTokensPruned,
      };
    },

    async dispatchEpisodeAired(change: EpisodeAiredChange): Promise<{
      notified: boolean;
      fcmSent: number;
      staleTokensPruned: number;
    }> {
      const noop = { notified: false, fcmSent: 0, staleTokensPruned: 0 };

      // Gate order (spec 0089): status → prefs → recency → flatrate →
      // idempotency → write → FCM (in delivery window) → prune.
      if (isStatusSuppressed(change.status)) return noop;
      if (!change.notificationPrefs.episodeAired) return noop;

      const timestamp = now();
      if (
        !isEpisodeRecentlyAired(
          change.airDate,
          timestamp,
          EPISODE_RECENCY_WINDOW_DAYS,
        )
      ) {
        return noop;
      }
      if (!change.hasFlatrateNow) return noop;

      const id = episodeNotificationId(
        change.tmdbId,
        change.region,
        change.episodeId,
      );
      if (await notifications.exists(change.uid, id)) return noop;

      const doc: NotificationDoc = {
        titleId: change.titleId,
        kind: 'episode-aired',
        payload: {
          tmdbId: change.tmdbId,
          titleId: change.titleId,
          // The app renders the show name from its own cache (matches the
          // availability path, which also writes title: '').
          title: '',
          region: change.region,
        },
        sentAt: timestamp,
        readAt: null,
      };

      await notifications.write(change.uid, id, doc);

      const data: Record<string, string> = {
        notificationId: id,
        titleId: change.titleId,
        kind: 'episode-aired',
        region: change.region,
        tmdbId: String(change.tmdbId),
        episodeId: change.episodeId,
      };

      let fcmSent = 0;
      let staleTokensPruned = 0;

      const withinWindow = isWithinDeliveryWindow(
        change.notificationPrefs.deliveryHour,
        new Date(timestamp),
      );
      if (withinWindow) {
        for (const fcmToken of change.fcmTokens) {
          const result = await fcm.send(fcmToken.token, data);
          fcmSent += 1;
          if (result.unregistered) {
            await watchlist.removeFcmToken(change.uid, fcmToken.token);
            staleTokensPruned += 1;
          }
        }
      }

      return { notified: true, fcmSent, staleTokensPruned };
    },
  };
}
