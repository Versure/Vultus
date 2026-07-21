/**
 * The daily episode-aired airing-scan (spec 0089 / D3, Defect 2). This is NOT a
 * deployed Cloud Function — it is invoked from `runSync` (`main.ts`) right after
 * the daily episode-insert pass, so it is coupled to the same hardened daily run.
 *
 * It enumerates every tracked TV show, reads its already-inserted episode docs,
 * and emits an `episode-aired` notification for every episode whose `airDate` has
 * crossed into the recent window (`[now - EPISODE_RECENCY_WINDOW_DAYS, now]`) and
 * that has not already been notified. It reuses the per-user decision machinery in
 * `@vultus/functions/dispatch-notifications` (status/prefs/recency/flatrate gates,
 * delivery-window FCM, token prune, per-episode idempotency via
 * `NotificationStore.exists`).
 *
 * Why a scan, not an `onDocumentCreated` trigger: episodes are inserted with their
 * TMDB-scheduled (often future) `airDate` and never re-created, so a creation
 * trigger would fire once at insert time with `airDate > now` (rejected by the
 * window) and never fire again on the day it actually airs (Defect 2). The scan is
 * driven by the airing, not the doc creation.
 *
 * The Admin SDK is injected (`db`/`messaging`) so the core is unit-testable without
 * the SDK, network, or secrets — mirroring `dispatch-notifications.ts`. It does NOT
 * import `@vultus/functions/sync-episodes`; it reads episode docs directly via the
 * Admin SDK (Sheriff rule 3).
 */
import { logger } from 'firebase-functions';
import type { Firestore } from 'firebase-admin/firestore';
import type { Messaging } from 'firebase-admin/messaging';
import {
  createNotificationDispatcher,
  hasFlatrate,
  isEpisodeRecentlyAired,
  EPISODE_RECENCY_WINDOW_DAYS,
} from '@vultus/functions/dispatch-notifications';
import type { EpisodeAiredChange } from '@vultus/functions/dispatch-notifications';
import {
  availabilityDocPath,
  dataToEpisode,
  episodesPath,
} from '@vultus/shared/firestore-schema';
import type { EpisodeReadData } from '@vultus/shared/firestore-schema';
import type {
  FcmToken,
  NotificationPrefs,
  Region,
  TitleType,
  WatchProvider,
  WatchStatus,
} from '@vultus/shared/domain';
import {
  createFirestoreNotificationStore,
  createFirestoreWatchlistStore,
  createMessagingFcmSender,
} from './dispatch/adapters';

/** A tracked TV show gathered from the `watchlist` collection group. */
interface TrackedShow {
  uid: string;
  titleId: string;
  tmdbId: number;
  status: WatchStatus;
  title: string;
}

/** The subset of a `users/{uid}` doc the scan reads. */
interface UserDoc {
  region: Region;
  notificationPrefs: NotificationPrefs;
  fcmTokens: FcmToken[];
}

/**
 * Core airing-scan flow, SDK-agnostic via injected `db` + `messaging`. Writes
 * ONLY `users/{uid}/notifications/**` (via the dispatcher) and prunes only
 * `users/{uid}.fcmTokens` — never `title-cache`, `sync-runs`, or `system`.
 *
 * Best-effort per show/episode: a single show/episode error is logged and does
 * not abort the rest of the scan (the caller in `runSync` also wraps the whole
 * scan in a best-effort try/catch).
 */
export async function runEpisodeAiredScan(
  db: Firestore,
  messaging: Messaging,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  // Shared, title-independent adapters (built once). The FCM sender/dispatcher
  // are built PER-TITLE below so each episode's OS-notification body carries its
  // own show name (NB4).
  const notifications = createFirestoreNotificationStore(db);
  const watchlist = createFirestoreWatchlistStore(db);

  // 1. Enumerate tracked TV shows via the same unindexed collection-group scan
  //    `findUsersTracking` uses; in-memory filter to `type === 'tv'`.
  const snap = await db.collectionGroup('watchlist').get();
  const shows: TrackedShow[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as {
      tmdbId?: number;
      type?: TitleType;
      status?: WatchStatus;
      title?: string;
    };
    if (data.type !== 'tv') continue;
    const parent = doc.ref.parent.parent;
    if (!parent) continue;
    if (typeof data.tmdbId !== 'number') continue;
    shows.push({
      uid: parent.id,
      titleId: doc.ref.id,
      tmdbId: data.tmdbId,
      // legacy/malformed doc missing status → notifiable (spec 0088)
      status: data.status ?? 'watching',
      title: data.title ?? '',
    });
  }

  // Caches across shows: user docs per uid, availability hasFlatrate per
  // (tmdbId, region). A `null` cache entry means "read, and it did not exist".
  const userCache = new Map<string, UserDoc | null>();
  const flatrateCache = new Map<string, boolean>();

  async function readUser(uid: string): Promise<UserDoc | null> {
    if (userCache.has(uid)) return userCache.get(uid) ?? null;
    const userSnap = await db.doc('users/' + uid).get();
    const data = userSnap.exists
      ? (userSnap.data() as
          | {
              region?: Region;
              notificationPrefs?: NotificationPrefs;
              fcmTokens?: FcmToken[];
            }
          | undefined)
      : undefined;
    const user: UserDoc | null =
      data?.region && data.notificationPrefs
        ? {
            region: data.region,
            notificationPrefs: data.notificationPrefs,
            fcmTokens: data.fcmTokens ?? [],
          }
        : null;
    userCache.set(uid, user);
    return user;
  }

  async function readHasFlatrate(
    tmdbId: number,
    region: Region,
  ): Promise<boolean> {
    const key = `${tmdbId}::${region}`;
    const cached = flatrateCache.get(key);
    if (cached !== undefined) return cached;
    const availSnap = await db.doc(availabilityDocPath(tmdbId, region)).get();
    const providers = availSnap.exists
      ? ((availSnap.data() as { providers?: WatchProvider[] } | undefined)
          ?.providers ?? [])
      : [];
    const result = hasFlatrate(providers);
    flatrateCache.set(key, result);
    return result;
  }

  for (const show of shows) {
    try {
      const user = await readUser(show.uid);
      if (!user) continue;

      // 2. Read the show's episodes; convert each stored `airDate` Timestamp →
      //    ISO via `dataToEpisode` (NB5 — NOT a raw `data.airDate` read), then
      //    filter to the recency window before any per-episode work.
      const episodesSnap = await db
        .collection(episodesPath(show.uid, show.titleId))
        .get();
      const recent = episodesSnap.docs
        .map((d) => ({
          episodeId: d.id,
          airDate: dataToEpisode(d.data() as EpisodeReadData).airDate,
        }))
        .filter((e) =>
          isEpisodeRecentlyAired(e.airDate, now(), EPISODE_RECENCY_WINDOW_DAYS),
        );

      if (recent.length === 0) continue;

      // 3. hasFlatrate in the user's region (cached per tmdbId+region).
      const hasFlatrateNow = await readHasFlatrate(show.tmdbId, user.region);

      // 4. Per-title dispatcher: the FCM sender binds this show's title so the
      //    OS-rendered body names the right show (NB4).
      const dispatcher = createNotificationDispatcher({
        watchlist,
        notifications,
        fcm: createMessagingFcmSender(messaging, show.title),
        now,
      });

      for (const ep of recent) {
        const change: EpisodeAiredChange = {
          tmdbId: show.tmdbId,
          region: user.region,
          uid: show.uid,
          titleId: show.titleId,
          status: show.status,
          notificationPrefs: user.notificationPrefs,
          fcmTokens: user.fcmTokens,
          episodeId: ep.episodeId,
          airDate: ep.airDate,
          hasFlatrateNow,
        };
        try {
          await dispatcher.dispatchEpisodeAired(change);
        } catch (err) {
          logger.error('[episodeAiredScan] dispatch failed for episode', {
            uid: show.uid,
            titleId: show.titleId,
            episodeId: ep.episodeId,
            err,
          });
        }
      }
    } catch (err) {
      logger.error('[episodeAiredScan] failed for show (continuing)', {
        uid: show.uid,
        titleId: show.titleId,
        err,
      });
    }
  }
}
