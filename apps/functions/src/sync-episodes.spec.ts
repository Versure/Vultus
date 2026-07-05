import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type {
  EpisodeSyncEngine,
  EpisodeUpsertResult,
} from '@vultus/functions/sync-episodes';
import {
  episodePath,
  episodeToData,
  watchlistItemPath,
} from '@vultus/shared/firestore-schema';
import type { EpisodeDoc, WatchStatus } from '@vultus/shared/domain';
import {
  handleWatchlistCreate,
  createEpisodeUpsertStore,
  createWatchlistStatusStoreAdapter,
  type WatchlistCreateEvent,
} from './sync-episodes';

// --- Fake engine ---------------------------------------------------------

function fakeEngine() {
  const syncOne = vi.fn(
    (
      uid: string,
      titleId: string,
      tmdbId: number,
    ): Promise<EpisodeUpsertResult> =>
      Promise.resolve({
        uid,
        titleId,
        tmdbId,
        seasonsFetched: 1,
        episodesWritten: 0,
        outcome: 'synced',
      }),
  );
  const engine: EpisodeSyncEngine = {
    syncOne,
    syncAll: vi.fn(() => Promise.resolve([])),
  };
  return { engine, syncOne };
}

function event(
  data: Record<string, unknown> | undefined,
  params = { uid: 'u1', titleId: 'title-1' },
): WatchlistCreateEvent {
  return {
    params,
    data: data === undefined ? undefined : { data: () => data },
  };
}

// --- handleWatchlistCreate ----------------------------------------------

describe('handleWatchlistCreate (on-add trigger core)', () => {
  it('no-ops on a movie doc — syncOne is not called', async () => {
    const { engine, syncOne } = fakeEngine();
    await handleWatchlistCreate(event({ type: 'movie', tmdbId: 1 }), engine);
    expect(syncOne).not.toHaveBeenCalled();
  });

  it('no-ops on a malformed doc (missing tmdbId)', async () => {
    const { engine, syncOne } = fakeEngine();
    await handleWatchlistCreate(event({ type: 'tv' }), engine);
    expect(syncOne).not.toHaveBeenCalled();
  });

  it('no-ops on an empty event (no data)', async () => {
    const { engine, syncOne } = fakeEngine();
    await handleWatchlistCreate(event(undefined), engine);
    expect(syncOne).not.toHaveBeenCalled();
  });

  it('calls syncOne(uid, titleId, tmdbId) once on a tv doc', async () => {
    const { engine, syncOne } = fakeEngine();
    await handleWatchlistCreate(
      event({ type: 'tv', tmdbId: 1399 }, { uid: 'uX', titleId: 'tY' }),
      engine,
    );
    expect(syncOne).toHaveBeenCalledTimes(1);
    expect(syncOne).toHaveBeenCalledWith('uX', 'tY', 1399);
  });
});

// --- createEpisodeUpsertStore (Admin-SDK adapter) ------------------------

interface RecordedSet {
  path: string;
  data: unknown;
}

/** A fake Firestore that serves existing episode ids for one collection and
 *  records every batch.set path so we can assert which docs were written. */
function fakeDb(existingEpisodeIds: string[]) {
  const sets: RecordedSet[] = [];
  let committed = 0;

  const db = {
    collection: (path: string) => ({
      _path: path,
      get: () =>
        Promise.resolve({
          docs: existingEpisodeIds.map((id) => ({ id })),
        }),
    }),
    doc: (path: string) => ({ _path: path }),
    batch: () => ({
      set: (ref: { _path: string }, data: unknown) => {
        sets.push({ path: ref._path, data });
      },
      commit: () => {
        committed++;
        return Promise.resolve();
      },
    }),
  };

  return { db: db as unknown as Firestore, sets, commits: () => committed };
}

function doc(season: number, episode: number): EpisodeDoc {
  return {
    season,
    episode,
    title: `e${season}-${episode}`,
    airDate: '2026-01-01T00:00:00.000Z',
    watched: false,
    watchedAt: null,
  };
}

describe('createEpisodeUpsertStore', () => {
  it('getExistingEpisodeIds returns the collection doc ids as a Set', async () => {
    const { db } = fakeDb(['s01e001', 's01e002']);
    const store = createEpisodeUpsertStore(db);
    const ids = await store.getExistingEpisodeIds('u1', 'title-1');
    expect(ids).toEqual(new Set(['s01e001', 's01e002']));
  });

  it('writeEpisodes batches each new doc to its episode path via set', async () => {
    const { db, sets, commits } = fakeDb([]);
    const store = createEpisodeUpsertStore(db);

    await store.writeEpisodes('u1', 'title-1', [
      { id: 's01e001', doc: doc(1, 1) },
      { id: 's01e002', doc: doc(1, 2) },
    ]);

    expect(sets).toHaveLength(2);
    expect(sets[0].path).toBe(episodePath('u1', 'title-1', 's01e001'));
    expect(sets[0].data).toEqual(episodeToData(doc(1, 1)));
    expect(commits()).toBe(1);
  });

  it('writeEpisodes is a no-op (no batch) when given an empty list', async () => {
    const { db, sets, commits } = fakeDb([]);
    const store = createEpisodeUpsertStore(db);
    await store.writeEpisodes('u1', 'title-1', []);
    expect(sets).toHaveLength(0);
    expect(commits()).toBe(0);
  });

  it('only the ids handed to writeEpisodes are written — existing-id docs never appear', async () => {
    // The engine pre-filters; the adapter writes exactly what it is given. Here
    // we hand it only the new id and assert the existing one is never set.
    const { db, sets } = fakeDb(['s01e001']);
    const store = createEpisodeUpsertStore(db);
    await store.writeEpisodes('u1', 'title-1', [
      { id: 's01e002', doc: doc(1, 2) },
    ]);
    const writtenPaths = sets.map((s) => s.path);
    expect(writtenPaths).toEqual([episodePath('u1', 'title-1', 's01e002')]);
    expect(writtenPaths).not.toContain(episodePath('u1', 'title-1', 's01e001'));
  });

  it('chunks writes at the 500-op Firestore batch limit', async () => {
    const { db, sets, commits } = fakeDb([]);
    const store = createEpisodeUpsertStore(db);
    const many = Array.from({ length: 501 }, (_v, i) => ({
      id: `s01e${String(i).padStart(3, '0')}`,
      doc: doc(1, i),
    }));
    await store.writeEpisodes('u1', 'title-1', many);
    expect(sets).toHaveLength(501);
    expect(commits()).toBe(2); // 500 + 1
  });
});

// --- createWatchlistStatusStoreAdapter (Admin-SDK adapter, spec 0074) -----

interface RecordedUpdate {
  path: string;
  data: unknown;
}

/** A fake Firestore backing a SINGLE watchlist doc: `get()` returns `docData`,
 *  and `update()` records the path + patch so the test can assert the write. */
function fakeStatusDb(docData: Record<string, unknown> | undefined) {
  const gets: string[] = [];
  const updates: RecordedUpdate[] = [];

  const db = {
    doc: (path: string) => ({
      get: () => {
        gets.push(path);
        return Promise.resolve({ data: () => docData });
      },
      update: (data: unknown) => {
        updates.push({ path, data });
        return Promise.resolve();
      },
    }),
  };

  return { db: db as unknown as Firestore, gets, updates };
}

describe('createWatchlistStatusStoreAdapter', () => {
  it('getStatus reads `status` from the watchlist doc at watchlistItemPath', async () => {
    const { db, gets } = fakeStatusDb({ status: 'completed' });
    const store = createWatchlistStatusStoreAdapter(db);
    const status = await store.getStatus('u1', 'title-1');
    expect(status).toBe('completed');
    expect(gets).toEqual([watchlistItemPath('u1', 'title-1')]);
  });

  it('getStatus returns null when the `status` field is absent', async () => {
    const { db } = fakeStatusDb({ tmdbId: 1396 });
    const store = createWatchlistStatusStoreAdapter(db);
    expect(await store.getStatus('u1', 'title-1')).toBeNull();
  });

  it('getStatus returns null when the doc does not exist (undefined data)', async () => {
    const { db } = fakeStatusDb(undefined);
    const store = createWatchlistStatusStoreAdapter(db);
    expect(await store.getStatus('u1', 'title-1')).toBeNull();
  });

  it('setStatus calls .update({ status }) on the doc at watchlistItemPath', async () => {
    const { db, updates } = fakeStatusDb({ status: 'completed' });
    const store = createWatchlistStatusStoreAdapter(db);
    const next: WatchStatus = 'watching';
    await store.setStatus('u1', 'title-1', next);
    expect(updates).toEqual([
      {
        path: watchlistItemPath('u1', 'title-1'),
        data: { status: 'watching' },
      },
    ]);
  });
});
