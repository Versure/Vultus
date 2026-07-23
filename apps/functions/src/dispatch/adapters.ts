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
  WatchStatus,
} from '@vultus/shared/domain';
import type {
  FcmSender,
  FcmSendResult,
  NotificationStore,
  TrackingUser,
  WatchlistStore,
} from '@vultus/functions/dispatch-notifications';

/**
 * Watchlist store backed by a Firestore `watchlist` collection group. Finds the
 * users tracking a title with an indexed collection-group equality query on
 * `tmdbId` (so each call costs O(users tracking that `tmdbId`), not O(all
 * watchlist docs)), then joins each user's `users/{uid}` doc for region + prefs
 * + tokens. Requires the `COLLECTION_GROUP`-scoped index on `watchlist.tmdbId`
 * in `firestore.indexes.json`.
 */
export function createFirestoreWatchlistStore(db: Firestore): WatchlistStore {
  return {
    async findUsersTracking(tmdbId: number): Promise<TrackingUser[]> {
      const snap = await db
        .collectionGroup('watchlist')
        .where('tmdbId', '==', tmdbId)
        .get();
      const matches = snap.docs;

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
        const matchedData = doc.data() as { status?: WatchStatus };
        users.push({
          uid,
          titleId,
          region: userData.region,
          // Pass prefs through unchanged: the core's isKindEnabled reads the
          // two spec-0057 leaving-platform kinds with `!== false`, so a legacy
          // doc missing them already resolves as enabled — no backfill here.
          notificationPrefs: userData.notificationPrefs,
          fcmTokens: userData.fcmTokens ?? [],
          // legacy/malformed doc missing status → notifiable (spec 0088)
          status: matchedData.status ?? 'watching',
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
 * Notification store that writes to `users/{uid}/notifications/{id}` using the
 * caller-supplied `id` verbatim (the dispatcher core owns id derivation for both
 * the availability path — `{tmdbId}-{region}-{kind}` — and the episode-aired path
 * — `{tmdbId}-{region}-episode-aired-{episodeId}`, spec 0089 / D3). Pinning the
 * doc id — rather than appending with a Firestore-generated id — lets the mobile
 * app's mark-as-read write target the exact doc, and makes a re-fired availability
 * trigger idempotent (it merges onto the same doc instead of duplicating).
 * ISO timestamps are mapped to Timestamps via the shared schema converter.
 *
 * `exists(uid, id)` backs the episode-aired path's per-episode idempotency: the
 * daily airing-scan re-sees an episode for up to `EPISODE_RECENCY_WINDOW_DAYS`,
 * so the dispatcher checks whether the per-episode notification doc already exists
 * before writing/sending, notifying each episode exactly once.
 */
export function createFirestoreNotificationStore(
  db: Firestore,
): NotificationStore {
  return {
    async write(uid, id, doc): Promise<void> {
      await db
        .doc(notificationPath(uid, id))
        .set(notificationToData(doc), { merge: true });
    },
    async exists(uid, id): Promise<boolean> {
      const snap = await db.doc(notificationPath(uid, id)).get();
      return snap.exists;
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
  // movie-leaving-platform + show-leaving-platform: a title is losing all
  // flatrate providers (spec 0057). Distinct "leaving"-toned copy so the OS
  // push is not mislabelled as availability.
  if (kind === 'movie-leaving-platform' || kind === 'show-leaving-platform') {
    return {
      title: 'Leaving your streaming service',
      body: `${titleStr} is leaving ${PLATFORM_FALLBACK} — watch it soon`,
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
