import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FcmToken,
  NotificationDoc,
  NotificationPrefs,
  WatchProvider,
} from '@vultus/shared/domain';
import {
  createNotificationDispatcher,
  type AvailabilityChange,
} from './dispatcher';
import type {
  EpisodeStore,
  FcmSendResult,
  NotificationStore,
  TrackedEpisode,
  TrackingUser,
  WatchlistStore,
} from './ports';

const NOW = '2026-06-22T12:00:00.000Z';
const flatrate = (id: number): WatchProvider => ({
  providerId: id,
  name: `p${id}`,
  type: 'flatrate',
});

const allPrefs = (
  overrides: Partial<NotificationPrefs> = {},
): NotificationPrefs => ({
  episodeAired: true,
  movieAvailable: true,
  cameToPlatform: true,
  deliveryHour: null,
  ...overrides,
});

const token = (t: string): FcmToken => ({
  token: t,
  deviceId: `dev-${t}`,
  createdAt: NOW,
});

const user = (overrides: Partial<TrackingUser> = {}): TrackingUser => ({
  uid: 'u1',
  region: 'NL',
  notificationPrefs: allPrefs(),
  fcmTokens: [token('tok-1')],
  titleId: 'title-1',
  ...overrides,
});

// ---- fakes ----
interface WrittenNotification {
  uid: string;
  doc: NotificationDoc;
}

function makeStores(
  opts: {
    users?: TrackingUser[];
    episodesByUser?: Record<string, TrackedEpisode[]>;
    unregisteredTokens?: Set<string>;
    writeError?: (uid: string) => boolean;
  } = {},
) {
  const written: WrittenNotification[] = [];
  const removed: { uid: string; token: string }[] = [];
  const sent: { token: string; data: Record<string, string> }[] = [];

  const watchlist: WatchlistStore = {
    findUsersTracking: vi.fn(() => Promise.resolve(opts.users ?? [])),
    removeFcmToken: vi.fn((uid: string, t: string) => {
      removed.push({ uid, token: t });
      return Promise.resolve();
    }),
  };

  const episodes: EpisodeStore = {
    getEpisodes: vi.fn((uid: string) =>
      Promise.resolve(opts.episodesByUser?.[uid] ?? []),
    ),
  };

  const notifications: NotificationStore = {
    write: vi.fn((uid: string, doc: NotificationDoc) => {
      if (opts.writeError?.(uid)) throw new Error(`write failed for ${uid}`);
      written.push({ uid, doc });
      return Promise.resolve();
    }),
  };

  const fcm = {
    send: vi.fn(
      (t: string, data: Record<string, string>): Promise<FcmSendResult> => {
        sent.push({ token: t, data });
        return Promise.resolve({
          token: t,
          unregistered: opts.unregisteredTokens?.has(t) ?? false,
        });
      },
    ),
  };

  return { watchlist, episodes, notifications, fcm, written, removed, sent };
}

function makeChange(
  overrides: Partial<AvailabilityChange> = {},
): AvailabilityChange {
  return {
    tmdbId: 100,
    type: 'movie',
    region: 'NL',
    previousProviders: [],
    newProviders: [flatrate(1)],
    ...overrides,
  };
}

function makeDispatcher(
  stores: ReturnType<typeof makeStores>,
  nowIso: string = NOW,
) {
  return createNotificationDispatcher({
    watchlist: stores.watchlist,
    episodes: stores.episodes,
    notifications: stores.notifications,
    fcm: stores.fcm,
    now: () => nowIso,
  });
}

describe('createNotificationDispatcher', () => {
  beforeEach(() => vi.clearAllMocks());

  it('movie appeared, single in-region user: one movie-available doc + one FCM send', async () => {
    const stores = makeStores({ users: [user()] });
    const summary = await makeDispatcher(stores).dispatch(makeChange());

    expect(stores.written).toHaveLength(1);
    const { uid, doc } = stores.written[0];
    expect(uid).toBe('u1');
    expect(doc.kind).toBe('movie-available');
    expect(doc.payload.tmdbId).toBe(100);
    expect(doc.payload.region).toBe('NL');
    expect(doc.payload.titleId).toBe('title-1');
    expect(doc.readAt).toBeNull();
    expect(doc.sentAt).toBe(NOW);

    expect(stores.sent).toHaveLength(1);
    const { token: t, data } = stores.sent[0];
    expect(t).toBe('tok-1');
    expect(data).toEqual({
      notificationId: '100-NL-movie-available',
      titleId: 'title-1',
      kind: 'movie-available',
      region: 'NL',
      tmdbId: '100',
    });
    // all FCM data values are strings
    Object.values(data).forEach((v) => expect(typeof v).toBe('string'));

    expect(summary).toEqual({
      tmdbId: 100,
      region: 'NL',
      transition: 'appeared',
      usersConsidered: 1,
      notificationsWritten: 1,
      fcmSent: 1,
      staleTokensPruned: 0,
    });
  });

  it('region filter: out-of-region user gets nothing', async () => {
    const stores = makeStores({ users: [user({ region: 'US' })] });
    const summary = await makeDispatcher(stores).dispatch(
      makeChange({ region: 'NL' }),
    );

    expect(stores.written).toHaveLength(0);
    expect(stores.sent).toHaveLength(0);
    expect(summary.usersConsidered).toBe(0);
  });

  it('prefs gate: movieAvailable=false suppresses; true delivers', async () => {
    const off = makeStores({
      users: [user({ notificationPrefs: allPrefs({ movieAvailable: false }) })],
    });
    await makeDispatcher(off).dispatch(makeChange());
    expect(off.written).toHaveLength(0);
    expect(off.sent).toHaveLength(0);

    const on = makeStores({ users: [user()] });
    await makeDispatcher(on).dispatch(makeChange());
    expect(on.written).toHaveLength(1);
  });

  it('tv appeared + aired episode: two notifications when both prefs on', async () => {
    const stores = makeStores({
      users: [user()],
      episodesByUser: {
        u1: [{ airDate: '2026-06-01T00:00:00.000Z', season: 1, episode: 1 }],
      },
    });
    const summary = await makeDispatcher(stores).dispatch(
      makeChange({ type: 'tv' }),
    );

    const kinds = stores.written.map((w) => w.doc.kind);
    expect(kinds).toEqual(['show-came-to-platform', 'episode-aired']);
    expect(summary.notificationsWritten).toBe(2);
    expect(summary.fcmSent).toBe(2);
  });

  it('tv appeared + aired episode: only enabled subset when episodeAired off', async () => {
    const stores = makeStores({
      users: [user({ notificationPrefs: allPrefs({ episodeAired: false }) })],
      episodesByUser: {
        u1: [{ airDate: '2026-06-01T00:00:00.000Z', season: 1, episode: 1 }],
      },
    });
    await makeDispatcher(stores).dispatch(makeChange({ type: 'tv' }));

    expect(stores.written.map((w) => w.doc.kind)).toEqual([
      'show-came-to-platform',
    ]);
  });

  it('removed transition: no availability notification written', async () => {
    const stores = makeStores({ users: [user()] });
    const summary = await makeDispatcher(stores).dispatch(
      makeChange({ previousProviders: [flatrate(1)], newProviders: [] }),
    );

    expect(stores.written).toHaveLength(0);
    expect(stores.sent).toHaveLength(0);
    expect(summary.transition).toBe('removed');
    expect(summary.usersConsidered).toBe(1);
  });

  it('multiple users: 3 in-region → 3 considered, one notification + send each', async () => {
    const users = [
      user({ uid: 'a', titleId: 't-a', fcmTokens: [token('ta')] }),
      user({ uid: 'b', titleId: 't-b', fcmTokens: [token('tb')] }),
      user({ uid: 'c', titleId: 't-c', fcmTokens: [token('tc')] }),
    ];
    const stores = makeStores({ users });
    const summary = await makeDispatcher(stores).dispatch(makeChange());

    expect(summary).toMatchObject({
      usersConsidered: 3,
      notificationsWritten: 3,
      fcmSent: 3,
      staleTokensPruned: 0,
    });
    expect(stores.written.map((w) => w.uid).sort()).toEqual(['a', 'b', 'c']);
  });

  it('stale-token prune: unregistered token pruned, good token kept and sent', async () => {
    const stores = makeStores({
      users: [user({ fcmTokens: [token('good'), token('stale')] })],
      unregisteredTokens: new Set(['stale']),
    });
    const summary = await makeDispatcher(stores).dispatch(makeChange());

    expect(stores.removed).toEqual([{ uid: 'u1', token: 'stale' }]);
    expect(stores.removed.find((r) => r.token === 'good')).toBeUndefined();
    expect(stores.written).toHaveLength(1); // notification still written
    expect(stores.sent.map((s) => s.token).sort()).toEqual(['good', 'stale']);
    expect(summary.staleTokensPruned).toBe(1);
  });

  it('FCM unregistered does not throw; run completes and counts the prune', async () => {
    const stores = makeStores({
      users: [user({ fcmTokens: [token('stale')] })],
      unregisteredTokens: new Set(['stale']),
    });
    const summary = await makeDispatcher(stores).dispatch(makeChange());

    expect(summary.staleTokensPruned).toBe(1);
    expect(summary.notificationsWritten).toBe(1);
  });

  it('per-user error isolation: middle user write throws, others still delivered', async () => {
    const users = [
      user({ uid: 'a', titleId: 't-a', fcmTokens: [token('ta')] }),
      user({ uid: 'b', titleId: 't-b', fcmTokens: [token('tb')] }),
      user({ uid: 'c', titleId: 't-c', fcmTokens: [token('tc')] }),
    ];
    const stores = makeStores({ users, writeError: (uid) => uid === 'b' });

    const summary = await makeDispatcher(stores).dispatch(makeChange());

    const uids = stores.written.map((w) => w.uid);
    expect(uids).toContain('a');
    expect(uids).toContain('c');
    expect(uids).not.toContain('b');
    expect(summary.usersConsidered).toBe(3);
    expect(summary.notificationsWritten).toBe(2);
  });

  it('clock determinism: every sentAt equals the injected now()', async () => {
    const stores = makeStores({
      users: [user()],
      episodesByUser: {
        u1: [{ airDate: '2026-06-01T00:00:00.000Z', season: 1, episode: 1 }],
      },
    });
    await makeDispatcher(stores).dispatch(makeChange({ type: 'tv' }));

    expect(stores.written).toHaveLength(2);
    stores.written.forEach((w) => expect(w.doc.sentAt).toBe(NOW));
  });

  it('best-effort idempotency: dispatching twice writes the notification twice', async () => {
    const stores = makeStores({ users: [user()] });
    const dispatcher = makeDispatcher(stores);
    await dispatcher.dispatch(makeChange());
    await dispatcher.dispatch(makeChange());

    expect(stores.written).toHaveLength(2);
    // deterministic notificationId stays stable across runs
    expect(stores.sent[0].data.notificationId).toBe(
      stores.sent[1].data.notificationId,
    );
  });

  describe('delivery window (spec 0051)', () => {
    // Fixed clock: 2024-03-15T08:30:00Z → UTC hour 8.
    const FIXED = '2024-03-15T08:30:00.000Z';

    it('outside window: FCM skipped, inbox doc still written', async () => {
      const stores = makeStores({
        users: [user({ notificationPrefs: allPrefs({ deliveryHour: 10 }) })],
      });
      const summary = await makeDispatcher(stores, FIXED).dispatch(
        makeChange(),
      );

      expect(stores.written).toHaveLength(1);
      expect(summary.notificationsWritten).toBeGreaterThan(0);
      expect(stores.sent).toHaveLength(0);
      expect(summary.fcmSent).toBe(0);
    });

    it('inside window: sends FCM per token as normal', async () => {
      const stores = makeStores({
        users: [user({ notificationPrefs: allPrefs({ deliveryHour: 8 }) })],
      });
      const summary = await makeDispatcher(stores, FIXED).dispatch(
        makeChange(),
      );

      expect(stores.written).toHaveLength(1);
      expect(stores.sent).toHaveLength(1);
      expect(stores.sent[0].token).toBe('tok-1');
      expect(summary.fcmSent).toBe(1);
    });

    it('deliveryHour null: sends FCM at any time', async () => {
      const stores = makeStores({
        users: [user({ notificationPrefs: allPrefs({ deliveryHour: null }) })],
      });
      const summary = await makeDispatcher(stores, FIXED).dispatch(
        makeChange(),
      );

      expect(stores.written).toHaveLength(1);
      expect(stores.sent).toHaveLength(1);
      expect(summary.fcmSent).toBe(1);
    });

    it('per-user independence: null + match send FCM; mismatch gets doc only', async () => {
      const users = [
        user({
          uid: 'a',
          titleId: 't-a',
          fcmTokens: [token('ta')],
          notificationPrefs: allPrefs({ deliveryHour: null }),
        }),
        user({
          uid: 'b',
          titleId: 't-b',
          fcmTokens: [token('tb')],
          notificationPrefs: allPrefs({ deliveryHour: 8 }),
        }),
        user({
          uid: 'c',
          titleId: 't-c',
          fcmTokens: [token('tc')],
          notificationPrefs: allPrefs({ deliveryHour: 10 }),
        }),
      ];
      const stores = makeStores({ users });
      const summary = await makeDispatcher(stores, FIXED).dispatch(
        makeChange(),
      );

      // all three get an inbox doc
      expect(stores.written.map((w) => w.uid).sort()).toEqual(['a', 'b', 'c']);
      expect(summary.notificationsWritten).toBe(3);
      // only a (null) and b (match) get FCM; c (mismatch) does not
      expect(stores.sent.map((s) => s.token).sort()).toEqual(['ta', 'tb']);
      expect(summary.fcmSent).toBe(2);
    });

    it('legacy doc (deliveryHour absent/undefined): treated as any time → FCM sent', async () => {
      // Build prefs WITHOUT a deliveryHour key to mimic a pre-0051 doc; the
      // dispatcher's `== null` check must treat undefined as "any time".
      const legacyPrefs = {
        episodeAired: true,
        movieAvailable: true,
        cameToPlatform: true,
      } as unknown as NotificationPrefs;
      const stores = makeStores({
        users: [user({ notificationPrefs: legacyPrefs })],
      });
      const summary = await makeDispatcher(stores, FIXED).dispatch(
        makeChange(),
      );

      expect(stores.written).toHaveLength(1);
      expect(stores.sent).toHaveLength(1);
      expect(summary.fcmSent).toBe(1);
    });

    it('clock determinism: window decision and sentAt share the injected now', async () => {
      // FIXED = UTC hour 8. A user with deliveryHour 8 is inside the window.
      const stores = makeStores({
        users: [user({ notificationPrefs: allPrefs({ deliveryHour: 8 }) })],
      });
      await makeDispatcher(stores, FIXED).dispatch(makeChange());

      expect(stores.written).toHaveLength(1);
      expect(stores.written[0].doc.sentAt).toBe(FIXED);
      // consistent with the timestamp: inside window → FCM sent
      expect(stores.sent).toHaveLength(1);

      // And the converse with a mismatching hour against the same clock.
      const miss = makeStores({
        users: [user({ notificationPrefs: allPrefs({ deliveryHour: 9 }) })],
      });
      await makeDispatcher(miss, FIXED).dispatch(makeChange());
      expect(miss.written[0].doc.sentAt).toBe(FIXED);
      expect(miss.sent).toHaveLength(0);
    });
  });
});
