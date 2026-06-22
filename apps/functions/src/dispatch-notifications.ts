/**
 * The notification-dispatcher Cloud Function (spec 0012). A Firestore trigger on
 * `title-cache/{tmdbId}/availability/{region}` writes: it reads the availability
 * diff (`previousSnapshot` vs `providers`), builds an `AvailabilityChange`, and
 * hands it to the SDK-free dispatcher core wired to the Admin-SDK adapters.
 *
 * The Admin SDK enters ONLY at the `onDocumentWritten` wiring + the adapters;
 * the diff/dispatch logic (`handleDispatch`) is driven by injected `db` +
 * `messaging` so it can be unit-tested without the SDK, network, or secrets.
 */
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import type { Messaging } from 'firebase-admin/messaging';
import { createNotificationDispatcher } from '@vultus/functions/dispatch-notifications';
import type { AvailabilityChange } from '@vultus/functions/dispatch-notifications';
import type { Region, TitleType, WatchProvider } from '@vultus/shared/domain';
import {
  createFirestoreEpisodeStore,
  createFirestoreNotificationStore,
  createFirestoreWatchlistStore,
  createMessagingFcmSender,
} from './dispatch/adapters';

function ensureAdminForDispatch(): { db: Firestore; messaging: Messaging } {
  if (getApps().length === 0) initializeApp();
  return { db: getFirestore(), messaging: getMessaging() };
}

/** The Firestore write event shape `handleDispatch` consumes — satisfied by the
 *  real `onDocumentWritten` event and by test fakes. */
export interface DispatchEvent {
  params: Record<string, string>;
  data?: {
    after?: {
      data(): Record<string, unknown> | undefined;
    };
  };
}

/**
 * Core dispatch flow, SDK-agnostic via injected `db` + `messaging`. Reads the
 * availability diff carried on the written doc, joins the title's `type` from
 * the parent `title-cache` doc, and runs the dispatcher. No-ops on a deleted doc
 * or an unknown title.
 */
export async function handleDispatch(
  event: DispatchEvent,
  db: Firestore,
  messaging: Messaging,
): Promise<void> {
  const afterData = event.data?.after?.data();
  if (!afterData) return; // deleted doc — no-op

  const tmdbId = Number(event.params.tmdbId);
  const region = event.params.region as Region;

  // The title's media type lives on the parent title-cache doc, not on the
  // per-region availability doc.
  const titleSnap = await db.doc('title-cache/' + tmdbId).get();
  if (!titleSnap.exists) return; // unknown title — nothing to dispatch
  const titleData = titleSnap.data() as { type: TitleType } | undefined;
  if (!titleData) return;
  const type = titleData.type;

  // The sync engine rolls `previousSnapshot` into the doc before writing the new
  // providers, so a single (after) read carries both sides of the diff.
  const availability = afterData as {
    providers?: WatchProvider[];
    previousSnapshot?: WatchProvider[];
  };
  const newProviders = availability.providers ?? [];
  const previousProviders = availability.previousSnapshot ?? [];

  const change: AvailabilityChange = {
    tmdbId,
    type,
    region,
    previousProviders,
    newProviders,
  };

  const dispatcher = createNotificationDispatcher({
    watchlist: createFirestoreWatchlistStore(db),
    episodes: createFirestoreEpisodeStore(db),
    notifications: createFirestoreNotificationStore(db),
    fcm: createMessagingFcmSender(messaging),
  });

  await dispatcher.dispatch(change);
}

/**
 * The deployable Firestore-trigger function. Wires the Admin SDK into
 * `handleDispatch` on every availability-doc write.
 */
export const dispatchNotifications = onDocumentWritten(
  'title-cache/{tmdbId}/availability/{region}',
  async (event) => {
    const { db, messaging } = ensureAdminForDispatch();
    await handleDispatch(event, db, messaging);
  },
);
