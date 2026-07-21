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
  type EpisodeAiredChange,
} from './dispatcher';
import type {
  FcmSendResult,
  NotificationStore,
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
  status: 'watching',
  ...overrides,
});

// ---- fakes ----
interface WrittenNotification {
  uid: string;
  id: string;
  doc: NotificationDoc;
}

function makeStores(
  opts: {
    users?: TrackingUser[];
    unregisteredTokens?: Set<string>;
    writeError?: (uid: string) => boolean;
    existingIds?: Set<string>; // "uid|id" already-notified markers
  } = {},
) {
  const written: WrittenNotification[] = [];
  const removed: { uid: string; token: string }[] = [];
  const sent: { token: string; data: Record<string, string> }[] = [];
  const existsChecks: { uid: string; id: string }[] = [];

  const watchlist: WatchlistStore = {
    findUsersTracking: vi.fn(() => Promise.resolve(opts.users ?? [])),
    removeFcmToken: vi.fn((uid: string, t: string) => {
      removed.push({ uid, token: t });
      return Promise.resolve();
    }),
  };

  const notifications: NotificationStore = {
    write: vi.fn((uid: string, id: string, doc: NotificationDoc) => {
      if (opts.writeError?.(uid)) throw new Error(`write failed for ${uid}`);
      written.push({ uid, id, doc });
      return Promise.resolve();
    }),
    exists: vi.fn((uid: string, id: string) => {
      existsChecks.push({ uid, id });
      return Promise.resolve(opts.existingIds?.has(`${uid}|${id}`) ?? false);
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

  return {
    watchlist,
    notifications,
    fcm,
    written,
    removed,
    sent,
    existsChecks,
  };
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
    const { uid, id, doc } = stores.written[0];
    expect(uid).toBe('u1');
    expect(id).toBe('100-NL-movie-available');
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

  it('tv appeared: one show-came-to-platform doc, never episode-aired (D3)', async () => {
    const stores = makeStores({ users: [user()] });
    const summary = await makeDispatcher(stores).dispatch(
      makeChange({ type: 'tv' }),
    );

    const kinds = stores.written.map((w) => w.doc.kind);
    expect(kinds).toEqual(['show-came-to-platform']);
    expect(kinds).not.toContain('episode-aired');
    expect(stores.written[0].id).toBe('100-NL-show-came-to-platform');
    expect(summary.notificationsWritten).toBe(1);
    expect(summary.fcmSent).toBe(1);
  });

  it('availability path never reads episodes (no EpisodeStore dependency)', async () => {
    // The dispatcher is constructed without an episodes port at all; this test
    // documents that the availability path is episode-free (D3). A movie/tv
    // appeared fires exactly the availability kind with no episode-aired.
    const stores = makeStores({ users: [user()] });
    const summary = await makeDispatcher(stores).dispatch(
      makeChange({ type: 'tv', previousProviders: [flatrate(1)] }),
    );
    // unchanged transition (flatrate → flatrate) → no availability kind and no
    // episode-aired, so nothing is written.
    expect(summary.transition).toBe('unchanged');
    expect(stores.written).toHaveLength(0);
    expect(stores.sent).toHaveLength(0);
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
    const stores = makeStores({ users: [user()] });
    await makeDispatcher(stores).dispatch(makeChange({ type: 'tv' }));

    expect(stores.written).toHaveLength(1);
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
    expect(stores.written[0].id).toBe('100-NL-movie-available');
    expect(stores.written[1].id).toBe('100-NL-movie-available');
  });

  describe('completed/dropped suppression (spec 0088)', () => {
    it("status 'completed': no notification, no FCM, usersConsidered 0", async () => {
      const stores = makeStores({ users: [user({ status: 'completed' })] });
      const summary = await makeDispatcher(stores).dispatch(makeChange());

      expect(stores.written).toHaveLength(0);
      expect(stores.sent).toHaveLength(0);
      expect(summary.usersConsidered).toBe(0);
      expect(summary.notificationsWritten).toBe(0);
      expect(summary.fcmSent).toBe(0);
    });

    it("status 'dropped': no notification, no FCM, usersConsidered 0", async () => {
      const stores = makeStores({ users: [user({ status: 'dropped' })] });
      const summary = await makeDispatcher(stores).dispatch(makeChange());

      expect(stores.written).toHaveLength(0);
      expect(stores.sent).toHaveLength(0);
      expect(summary.usersConsidered).toBe(0);
      expect(summary.notificationsWritten).toBe(0);
      expect(summary.fcmSent).toBe(0);
    });

    it("status 'planned': unaffected, notification fires as before", async () => {
      const stores = makeStores({ users: [user({ status: 'planned' })] });
      const summary = await makeDispatcher(stores).dispatch(makeChange());

      expect(stores.written).toHaveLength(1);
      expect(stores.written[0].doc.kind).toBe('movie-available');
      expect(stores.sent).toHaveLength(1);
      expect(summary.usersConsidered).toBe(1);
      expect(summary.notificationsWritten).toBe(1);
      expect(summary.fcmSent).toBe(1);
    });

    it('mixed statuses on the same title: only the eligible user is notified', async () => {
      const users = [
        user({ uid: 'a', titleId: 't-a', fcmTokens: [token('ta')] }), // watching
        user({
          uid: 'b',
          titleId: 't-b',
          fcmTokens: [token('tb')],
          status: 'completed',
        }),
      ];
      const stores = makeStores({ users });
      const summary = await makeDispatcher(stores).dispatch(makeChange());

      expect(stores.written.map((w) => w.uid)).toEqual(['a']);
      expect(stores.sent.map((s) => s.token)).toEqual(['ta']);
      expect(summary.usersConsidered).toBe(1);
      expect(summary.notificationsWritten).toBe(1);
      expect(summary.fcmSent).toBe(1);
    });
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

describe('dispatchEpisodeAired (spec 0089 / D3)', () => {
  beforeEach(() => vi.clearAllMocks());

  const RECENT = '2026-06-21T00:00:00.000Z'; // 1 day before NOW → in window

  const episodeChange = (
    overrides: Partial<EpisodeAiredChange> = {},
  ): EpisodeAiredChange => ({
    tmdbId: 100,
    region: 'NL',
    uid: 'u1',
    titleId: 'title-1',
    status: 'watching',
    notificationPrefs: allPrefs(),
    fcmTokens: [token('tok-1')],
    episodeId: 's01e001',
    airDate: RECENT,
    hasFlatrateNow: true,
    ...overrides,
  });

  const EXPECTED_ID = '100-NL-episode-aired-s01e001';

  it('happy path (watching, prefs on, flatrate, recent, not-yet-notified): one inbox doc + FCM to each token in-window', async () => {
    const stores = makeStores();
    const result = await makeDispatcher(stores).dispatchEpisodeAired(
      episodeChange({ fcmTokens: [token('tok-1'), token('tok-2')] }),
    );

    expect(result).toEqual({
      notified: true,
      fcmSent: 2,
      staleTokensPruned: 0,
    });
    expect(stores.written).toHaveLength(1);
    const { uid, id, doc } = stores.written[0];
    expect(uid).toBe('u1');
    expect(id).toBe(EXPECTED_ID);
    expect(doc.kind).toBe('episode-aired');
    expect(doc.payload).toEqual({
      tmdbId: 100,
      titleId: 'title-1',
      title: '',
      region: 'NL',
    });
    expect(doc.sentAt).toBe(NOW);
    expect(doc.readAt).toBeNull();

    expect(stores.sent.map((s) => s.token)).toEqual(['tok-1', 'tok-2']);
    // Exact-string FCM data assertions (F3 — no whitespace normalization).
    expect(stores.sent[0].data).toEqual({
      notificationId: EXPECTED_ID,
      titleId: 'title-1',
      kind: 'episode-aired',
      region: 'NL',
      tmdbId: '100',
      episodeId: 's01e001',
    });
    expect(stores.sent[0].data.kind).toBe('episode-aired');
    expect(stores.sent[0].data.episodeId).toBe('s01e001');
  });

  it("suppressed for status 'completed' → no write, no send", async () => {
    const stores = makeStores();
    const result = await makeDispatcher(stores).dispatchEpisodeAired(
      episodeChange({ status: 'completed' }),
    );
    expect(result.notified).toBe(false);
    expect(stores.written).toHaveLength(0);
    expect(stores.sent).toHaveLength(0);
  });

  it("suppressed for status 'dropped' → no write, no send", async () => {
    const stores = makeStores();
    const result = await makeDispatcher(stores).dispatchEpisodeAired(
      episodeChange({ status: 'dropped' }),
    );
    expect(result.notified).toBe(false);
    expect(stores.written).toHaveLength(0);
    expect(stores.sent).toHaveLength(0);
  });

  it('suppressed when prefs.episodeAired is false → no write, no send', async () => {
    const stores = makeStores();
    const result = await makeDispatcher(stores).dispatchEpisodeAired(
      episodeChange({
        notificationPrefs: allPrefs({ episodeAired: false }),
      }),
    );
    expect(result.notified).toBe(false);
    expect(stores.written).toHaveLength(0);
    expect(stores.sent).toHaveLength(0);
  });

  it('suppressed when not on flatrate → no write, no send', async () => {
    const stores = makeStores();
    const result = await makeDispatcher(stores).dispatchEpisodeAired(
      episodeChange({ hasFlatrateNow: false }),
    );
    expect(result.notified).toBe(false);
    expect(stores.written).toHaveLength(0);
    expect(stores.sent).toHaveLength(0);
  });

  it('suppressed when airDate is outside the recency window → no write, no send', async () => {
    const stores = makeStores();
    const result = await makeDispatcher(stores).dispatchEpisodeAired(
      episodeChange({ airDate: '2026-06-10T00:00:00.000Z' }), // > 3d before NOW
    );
    expect(result.notified).toBe(false);
    expect(stores.written).toHaveLength(0);
    expect(stores.sent).toHaveLength(0);
  });

  it('idempotent: when the per-episode id already exists → no write, no send', async () => {
    const stores = makeStores({
      existingIds: new Set([`u1|${EXPECTED_ID}`]),
    });
    const result =
      await makeDispatcher(stores).dispatchEpisodeAired(episodeChange());
    expect(result.notified).toBe(false);
    expect(stores.written).toHaveLength(0);
    expect(stores.sent).toHaveLength(0);
    expect(stores.existsChecks).toContainEqual({ uid: 'u1', id: EXPECTED_ID });
  });

  it('outside the delivery window: inbox doc written but NO FCM sent', async () => {
    const FIXED = '2024-03-15T08:30:00.000Z'; // UTC hour 8
    const stores = makeStores();
    const result = await makeDispatcher(stores, FIXED).dispatchEpisodeAired(
      episodeChange({
        airDate: '2024-03-14T00:00:00.000Z', // 1 day before FIXED → in window
        notificationPrefs: allPrefs({ deliveryHour: 10 }), // mismatch
      }),
    );
    expect(result).toEqual({
      notified: true,
      fcmSent: 0,
      staleTokensPruned: 0,
    });
    expect(stores.written).toHaveLength(1);
    expect(stores.sent).toHaveLength(0);
  });

  it('two distinct episodes → two distinct ids', async () => {
    const stores = makeStores();
    const dispatcher = makeDispatcher(stores);
    await dispatcher.dispatchEpisodeAired(
      episodeChange({ episodeId: 's01e001' }),
    );
    await dispatcher.dispatchEpisodeAired(
      episodeChange({ episodeId: 's01e002' }),
    );

    expect(stores.written.map((w) => w.id)).toEqual([
      '100-NL-episode-aired-s01e001',
      '100-NL-episode-aired-s01e002',
    ]);
  });

  it('stale token pruned exactly once', async () => {
    const stores = makeStores({
      users: [],
      unregisteredTokens: new Set(['stale']),
    });
    const result = await makeDispatcher(stores).dispatchEpisodeAired(
      episodeChange({ fcmTokens: [token('good'), token('stale')] }),
    );

    expect(result.staleTokensPruned).toBe(1);
    expect(stores.removed).toEqual([{ uid: 'u1', token: 'stale' }]);
    expect(stores.sent.map((s) => s.token).sort()).toEqual(['good', 'stale']);
  });

  // Three B1 airing-scan cases exercised via the dispatcher (spec 0089).
  describe('B1 walk-through cases', () => {
    it('(a) first-add back catalog: episodes aired weeks ago → none notified', async () => {
      const stores = makeStores();
      const dispatcher = makeDispatcher(stores);
      const oldDates = [
        '2026-05-01T00:00:00.000Z',
        '2026-05-08T00:00:00.000Z',
        '2026-05-15T00:00:00.000Z',
      ];
      for (const airDate of oldDates) {
        await dispatcher.dispatchEpisodeAired(episodeChange({ airDate }));
      }
      expect(stores.written).toHaveLength(0);
      expect(stores.sent).toHaveLength(0);
    });

    it('(b) new weekly episode: notified once, second run (exists) not re-notified', async () => {
      // The fake `exists` reads this set live, so persisting the id after the
      // first write makes the second run see the episode as already-notified.
      const existingIds = new Set<string>();
      const stores = makeStores({ existingIds });
      const dispatcher = makeDispatcher(stores);

      const first = await dispatcher.dispatchEpisodeAired(episodeChange());
      expect(first.notified).toBe(true);
      expect(stores.written).toHaveLength(1);
      // Simulate the write persisting the per-episode notified marker.
      existingIds.add(`${stores.written[0].uid}|${stores.written[0].id}`);

      // Second run within the window: exists true → skipped.
      const second = await dispatcher.dispatchEpisodeAired(episodeChange());
      expect(second.notified).toBe(false);
      expect(stores.written).toHaveLength(1);
    });

    it('(c) missed-day catch-up: episode aired yesterday, exists false → notified', async () => {
      const stores = makeStores();
      const result = await makeDispatcher(stores).dispatchEpisodeAired(
        episodeChange({ airDate: RECENT }),
      );
      expect(result.notified).toBe(true);
      expect(stores.written).toHaveLength(1);
    });
  });
});
