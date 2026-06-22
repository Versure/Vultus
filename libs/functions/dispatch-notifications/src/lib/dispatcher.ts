// The notification dispatcher core. Given an availability change, finds the
// in-region users tracking the title, decides notification kinds, writes the
// per-user notification docs, and pushes data-only FCM messages — pruning any
// FCM tokens the platform reports unregistered. Firebase-free: it talks only to
// the injected ports (see `ports.ts`).

import type {
  NotificationDoc,
  NotificationKind,
  NotificationPrefs,
  Region,
  TitleType,
  WatchProvider,
} from '@vultus/shared/domain';
import type {
  EpisodeStore,
  FcmSender,
  NotificationStore,
  TrackingUser,
  WatchlistStore,
} from './ports';
import {
  classifyFlatrateTransition,
  decideKinds,
  hasFlatrate,
  type FlatrateTransition,
} from './transitions';

export interface AvailabilityChange {
  tmdbId: number;
  type: TitleType;
  region: Region;
  previousProviders: WatchProvider[];
  newProviders: WatchProvider[];
}

export interface DispatcherConfig {
  watchlist: WatchlistStore;
  episodes: EpisodeStore;
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

export function createNotificationDispatcher(
  config: DispatcherConfig,
): NotificationDispatcher {
  const { watchlist, episodes, notifications, fcm } = config;
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
    const trackedEpisodes =
      change.type === 'tv'
        ? await episodes.getEpisodes(user.uid, user.titleId, change.tmdbId)
        : [];

    const kinds = decideKinds({
      type: change.type,
      transition,
      hasFlatrateNow: hasFlatrate(change.newProviders),
      episodeAirDates: trackedEpisodes.map((e) => e.airDate),
      now: timestamp,
    });

    const enabledKinds = kinds.filter((kind) =>
      isKindEnabled(kind, user.notificationPrefs),
    );

    for (const kind of enabledKinds) {
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

      await notifications.write(user.uid, doc);
      counters.notificationsWritten += 1;

      const data: Record<string, string> = {
        notificationId: notificationId(change.tmdbId, change.region, kind),
        titleId: user.titleId,
        kind,
        region: change.region,
        tmdbId: String(change.tmdbId),
      };

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

  return {
    async dispatch(change: AvailabilityChange): Promise<DispatchSummary> {
      const transition = classifyFlatrateTransition(
        change.previousProviders,
        change.newProviders,
      );
      const timestamp = now();

      const allUsers = await watchlist.findUsersTracking(change.tmdbId);
      const users = allUsers.filter((u) => u.region === change.region);

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
  };
}
