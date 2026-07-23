import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type { Messaging } from 'firebase-admin/messaging';
import {
  notificationPath,
  notificationToData,
} from '@vultus/shared/firestore-schema';
import type { NotificationDoc, TitleType } from '@vultus/shared/domain';
import { handleDispatch, type DispatchEvent } from './dispatch-notifications';
import {
  createFirestoreNotificationStore,
  createFirestoreWatchlistStore,
  createMessagingFcmSender,
} from './dispatch/adapters';

// --- Fakes -----------------------------------------------------------------

interface DocSnap {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

/**
 * Minimal Firestore fake: serves `title-cache/{id}` doc reads and records every
 * write path (set/add/update) so boundary assertions can inspect them. Empty
 * collections answer `findUsersTracking` / `getEpisodes` with no results.
 */
function createFakeDb(opts: {
  titleCache: Record<string, Record<string, unknown>>;
}) {
  const writes: { path: string; data: unknown }[] = [];

  const collection = (path: string) => ({
    get: () => Promise.resolve({ docs: [] }),
    add: (data: unknown) => {
      writes.push({ path, data });
      return Promise.resolve({ id: 'generated' });
    },
    doc: () => ({ id: 'generated' }),
  });

  const collectionGroup = () => ({
    where: () => ({ get: () => Promise.resolve({ docs: [] }) }),
  });

  const doc = (path: string) => ({
    get: (): Promise<DocSnap> => {
      const data = opts.titleCache[path];
      return Promise.resolve({
        exists: data !== undefined,
        data: () => data,
      });
    },
    set: (data: unknown) => {
      writes.push({ path, data });
      return Promise.resolve();
    },
    update: (data: unknown) => {
      writes.push({ path, data });
      return Promise.resolve();
    },
  });

  const db = { collection, collectionGroup, doc } as unknown as Firestore;
  return { db, writes };
}

const noopMessaging = {
  send: vi.fn(() => Promise.resolve('msg-id')),
} as unknown as Messaging;

// --- handleDispatch wiring --------------------------------------------------

describe('handleDispatch', () => {
  it('reads the title type, builds the AvailabilityChange and dispatches', async () => {
    const flatrate = {
      providerId: 8,
      name: 'Netflix',
      type: 'flatrate' as const,
    };
    const { db } = createFakeDb({
      titleCache: {
        'title-cache/603': {
          type: 'movie',
          metadata: { title: 'Test Movie' },
        },
      },
    });
    const getSpy = vi.spyOn(db, 'doc');

    const event: DispatchEvent = {
      params: { tmdbId: '603', region: 'NL' },
      data: {
        after: {
          data: () => ({ providers: [flatrate], previousSnapshot: [] }),
        },
      },
    };

    await handleDispatch(event, db, noopMessaging);

    // The title type is read from the parent title-cache doc.
    expect(getSpy).toHaveBeenCalledWith('title-cache/603');
    // No users tracking (empty collection group) → no notification writes, but
    // the flow completed without throwing, proving the change was assembled.
  });

  it('is a no-op when the doc was deleted (no afterData)', async () => {
    const { db, writes } = createFakeDb({ titleCache: {} });
    const collSpy = vi.spyOn(db, 'collectionGroup');

    const event: DispatchEvent = {
      params: { tmdbId: '603', region: 'NL' },
      data: { after: { data: () => undefined } },
    };

    await handleDispatch(event, db, noopMessaging);

    expect(collSpy).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('is a no-op when the title-cache doc is unknown', async () => {
    const { db, writes } = createFakeDb({ titleCache: {} });
    const collSpy = vi.spyOn(db, 'collectionGroup');

    const event: DispatchEvent = {
      params: { tmdbId: '999', region: 'NL' },
      data: {
        after: { data: () => ({ providers: [], previousSnapshot: [] }) },
      },
    };

    await handleDispatch(event, db, noopMessaging);

    // Returns before touching the watchlist collection group or any write path.
    expect(collSpy).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('never writes to title-cache/** or system/** during dispatch', async () => {
    const flatrate = {
      providerId: 8,
      name: 'Netflix',
      type: 'flatrate' as const,
    };
    const { db, writes } = createFakeDb({
      titleCache: {
        'title-cache/603': {
          type: 'movie',
          metadata: { title: 'Test Movie' },
        },
      },
    });

    const event: DispatchEvent = {
      params: { tmdbId: '603', region: 'NL' },
      data: {
        after: {
          data: () => ({ providers: [flatrate], previousSnapshot: [] }),
        },
      },
    };

    await handleDispatch(event, db, noopMessaging);

    for (const w of writes) {
      expect(w.path.startsWith('title-cache/')).toBe(false);
      expect(w.path.startsWith('system/')).toBe(false);
    }
  });
});

// --- FCM sender adapter -----------------------------------------------------

// A messaging error carrying a Firebase `code`, as the Admin SDK throws.
function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

// Typed view of the `notification` block on the first message passed to a send
// spy — the spy's call arg is otherwise untyped (`unknown`).
function notificationOf(send: { mock: { calls: unknown[][] } }): {
  title: string;
  body: string;
} {
  const message = send.mock.calls[0][0] as {
    notification: { title: string; body: string };
  };
  return message.notification;
}

describe('createMessagingFcmSender', () => {
  it('returns unregistered:false on a successful send', async () => {
    const send = vi.fn(() => Promise.resolve('msg-id'));
    const messaging = { send } as unknown as Messaging;
    const sender = createMessagingFcmSender(messaging, 'Test Movie');

    const result = await sender.send('tok-1', { kind: 'movie-available' });

    expect(result).toEqual({ token: 'tok-1', unregistered: false });
  });

  it('sends both the data block and an OS-rendered notification block (spec 0041)', async () => {
    const send = vi.fn(() => Promise.resolve('msg-id'));
    const sender = createMessagingFcmSender(
      { send } as unknown as Messaging,
      'Test Movie',
    );

    await sender.send('tok-1', { kind: 'movie-available' });

    expect(send).toHaveBeenCalledWith({
      token: 'tok-1',
      data: { kind: 'movie-available' },
      notification: {
        title: 'Now available to stream',
        body: 'Test Movie is available on a streaming platform',
      },
    });
  });

  it('builds movie-available copy', async () => {
    const send = vi.fn(() => Promise.resolve('msg-id'));
    const sender = createMessagingFcmSender(
      { send } as unknown as Messaging,
      'Inception',
    );

    await sender.send('tok', { kind: 'movie-available' });

    expect(notificationOf(send)).toEqual({
      title: 'Now available to stream',
      body: 'Inception is available on a streaming platform',
    });
  });

  it('builds show-came-to-platform copy (shares availability copy)', async () => {
    const send = vi.fn(() => Promise.resolve('msg-id'));
    const sender = createMessagingFcmSender(
      { send } as unknown as Messaging,
      'Severance',
    );

    await sender.send('tok', { kind: 'show-came-to-platform' });

    expect(notificationOf(send)).toEqual({
      title: 'Now available to stream',
      body: 'Severance is available on a streaming platform',
    });
  });

  it('builds episode-aired copy', async () => {
    const send = vi.fn(() => Promise.resolve('msg-id'));
    const sender = createMessagingFcmSender(
      { send } as unknown as Messaging,
      'Severance',
    );

    await sender.send('tok', { kind: 'episode-aired' });

    expect(notificationOf(send)).toEqual({
      title: 'New episode available',
      body: 'Severance has a new episode on a streaming platform',
    });
  });

  it('builds movie-leaving-platform copy (spec 0057, not availability copy)', async () => {
    const send = vi.fn(() => Promise.resolve('msg-id'));
    const sender = createMessagingFcmSender(
      { send } as unknown as Messaging,
      'Inception',
    );

    await sender.send('tok', { kind: 'movie-leaving-platform' });

    expect(notificationOf(send)).toEqual({
      title: 'Leaving your streaming service',
      body: 'Inception is leaving a streaming platform — watch it soon',
    });
  });

  it('builds show-leaving-platform copy (spec 0057, shares leaving copy)', async () => {
    const send = vi.fn(() => Promise.resolve('msg-id'));
    const sender = createMessagingFcmSender(
      { send } as unknown as Messaging,
      'Severance',
    );

    await sender.send('tok', { kind: 'show-leaving-platform' });

    expect(notificationOf(send)).toEqual({
      title: 'Leaving your streaming service',
      body: 'Severance is leaving a streaming platform — watch it soon',
    });
  });

  it('uses the generic platform phrase (providerName is not in the FCM data)', async () => {
    const send = vi.fn(() => Promise.resolve('msg-id'));
    const sender = createMessagingFcmSender(
      { send } as unknown as Messaging,
      'Test Movie',
    );

    await sender.send('tok', {
      kind: 'movie-available',
      // even if a providerName-like key were present, the body ignores it
      region: 'NL',
    });

    expect(notificationOf(send).body).toBe(
      'Test Movie is available on a streaming platform',
    );
  });

  it('maps registration-token-not-found to unregistered:true', async () => {
    const send = vi.fn(() =>
      Promise.reject(codedError('messaging/registration-token-not-found')),
    );
    const sender = createMessagingFcmSender(
      { send } as unknown as Messaging,
      'Test Movie',
    );

    const result = await sender.send('stale', {});

    expect(result).toEqual({ token: 'stale', unregistered: true });
  });

  it('maps invalid-registration-token to unregistered:true', async () => {
    const send = vi.fn(() =>
      Promise.reject(codedError('messaging/invalid-registration-token')),
    );
    const sender = createMessagingFcmSender(
      { send } as unknown as Messaging,
      'Test Movie',
    );

    const result = await sender.send('bad', {});

    expect(result).toEqual({ token: 'bad', unregistered: true });
  });

  it('rethrows non-token errors', async () => {
    const send = vi.fn(() =>
      Promise.reject(codedError('messaging/internal-error')),
    );
    const sender = createMessagingFcmSender(
      { send } as unknown as Messaging,
      'Test Movie',
    );

    await expect(sender.send('tok', {})).rejects.toMatchObject({
      code: 'messaging/internal-error',
    });
  });
});

// --- Notification store adapter (deterministic doc id, spec 0041) -----------

function makeNotificationDoc(
  overrides: Partial<NotificationDoc> = {},
): NotificationDoc {
  return {
    titleId: 'title-1',
    kind: 'movie-available',
    payload: {
      tmdbId: 603,
      titleId: 'title-1',
      title: '',
      region: 'NL',
    },
    sentAt: '2026-06-29T00:00:00.000Z',
    readAt: null,
    ...overrides,
  };
}

describe('createFirestoreNotificationStore', () => {
  it('writes to the caller-supplied id path with merge (spec 0089 (uid,id,doc))', async () => {
    const { db, writes } = createFakeDb({ titleCache: {} });
    const setSpy = vi.spyOn(db, 'doc');
    const store = createFirestoreNotificationStore(db);
    const doc = makeNotificationDoc();

    await store.write('u1', '603-NL-movie-available', doc);

    const expectedPath = notificationPath('u1', '603-NL-movie-available');
    expect(setSpy).toHaveBeenCalledWith(expectedPath);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      path: expectedPath,
      data: notificationToData(doc),
    });
  });

  it('uses the id verbatim — a per-episode episode-aired id (spec 0089)', async () => {
    const { db, writes } = createFakeDb({ titleCache: {} });
    const store = createFirestoreNotificationStore(db);

    await store.write(
      'u2',
      '1399-US-episode-aired-s01e005',
      makeNotificationDoc({
        kind: 'episode-aired',
        payload: { tmdbId: 1399, titleId: 't', title: '', region: 'US' },
      }),
    );

    expect(writes[0].path).toBe(
      notificationPath('u2', '1399-US-episode-aired-s01e005'),
    );
  });

  it('exists(uid,id) returns true when the notification doc is present, false otherwise', async () => {
    const presentPath = notificationPath('u3', '603-NL-episode-aired-s01e001');
    const { db } = createFakeDb({
      titleCache: { [presentPath]: { kind: 'episode-aired' } },
    });
    const store = createFirestoreNotificationStore(db);

    expect(await store.exists('u3', '603-NL-episode-aired-s01e001')).toBe(true);
    expect(await store.exists('u3', '603-NL-episode-aired-s01e999')).toBe(
      false,
    );
  });
});

// --- Watchlist store adapter: findUsersTracking reads status (spec 0088) ----

/**
 * Fake `db` for `findUsersTracking`: `collectionGroup('watchlist').where(...)`
 * records the equality-query args (`captured`) and its `.get()` serves a single
 * matched watchlist doc (with a parent `users/{uid}` ref); `doc('users/{uid}')`
 * `.get()` serves that user's doc. The `where(...).get()` result now drives the
 * status assertions (spec 0088) — the adapter no longer scans + filters in
 * memory (spec 0100).
 */
function createWatchlistDb(opts: {
  tmdbId: number;
  watchlistData: Record<string, unknown>;
  uid: string;
  titleId: string;
  userData: Record<string, unknown>;
}) {
  const watchlistDoc = {
    id: opts.titleId,
    data: () => opts.watchlistData,
    ref: {
      id: opts.titleId,
      parent: { parent: { id: opts.uid } },
    },
  };

  const captured: { field?: unknown; op?: unknown; value?: unknown } = {};

  const collectionGroup = () => ({
    where: (field: unknown, op: unknown, value: unknown) => {
      captured.field = field;
      captured.op = op;
      captured.value = value;
      return { get: () => Promise.resolve({ docs: [watchlistDoc] }) };
    },
  });

  const doc = (path: string) => ({
    get: () => {
      if (path === 'users/' + opts.uid) {
        return Promise.resolve({ exists: true, data: () => opts.userData });
      }
      return Promise.resolve({ exists: false, data: () => undefined });
    },
  });

  const db = { collectionGroup, doc } as unknown as Firestore;
  return { db, captured };
}

describe('createFirestoreWatchlistStore.findUsersTracking (spec 0088)', () => {
  const userData = {
    region: 'NL',
    notificationPrefs: {
      episodeAired: true,
      movieAvailable: true,
      cameToPlatform: true,
      deliveryHour: null,
    },
    fcmTokens: [],
  };

  it("issues the indexed collection-group query where('tmdbId','==',603) (spec 0100)", async () => {
    const { db, captured } = createWatchlistDb({
      tmdbId: 603,
      watchlistData: { tmdbId: 603, status: 'watching' },
      uid: 'u1',
      titleId: 'title-1',
      userData,
    });

    await createFirestoreWatchlistStore(db).findUsersTracking(603);

    // The O(all-docs) scan is gone: the adapter filters at the query, not in JS.
    expect(captured.field).toBe('tmdbId');
    expect(captured.op).toBe('==');
    expect(captured.value).toBe(603);
  });

  it("reads status off the matched watchlist doc ('completed')", async () => {
    const { db } = createWatchlistDb({
      tmdbId: 603,
      watchlistData: { tmdbId: 603, status: 'completed' },
      uid: 'u1',
      titleId: 'title-1',
      userData,
    });

    const users =
      await createFirestoreWatchlistStore(db).findUsersTracking(603);

    expect(users).toHaveLength(1);
    expect(users[0].uid).toBe('u1');
    expect(users[0].status).toBe('completed');
  });

  it("maps a watchlist doc missing status to 'watching' (fallback)", async () => {
    const { db } = createWatchlistDb({
      tmdbId: 603,
      watchlistData: { tmdbId: 603 },
      uid: 'u1',
      titleId: 'title-1',
      userData,
    });

    const users =
      await createFirestoreWatchlistStore(db).findUsersTracking(603);

    expect(users).toHaveLength(1);
    expect(users[0].status).toBe('watching');
  });
});

// --- handleDispatch: 'removed' transition end-to-end (spec 0057) ------------

/**
 * Fake `db` wiring `handleDispatch`'s full removed-transition path: serves the
 * parent `title-cache/{tmdbId}` doc (for `type` + title), the indexed
 * `collectionGroup('watchlist').where('tmdbId','==',…)` query (one matched doc
 * with a parent user), and the joined `users/{uid}` doc — while capturing every
 * write path so the inbox doc can be asserted.
 */
function createRemovedDispatchDb(opts: {
  tmdbId: number;
  type: TitleType;
  titleStr: string;
  uid: string;
  titleId: string;
  userData: Record<string, unknown>;
}) {
  const writes: { path: string; data: unknown }[] = [];

  const watchlistDoc = {
    id: opts.titleId,
    data: () => ({ tmdbId: opts.tmdbId, status: 'watching' }),
    ref: {
      id: opts.titleId,
      parent: { parent: { id: opts.uid } },
    },
  };

  const collectionGroup = () => ({
    where: () => ({
      get: () => Promise.resolve({ docs: [watchlistDoc] }),
    }),
  });

  const doc = (path: string) => ({
    get: () => {
      if (path === 'title-cache/' + opts.tmdbId) {
        return Promise.resolve({
          exists: true,
          data: () => ({
            type: opts.type,
            metadata: { title: opts.titleStr },
          }),
        });
      }
      if (path === 'users/' + opts.uid) {
        return Promise.resolve({ exists: true, data: () => opts.userData });
      }
      return Promise.resolve({ exists: false, data: () => undefined });
    },
    set: (data: unknown) => {
      writes.push({ path, data });
      return Promise.resolve();
    },
    update: (data: unknown) => {
      writes.push({ path, data });
      return Promise.resolve();
    },
  });

  const db = { collectionGroup, doc } as unknown as Firestore;
  return { db, writes };
}

// previousSnapshot carried a flatrate provider; providers now empty → 'removed'.
const removedEvent = (tmdbId: number): DispatchEvent => ({
  params: { tmdbId: String(tmdbId), region: 'NL' },
  data: {
    after: {
      data: () => ({
        providers: [],
        previousSnapshot: [
          { providerId: 8, name: 'Netflix', type: 'flatrate' as const },
        ],
      }),
    },
  },
});

describe("handleDispatch — 'removed' transition dispatches leaving kinds (spec 0057)", () => {
  it('movie removed: writes a movie-leaving-platform doc and sends FCM with the leaving block', async () => {
    const { db, writes } = createRemovedDispatchDb({
      tmdbId: 603,
      type: 'movie',
      titleStr: 'The Matrix',
      uid: 'u1',
      titleId: 'title-1',
      userData: {
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
          movieLeavingPlatform: true,
          showLeavingPlatform: true,
          deliveryHour: null,
        },
        fcmTokens: [{ token: 'tok-1', platform: 'android' }],
      },
    });
    const send = vi.fn(() => Promise.resolve('msg-id'));
    const messaging = { send } as unknown as Messaging;

    await handleDispatch(removedEvent(603), db, messaging);

    // Inbox doc written to users/{uid}/notifications/{id} with the new kind.
    const notifWrites = writes.filter((w) =>
      w.path.startsWith(notificationPath('u1', '')),
    );
    expect(notifWrites).toHaveLength(1);
    expect(notifWrites[0].path).toBe(
      notificationPath('u1', '603-NL-movie-leaving-platform'),
    );

    // FCM send carries the new kind in data and the leaving notification block.
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0] as {
      token: string;
      data: Record<string, string>;
      notification: { title: string; body: string };
    };
    expect(message.data.kind).toBe('movie-leaving-platform');
    expect(message.notification).toEqual({
      title: 'Leaving your streaming service',
      body: 'The Matrix is leaving a streaming platform — watch it soon',
    });
  });

  it('show removed: writes a show-leaving-platform doc and sends FCM', async () => {
    const { db, writes } = createRemovedDispatchDb({
      tmdbId: 1399,
      type: 'tv',
      titleStr: 'Severance',
      uid: 'u2',
      titleId: 'title-2',
      userData: {
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
          movieLeavingPlatform: true,
          showLeavingPlatform: true,
          deliveryHour: null,
        },
        fcmTokens: [{ token: 'tok-2', platform: 'android' }],
      },
    });
    const send = vi.fn(() => Promise.resolve('msg-id'));
    const messaging = { send } as unknown as Messaging;

    await handleDispatch(removedEvent(1399), db, messaging);

    const notifWrites = writes.filter((w) =>
      w.path.startsWith(notificationPath('u2', '')),
    );
    expect(notifWrites).toHaveLength(1);
    expect(notifWrites[0].path).toBe(
      notificationPath('u2', '1399-NL-show-leaving-platform'),
    );

    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0] as {
      data: Record<string, string>;
      notification: { title: string; body: string };
    };
    expect(message.data.kind).toBe('show-leaving-platform');
    expect(message.notification.title).toBe('Leaving your streaming service');
  });

  it('legacy user doc missing the new prefs still dispatches the leaving kind (core !== false)', async () => {
    const { db, writes } = createRemovedDispatchDb({
      tmdbId: 603,
      type: 'movie',
      titleStr: 'The Matrix',
      uid: 'u3',
      titleId: 'title-3',
      // Pre-0057 doc: notificationPrefs omits movie/showLeavingPlatform.
      userData: {
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
          deliveryHour: null,
        },
        fcmTokens: [{ token: 'tok-3', platform: 'android' }],
      },
    });
    const send = vi.fn(() => Promise.resolve('msg-id'));

    await handleDispatch(removedEvent(603), db, {
      send,
    } as unknown as Messaging);

    expect(
      writes.some(
        (w) =>
          w.path === notificationPath('u3', '603-NL-movie-leaving-platform'),
      ),
    ).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
