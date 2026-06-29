/**
 * Firebase Admin SDK adapters that satisfy the `@vultus/functions/dispatch-notifications`
 * ports. The dispatcher core is Firebase-free (hexagonal); these are the only
 * place the Admin Firestore + FCM bindings enter the notification flow.
 */
import { FieldValue } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import type { Messaging } from 'firebase-admin/messaging';
import {
  notificationPath,
  notificationToData,
} from '@vultus/shared/firestore-schema';
import type {
  FcmToken,
  NotificationPrefs,
  Region,
} from '@vultus/shared/domain';
import type {
  EpisodeStore,
  FcmSender,
  FcmSendResult,
  NotificationStore,
  TrackedEpisode,
  TrackingUser,
  WatchlistStore,
} from '@vultus/functions/dispatch-notifications';

/**
 * Watchlist store backed by a Firestore `watchlist` collection group. Finds the
 * users tracking a title by scanning the group and matching `tmdbId`, then joins
 * each user's `users/{uid}` doc for region + prefs + tokens.
 */
export function createFirestoreWatchlistStore(db: Firestore): WatchlistStore {
  return {
    async findUsersTracking(tmdbId: number): Promise<TrackingUser[]> {
      const snap = await db.collectionGroup('watchlist').get();
      const matches = snap.docs.filter((doc) => {
        const data = doc.data() as { tmdbId?: number };
        return data.tmdbId === tmdbId;
      });

      const users: TrackingUser[] = [];
      for (const doc of matches) {
        const parent = doc.ref.parent.parent;
        if (!parent) continue;
        const uid = parent.id;
        const titleId = doc.ref.id;
        const userSnap = await db.doc('users/' + uid).get();
        if (!userSnap.exists) continue;
        const userData = userSnap.data() as
          | {
              region: Region;
              notificationPrefs: NotificationPrefs;
              fcmTokens?: FcmToken[];
            }
          | undefined;
        if (!userData) continue;
        users.push({
          uid,
          titleId,
          region: userData.region,
          notificationPrefs: userData.notificationPrefs,
          fcmTokens: userData.fcmTokens ?? [],
        });
      }
      return users;
    },

    async removeFcmToken(uid: string, token: string): Promise<void> {
      await db
        .doc('users/' + uid)
        .update({ fcmTokens: FieldValue.arrayRemove(token) });
    },
  };
}

/**
 * Episode store backed by `users/{uid}/watchlist/{titleId}/episodes`. Maps each
 * episode doc to the minimal `TrackedEpisode` shape the dispatcher needs.
 */
export function createFirestoreEpisodeStore(db: Firestore): EpisodeStore {
  return {
    async getEpisodes(
      uid: string,
      titleId: string,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _tmdbId: number,
    ): Promise<TrackedEpisode[]> {
      const snap = await db
        .collection('users/' + uid + '/watchlist/' + titleId + '/episodes')
        .get();
      return snap.docs.map((doc) => {
        const data = doc.data() as TrackedEpisode;
        return {
          airDate: data.airDate,
          season: data.season,
          episode: data.episode,
        };
      });
    },
  };
}

/**
 * Notification store that writes to `users/{uid}/notifications/{id}` keyed by the
 * deterministic id `{tmdbId}-{region}-{kind}` (spec 0041). Pinning the doc id —
 * rather than appending with a Firestore-generated id — lets the mobile app's
 * mark-as-read write target the exact doc, and makes a re-fired availability
 * trigger idempotent (it merges onto the same doc instead of duplicating).
 * ISO timestamps are mapped to Timestamps via the shared schema converter.
 */
export function createFirestoreNotificationStore(
  db: Firestore,
): NotificationStore {
  return {
    async write(uid, doc): Promise<void> {
      const id = `${doc.payload.tmdbId}-${doc.payload.region}-${doc.kind}`;
      await db
        .doc(notificationPath(uid, id))
        .set(notificationToData(doc), { merge: true });
    },
  };
}

const UNREGISTERED_CODES = new Set([
  'messaging/registration-token-not-found',
  'messaging/invalid-registration-token',
]);

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    return (err as { code?: unknown }).code as string | undefined;
  }
  return undefined;
}

// `providerName` is not carried in the FCM `data` record (only
// `{ notificationId, titleId, kind, region, tmdbId }`), so the body copy uses a
// generic platform phrase. The mobile app renders richer copy from its own
// cache on tap; the OS-rendered notification only needs to be intelligible.
const PLATFORM_FALLBACK = 'a streaming platform';

/**
 * Build the OS-rendered `notification` block per notification kind (spec 0041).
 * Android renders this natively when the app is backgrounded/terminated; the
 * `data` block still drives the deep-link tap handling in-app.
 */
function buildNotification(
  kind: string,
  titleStr: string,
): { title: string; body: string } {
  if (kind === 'episode-aired') {
    return {
      title: 'New episode available',
      body: `${titleStr} has a new episode on ${PLATFORM_FALLBACK}`,
    };
  }
  // movie-available + show-came-to-platform share the availability copy.
  return {
    title: 'Now available to stream',
    body: `${titleStr} is available on ${PLATFORM_FALLBACK}`,
  };
}

/**
 * FCM sender over the Admin Messaging API. Sends each message with both a `data`
 * block (drives in-app deep-link handling) and a `notification` block (spec
 * 0041 — lets the Android OS render the notification natively when the app is
 * backgrounded/terminated). The body copy is built from `titleStr`, read by the
 * caller from the title-cache doc. Maps the platform's stale-token error codes
 * to `{ unregistered: true }` so the dispatcher can prune them; all other errors
 * propagate.
 */
export function createMessagingFcmSender(
  messaging: Messaging,
  titleStr: string,
): FcmSender {
  return {
    async send(
      token: string,
      data: Record<string, string>,
    ): Promise<FcmSendResult> {
      try {
        await messaging.send({
          token,
          data,
          notification: buildNotification(data.kind ?? '', titleStr),
        });
        return { token, unregistered: false };
      } catch (err) {
        const code = errorCode(err);
        if (code && UNREGISTERED_CODES.has(code)) {
          return { token, unregistered: true };
        }
        throw err;
      }
    },
  };
}
