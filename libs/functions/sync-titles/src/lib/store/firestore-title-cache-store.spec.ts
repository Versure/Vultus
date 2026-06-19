import { describe, expect, it, vi } from 'vitest';
import type {
  RegionAvailability,
  TitleCacheEntry,
  TitleMetadata,
  WatchProvider,
} from '@vultus/shared/domain';
import {
  availabilityDocPath,
  availabilityPath,
  titleCacheDocPath,
} from '@vultus/shared/firestore-schema';
import { createFirestoreTitleCacheStore } from './firestore-title-cache-store';

const metadata: TitleMetadata = {
  title: 'Fight Club',
  overview: 'A man and his alter ego.',
  posterPath: '/poster.jpg',
  releaseDate: '1999-10-15T00:00:00.000Z',
};

const netflix: WatchProvider = {
  providerId: 8,
  name: 'Netflix',
  type: 'flatrate',
};
const disney: WatchProvider = {
  providerId: 337,
  name: 'Disney Plus',
  type: 'flatrate',
};

// A Firestore Timestamp-like read value: the read converters call `.toDate()`.
function ts(iso: string): { toDate: () => Date } {
  return { toDate: () => new Date(iso) };
}

interface DocCall {
  path: string;
  set: ReturnType<typeof vi.fn>;
  getData: () => unknown;
  exists: boolean;
}

interface CollectionCall {
  path: string;
  docs: { id: string; data: () => unknown }[];
}

// Fake Admin-SDK Firestore that records the path strings handed to doc() /
// collection() and returns canned snapshots. `docSnapshots` / `collSnapshots`
// map a path to its canned result; doc().set() spies are recorded per call.
function createFakeDb(opts: {
  docSnapshots?: Record<string, { exists: boolean; data: () => unknown }>;
  collSnapshots?: Record<string, { id: string; data: () => unknown }[]>;
}) {
  const docCalls: DocCall[] = [];
  const collectionCalls: CollectionCall[] = [];

  const db = {
    doc(path: string) {
      const set = vi.fn(() => Promise.resolve());
      const snap = opts.docSnapshots?.[path];
      const call: DocCall = {
        path,
        set,
        getData: () => snap?.data(),
        exists: snap?.exists ?? false,
      };
      docCalls.push(call);
      return {
        get: () =>
          Promise.resolve({
            exists: call.exists,
            data: () => snap?.data(),
          }),
        set,
      };
    },
    collection(path: string) {
      const docs = opts.collSnapshots?.[path] ?? [];
      collectionCalls.push({ path, docs });
      return {
        get: () => Promise.resolve({ docs }),
      };
    },
  };

  return { db, docCalls, collectionCalls };
}

describe('createFirestoreTitleCacheStore', () => {
  describe('getEntry', () => {
    it('maps an existing doc via dataToTitleCache at titleCacheDocPath', async () => {
      const path = titleCacheDocPath(603);
      const { db, docCalls } = createFakeDb({
        docSnapshots: {
          [path]: {
            exists: true,
            data: () => ({
              type: 'movie',
              traktId: null,
              metadata,
              lastSyncedAt: ts('2026-06-19T00:00:00.000Z'),
            }),
          },
        },
      });
      const store = createFirestoreTitleCacheStore(db as never);

      const entry = await store.getEntry(603);

      expect(docCalls[0].path).toBe(path);
      expect(entry).toEqual<TitleCacheEntry>({
        type: 'movie',
        traktId: null,
        metadata,
        lastSyncedAt: '2026-06-19T00:00:00.000Z',
      });
    });

    it('returns null when the doc does not exist', async () => {
      const path = titleCacheDocPath(999);
      const { db, docCalls } = createFakeDb({
        docSnapshots: { [path]: { exists: false, data: () => undefined } },
      });
      const store = createFirestoreTitleCacheStore(db as never);

      const entry = await store.getEntry(999);

      expect(docCalls[0].path).toBe(path);
      expect(entry).toBeNull();
    });
  });

  describe('getAvailability', () => {
    it('reads the availability subcollection, keyed by Region doc id, via dataToAvailability', async () => {
      const path = availabilityPath(603);
      const { db, collectionCalls } = createFakeDb({
        collSnapshots: {
          [path]: [
            {
              id: 'NL',
              data: () => ({
                providers: [netflix],
                lastSyncedAt: ts('2026-06-19T00:00:00.000Z'),
                previousSnapshot: [],
              }),
            },
            {
              id: 'US',
              data: () => ({
                providers: [disney],
                lastSyncedAt: ts('2026-06-18T00:00:00.000Z'),
                previousSnapshot: [netflix],
              }),
            },
          ],
        },
      });
      const store = createFirestoreTitleCacheStore(db as never);

      const result = await store.getAvailability(603);

      expect(collectionCalls[0].path).toBe(path);
      expect(result).toEqual({
        NL: {
          providers: [netflix],
          lastSyncedAt: '2026-06-19T00:00:00.000Z',
          previousSnapshot: [],
        },
        US: {
          providers: [disney],
          lastSyncedAt: '2026-06-18T00:00:00.000Z',
          previousSnapshot: [netflix],
        },
      });
    });

    it('returns {} for an empty subcollection', async () => {
      const path = availabilityPath(42);
      const { db, collectionCalls } = createFakeDb({
        collSnapshots: { [path]: [] },
      });
      const store = createFirestoreTitleCacheStore(db as never);

      const result = await store.getAvailability(42);

      expect(collectionCalls[0].path).toBe(path);
      expect(result).toEqual({});
    });
  });

  describe('putEntry', () => {
    it('sets the Date-typed converter output at titleCacheDocPath', async () => {
      const path = titleCacheDocPath(603);
      const { db, docCalls } = createFakeDb({});
      const store = createFirestoreTitleCacheStore(db as never);

      const entry: TitleCacheEntry = {
        type: 'movie',
        traktId: null,
        metadata,
        lastSyncedAt: '2026-06-19T00:00:00.000Z',
      };
      await store.putEntry(603, entry);

      expect(docCalls[0].path).toBe(path);
      expect(docCalls[0].set).toHaveBeenCalledTimes(1);
      const written = docCalls[0].set.mock.calls[0][0] as {
        lastSyncedAt: unknown;
        traktId: number | null;
      };
      // Converter output: a real Date (Admin SDK coerces Date→Timestamp), not a
      // hand-built Timestamp.
      expect(written.lastSyncedAt).toBeInstanceOf(Date);
      expect((written.lastSyncedAt as Date).toISOString()).toBe(
        '2026-06-19T00:00:00.000Z',
      );
      expect(written.traktId).toBeNull();
    });
  });

  describe('putAvailability', () => {
    it('sets the Date-typed converter output at availabilityDocPath', async () => {
      const path = availabilityDocPath(603, 'NL');
      const { db, docCalls } = createFakeDb({});
      const store = createFirestoreTitleCacheStore(db as never);

      const availability: RegionAvailability = {
        providers: [netflix],
        lastSyncedAt: '2026-06-19T00:00:00.000Z',
        previousSnapshot: [],
      };
      await store.putAvailability(603, 'NL', availability);

      expect(docCalls[0].path).toBe(path);
      expect(docCalls[0].set).toHaveBeenCalledTimes(1);
      const written = docCalls[0].set.mock.calls[0][0] as {
        lastSyncedAt: unknown;
        providers: WatchProvider[];
      };
      expect(written.lastSyncedAt).toBeInstanceOf(Date);
      expect(written.providers).toEqual([netflix]);
    });
  });

  describe('traktId round-trip (spec-0008 field)', () => {
    it.each([
      ['a numeric traktId', 1396, 'tv' as const],
      ['a null traktId', null, 'movie' as const],
    ])('flows %s through put then get', async (_label, traktId, type) => {
      const docPath = titleCacheDocPath(1396);
      // First a put captures the written data; then feed that back as a read
      // snapshot to confirm dataToTitleCache restores the same traktId.
      const putDb = createFakeDb({});
      const store = createFirestoreTitleCacheStore(putDb.db as never);

      const entry: TitleCacheEntry = {
        type,
        traktId,
        metadata,
        lastSyncedAt: '2026-06-19T00:00:00.000Z',
      };
      await store.putEntry(1396, entry);

      const written = putDb.docCalls[0].set.mock.calls[0][0] as {
        type: typeof type;
        traktId: number | null;
        metadata: TitleMetadata;
        lastSyncedAt: Date;
      };
      expect(written.traktId).toBe(traktId);

      // Read it back: wrap the Date as a Timestamp-like read value.
      const readDb = createFakeDb({
        docSnapshots: {
          [docPath]: {
            exists: true,
            data: () => ({
              type: written.type,
              traktId: written.traktId,
              metadata: written.metadata,
              lastSyncedAt: { toDate: () => written.lastSyncedAt },
            }),
          },
        },
      });
      const readStore = createFirestoreTitleCacheStore(readDb.db as never);
      const restored = await readStore.getEntry(1396);

      expect(restored).toEqual(entry);
      expect(restored?.traktId).toBe(traktId);
    });
  });
});
