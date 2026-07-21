import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type { Messaging } from 'firebase-admin/messaging';
import {
  availabilityDocPath,
  episodesPath,
  notificationPath,
} from '@vultus/shared/firestore-schema';
import type {
  NotificationPrefs,
  WatchProvider,
  WatchStatus,
} from '@vultus/shared/domain';
import { runEpisodeAiredScan } from './dispatch-episode-aired';

// --- Time base --------------------------------------------------------------
// now() is fixed so recency (`[now-3d, now]`) is deterministic. Hour is 12 UTC,
// so `deliveryHour: null` (any time) and `deliveryHour: 12` are in-window and a
// different hour is out-of-window.
const NOW = '2026-06-19T12:00:00.000Z';
const now = () => NOW;
const daysBefore = (n: number): Date =>
  new Date(Date.parse(NOW) - n * 24 * 60 * 60 * 1000);

const FLATRATE: WatchProvider[] = [
  { providerId: 8, name: 'Netflix', type: 'flatrate' },
];
const RENT_ONLY: WatchProvider[] = [
  { providerId: 2, name: 'Apple TV', type: 'rent' },
];

const PREFS_ON: NotificationPrefs = {
  episodeAired: true,
  movieAvailable: true,
  cameToPlatform: true,
  deliveryHour: null,
};

// --- Fakes ------------------------------------------------------------------

interface FakeEpisode {
  id: string;
  airDate: Date;
}
interface FakeShow {
  uid: string;
  titleId: string;
  tmdbId: number;
  type?: 'tv' | 'movie';
  status?: WatchStatus;
  title: string;
  episodes?: FakeEpisode[];
}
interface FakeUser {
  region: string;
  notificationPrefs: NotificationPrefs;
  fcmTokens?: { token: string }[];
}

interface RecordedWrite {
  path: string;
  op: 'set' | 'update';
  data: unknown;
}

// A Firestore `Timestamp`-shaped value: exposes `.toDate()` returning a Date —
// NOT a bare ISO string. Forces the scan through the `dataToEpisode` conversion
// (NB5). A bare-string fake is deliberately NOT used here.
const timestamp = (d: Date) => ({ toDate: () => d });

function createFakeDb(opts: {
  shows: FakeShow[];
  users: Record<string, FakeUser | undefined>;
  availability?: Record<string, WatchProvider[]>;
  existingNotifications?: string[];
}) {
  const writes: RecordedWrite[] = [];
  const existing = new Set(opts.existingNotifications ?? []);

  const collectionGroup = (id: string) => ({
    get: () => {
      expect(id).toBe('watchlist');
      return Promise.resolve({
        docs: opts.shows.map((s) => ({
          id: s.titleId,
          data: () => ({
            tmdbId: s.tmdbId,
            type: s.type ?? 'tv',
            status: s.status,
            title: s.title,
          }),
          ref: { id: s.titleId, parent: { parent: { id: s.uid } } },
        })),
      });
    },
  });

  const collection = (path: string) => ({
    get: () => {
      const show = opts.shows.find(
        (s) => episodesPath(s.uid, s.titleId) === path,
      );
      const eps = show?.episodes ?? [];
      return Promise.resolve({
        docs: eps.map((e) => ({
          id: e.id,
          data: () => ({
            season: 1,
            episode: 1,
            title: null,
            airDate: timestamp(e.airDate),
            watched: false,
            watchedAt: null,
          }),
        })),
      });
    },
  });

  const doc = (path: string) => ({
    get: () => {
      // notification existence check
      if (/^users\/[^/]+\/notifications\/.+$/.test(path)) {
        return Promise.resolve({
          exists: existing.has(path),
          data: () => undefined,
        });
      }
      // user doc
      const userMatch = /^users\/([^/]+)$/.exec(path);
      if (userMatch) {
        const u = opts.users[userMatch[1]];
        return Promise.resolve({ exists: u !== undefined, data: () => u });
      }
      // availability doc
      const providers = opts.availability?.[path];
      if (providers !== undefined) {
        return Promise.resolve({ exists: true, data: () => ({ providers }) });
      }
      return Promise.resolve({ exists: false, data: () => undefined });
    },
    set: (data: unknown) => {
      writes.push({ path, op: 'set', data });
      existing.add(path); // subsequent exists() in the same run sees it
      return Promise.resolve();
    },
    update: (data: unknown) => {
      writes.push({ path, op: 'update', data });
      return Promise.resolve();
    },
  });

  const db = { collectionGroup, collection, doc } as unknown as Firestore;
  return { db, writes };
}

interface SentMessage {
  token: string;
  data: Record<string, string>;
  notification: { title: string; body: string };
}

function createFakeMessaging(unregisteredTokens: string[] = []) {
  const sent: SentMessage[] = [];
  const send = vi.fn((msg: SentMessage) => {
    sent.push(msg);
    if (unregisteredTokens.includes(msg.token)) {
      return Promise.reject(
        Object.assign(new Error('stale'), {
          code: 'messaging/registration-token-not-found',
        }),
      );
    }
    return Promise.resolve('msg-id');
  });
  const messaging = { send } as unknown as Messaging;
  return { messaging, sent, send };
}

// --- Tests ------------------------------------------------------------------

describe('runEpisodeAiredScan', () => {
  it('happy path: writes exactly one notification, sends FCM with episodeId, no title-cache/sync-runs/system write', async () => {
    const { db, writes } = createFakeDb({
      shows: [
        {
          uid: 'u1',
          titleId: 't1',
          tmdbId: 1396,
          title: 'Breaking Bad',
          status: 'watching',
          episodes: [{ id: 's05e014', airDate: daysBefore(1) }],
        },
      ],
      users: {
        u1: {
          region: 'NL',
          notificationPrefs: PREFS_ON,
          fcmTokens: [{ token: 'tok-1' }],
        },
      },
      availability: { [availabilityDocPath(1396, 'NL')]: FLATRATE },
    });
    const { messaging, sent } = createFakeMessaging();

    await runEpisodeAiredScan(db, messaging, now);

    // Exactly one notification doc create, at the per-episode id path.
    const expectedPath = notificationPath(
      'u1',
      '1396-NL-episode-aired-s05e014',
    );
    const notifWrites = writes.filter((w) => w.op === 'set');
    expect(notifWrites).toHaveLength(1);
    expect(notifWrites[0].path).toBe(expectedPath);

    // Only notification creates + (no) fcm prune are recorded — never
    // title-cache / sync-runs / system.
    for (const w of writes) {
      expect(w.path.startsWith('title-cache/')).toBe(false);
      expect(w.path.startsWith('sync-runs/')).toBe(false);
      expect(w.path.startsWith('system/')).toBe(false);
      expect(
        /^users\/[^/]+\/notifications\/.+$/.test(w.path) ||
          /^users\/[^/]+$/.test(w.path),
      ).toBe(true);
    }

    // FCM sent, and the data carries episodeId.
    expect(sent).toHaveLength(1);
    expect(sent[0].data.episodeId).toBe('s05e014');
    expect(sent[0].data.kind).toBe('episode-aired');
  });

  it('no-op: not on flatrate → nothing written, no FCM', async () => {
    const { db, writes } = createFakeDb({
      shows: [
        {
          uid: 'u1',
          titleId: 't1',
          tmdbId: 1396,
          title: 'Breaking Bad',
          episodes: [{ id: 's05e014', airDate: daysBefore(1) }],
        },
      ],
      users: {
        u1: {
          region: 'NL',
          notificationPrefs: PREFS_ON,
          fcmTokens: [{ token: 'x' }],
        },
      },
      availability: { [availabilityDocPath(1396, 'NL')]: RENT_ONLY },
    });
    const { messaging, sent } = createFakeMessaging();

    await runEpisodeAiredScan(db, messaging, now);

    expect(writes.filter((w) => w.op === 'set')).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('no-op: completed status → nothing written', async () => {
    const { db, writes } = createFakeDb({
      shows: [
        {
          uid: 'u1',
          titleId: 't1',
          tmdbId: 1396,
          title: 'Breaking Bad',
          status: 'completed',
          episodes: [{ id: 's05e014', airDate: daysBefore(1) }],
        },
      ],
      users: {
        u1: {
          region: 'NL',
          notificationPrefs: PREFS_ON,
          fcmTokens: [{ token: 'x' }],
        },
      },
      availability: { [availabilityDocPath(1396, 'NL')]: FLATRATE },
    });
    const { messaging, sent } = createFakeMessaging();

    await runEpisodeAiredScan(db, messaging, now);

    expect(writes.filter((w) => w.op === 'set')).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('no-op: episode outside the recency window → nothing written', async () => {
    const { db, writes } = createFakeDb({
      shows: [
        {
          uid: 'u1',
          titleId: 't1',
          tmdbId: 1396,
          title: 'Breaking Bad',
          episodes: [{ id: 's05e014', airDate: daysBefore(10) }],
        },
      ],
      users: {
        u1: {
          region: 'NL',
          notificationPrefs: PREFS_ON,
          fcmTokens: [{ token: 'x' }],
        },
      },
      availability: { [availabilityDocPath(1396, 'NL')]: FLATRATE },
    });
    const { messaging, sent } = createFakeMessaging();

    await runEpisodeAiredScan(db, messaging, now);

    expect(writes.filter((w) => w.op === 'set')).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('no-op: already-notified (exists true) → nothing written, no FCM', async () => {
    const existingPath = notificationPath(
      'u1',
      '1396-NL-episode-aired-s05e014',
    );
    const { db, writes } = createFakeDb({
      shows: [
        {
          uid: 'u1',
          titleId: 't1',
          tmdbId: 1396,
          title: 'Breaking Bad',
          episodes: [{ id: 's05e014', airDate: daysBefore(1) }],
        },
      ],
      users: {
        u1: {
          region: 'NL',
          notificationPrefs: PREFS_ON,
          fcmTokens: [{ token: 'x' }],
        },
      },
      availability: { [availabilityDocPath(1396, 'NL')]: FLATRATE },
      existingNotifications: [existingPath],
    });
    const { messaging, sent } = createFakeMessaging();

    await runEpisodeAiredScan(db, messaging, now);

    expect(writes.filter((w) => w.op === 'set')).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('first-add back catalog: all episodes aired weeks ago → writes nothing (no storm)', async () => {
    const { db, writes } = createFakeDb({
      shows: [
        {
          uid: 'u1',
          titleId: 't1',
          tmdbId: 1396,
          title: 'Breaking Bad',
          episodes: [
            { id: 's01e001', airDate: daysBefore(40) },
            { id: 's01e002', airDate: daysBefore(33) },
            { id: 's02e001', airDate: daysBefore(20) },
          ],
        },
      ],
      users: {
        u1: {
          region: 'NL',
          notificationPrefs: PREFS_ON,
          fcmTokens: [{ token: 'x' }],
        },
      },
      availability: { [availabilityDocPath(1396, 'NL')]: FLATRATE },
    });
    const { messaging, sent } = createFakeMessaging();

    await runEpisodeAiredScan(db, messaging, now);

    expect(writes.filter((w) => w.op === 'set')).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('BLOCKING (NB5): a Timestamp-shaped airDate in [now-3d, now] is converted and notified', async () => {
    // The episode fake returns airDate as a `.toDate()` object (a Timestamp),
    // NOT a bare ISO string. If the scan read `data.airDate` raw, the recency
    // comparison would receive an object (NaN) and never notify. A write here
    // proves `dataToEpisode` ran.
    const { db, writes } = createFakeDb({
      shows: [
        {
          uid: 'u1',
          titleId: 't1',
          tmdbId: 1396,
          title: 'Breaking Bad',
          episodes: [{ id: 's05e014', airDate: daysBefore(2) }],
        },
      ],
      users: {
        u1: {
          region: 'NL',
          notificationPrefs: PREFS_ON,
          fcmTokens: [{ token: 'tok-1' }],
        },
      },
      availability: { [availabilityDocPath(1396, 'NL')]: FLATRATE },
    });
    const { messaging, sent } = createFakeMessaging();

    await runEpisodeAiredScan(db, messaging, now);

    expect(writes.filter((w) => w.op === 'set')).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('per-title FCM body (NB4): two different shows yield two distinct bodies, each naming its own show', async () => {
    const { db } = createFakeDb({
      shows: [
        {
          uid: 'u1',
          titleId: 't1',
          tmdbId: 1396,
          title: 'Breaking Bad',
          episodes: [{ id: 's05e014', airDate: daysBefore(1) }],
        },
        {
          uid: 'u1',
          titleId: 't2',
          tmdbId: 1400,
          title: 'The Sopranos',
          episodes: [{ id: 's06e021', airDate: daysBefore(1) }],
        },
      ],
      users: {
        u1: {
          region: 'NL',
          notificationPrefs: PREFS_ON,
          fcmTokens: [{ token: 'tok-1' }],
        },
      },
      availability: {
        [availabilityDocPath(1396, 'NL')]: FLATRATE,
        [availabilityDocPath(1400, 'NL')]: FLATRATE,
      },
    });
    const { messaging, sent } = createFakeMessaging();

    await runEpisodeAiredScan(db, messaging, now);

    expect(sent).toHaveLength(2);
    const bodies = sent.map((m) => m.notification.body);
    // Distinct, and each contains its own show title (exact substring, no
    // whitespace normalization).
    expect(bodies[0]).not.toBe(bodies[1]);
    const forBreakingBad = bodies.find((b) => b.includes('Breaking Bad'));
    const forSopranos = bodies.find((b) => b.includes('The Sopranos'));
    expect(forBreakingBad).toBeDefined();
    expect(forSopranos).toBeDefined();
  });

  it('outside the delivery window: writes the inbox doc but sends no FCM (spec 0051)', async () => {
    const { db, writes } = createFakeDb({
      shows: [
        {
          uid: 'u1',
          titleId: 't1',
          tmdbId: 1396,
          title: 'Breaking Bad',
          episodes: [{ id: 's05e014', airDate: daysBefore(1) }],
        },
      ],
      users: {
        u1: {
          region: 'NL',
          notificationPrefs: { ...PREFS_ON, deliveryHour: 3 }, // NOW is hour 12
          fcmTokens: [{ token: 'tok-1' }],
        },
      },
      availability: { [availabilityDocPath(1396, 'NL')]: FLATRATE },
    });
    const { messaging, sent } = createFakeMessaging();

    await runEpisodeAiredScan(db, messaging, now);

    expect(writes.filter((w) => w.op === 'set')).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it('prunes a stale (unregistered) token exactly once via a users/{uid} update', async () => {
    const { db, writes } = createFakeDb({
      shows: [
        {
          uid: 'u1',
          titleId: 't1',
          tmdbId: 1396,
          title: 'Breaking Bad',
          episodes: [{ id: 's05e014', airDate: daysBefore(1) }],
        },
      ],
      users: {
        u1: {
          region: 'NL',
          notificationPrefs: PREFS_ON,
          fcmTokens: [{ token: 'stale' }],
        },
      },
      availability: { [availabilityDocPath(1396, 'NL')]: FLATRATE },
    });
    const { messaging } = createFakeMessaging(['stale']);

    await runEpisodeAiredScan(db, messaging, now);

    const prunes = writes.filter(
      (w) => w.op === 'update' && /^users\/[^/]+$/.test(w.path),
    );
    expect(prunes).toHaveLength(1);
  });

  it('movie watchlist entries are skipped (tv-only scan)', async () => {
    const { db, writes } = createFakeDb({
      shows: [
        {
          uid: 'u1',
          titleId: 't1',
          tmdbId: 603,
          type: 'movie',
          title: 'The Matrix',
          episodes: [{ id: 's01e001', airDate: daysBefore(1) }],
        },
      ],
      users: {
        u1: {
          region: 'NL',
          notificationPrefs: PREFS_ON,
          fcmTokens: [{ token: 'x' }],
        },
      },
      availability: { [availabilityDocPath(603, 'NL')]: FLATRATE },
    });
    const { messaging, sent } = createFakeMessaging();

    await runEpisodeAiredScan(db, messaging, now);

    expect(writes.filter((w) => w.op === 'set')).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});
