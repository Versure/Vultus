import { beforeEach, describe, expect, it, vi } from 'vitest';

// Verifies the spec-0099 composition-root wiring AFTER the 0101 sharding split:
// the Watchmode client is now built in the `titleSyncWorker` (NOT the `syncTitles`
// coordinator, which enqueues shards and constructs no engine). The worker builds
// its sync engine WITH a Watchmode client + the shard payload's `activeRegions`
// when WATCHMODE_API_KEY is set, and WITHOUT a client (undefined) when the key is
// empty (graceful no-key degrade). It invokes the REAL onTaskDispatched worker via
// its CloudFunction `.run({ data })` and inspects the config handed to
// `createSyncEngine` via a spy — mirroring the worker-shape test in
// sync-episodes.spec.ts.

const hoisted = vi.hoisted(() => ({
  // Captures every config object passed to the (mocked) createSyncEngine.
  syncEngineConfigSpy: vi.fn(),
  // Mutable value the mocked WATCHMODE_API_KEY.value() returns per test.
  watchmodeKeyValue: { current: '' },
  // Sentinel returned by the mocked createWatchmodeClient.
  watchmodeSentinel: { __watchmode: true },
}));

vi.mock('@vultus/functions/sync-titles', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@vultus/functions/sync-titles')>();
  return {
    ...actual,
    createTmdbClient: vi.fn(() => ({}) as never),
    createWatchmodeClient: vi.fn(() => hoisted.watchmodeSentinel as never),
    createFirestoreTitleCacheStore: vi.fn(() => ({}) as never),
    createSyncEngine: vi.fn((config) => {
      hoisted.syncEngineConfigSpy(config);
      return { sync: () => Promise.resolve([]) } as never;
    }),
  };
});

vi.mock('@vultus/functions/sync-episodes', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@vultus/functions/sync-episodes')>();
  return {
    ...actual,
    createEpisodeSyncEngine: vi.fn(() => ({
      syncOne: vi.fn(() => Promise.resolve({}) as never),
      syncAll: vi.fn(() => Promise.resolve([])),
    })),
  };
});

vi.mock('firebase-admin/app', () => ({
  getApps: vi.fn(() => [{}]),
  initializeApp: vi.fn(),
}));

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(() => ({}) as never),
}));

vi.mock('firebase-admin/messaging', () => ({
  getMessaging: vi.fn(() => ({}) as never),
}));

vi.mock('firebase-functions/params', () => ({
  defineSecret: vi.fn(() => ({ value: () => 'test-secret', name: 'X' })),
  defineString: vi.fn((name: string) => ({
    value: () =>
      name === 'WATCHMODE_API_KEY'
        ? hoisted.watchmodeKeyValue.current
        : 'test-string',
    name,
  })),
}));

vi.mock('./dispatch-episode-aired', () => ({
  runEpisodeAiredScan: vi.fn(() => Promise.resolve()),
}));

// The worker records the shard result via the tracker; stub it so no Firestore
// transaction runs and the stage never reports "last shard" (skips onLastShard).
vi.mock('./lib/sync-run-tracker', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./lib/sync-run-tracker')>();
  return {
    ...actual,
    recordShardResult: vi.fn(() =>
      Promise.resolve({ isLastShardOfStage: false, finalized: false }),
    ),
  };
});

// A `title-sync` shard payload carrying the coordinator-gathered active regions.
function shardTask(activeRegions: string[]) {
  return {
    runId: 'run-1',
    shardIndex: 0,
    titles: [{ tmdbId: 603, type: 'movie' as const }],
    forced: false,
    activeRegions,
  };
}

async function runWorker(data: unknown): Promise<void> {
  const { titleSyncWorker } = await import('./main');
  await (
    titleSyncWorker as unknown as { run: (req: unknown) => Promise<void> }
  ).run({ data });
}

describe('titleSyncWorker composition-root Watchmode wiring (spec 0099 × 0101)', () => {
  beforeEach(() => {
    hoisted.syncEngineConfigSpy.mockClear();
  });

  // The config from the MOST RECENT createSyncEngine call. (The module graph is
  // imported once + cached; the spy is cleared per test so the last call is this
  // test's worker invocation.)
  function capturedConfig(): Record<string, unknown> {
    const calls = hoisted.syncEngineConfigSpy.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    return calls[calls.length - 1][0] as Record<string, unknown>;
  }

  it('builds the engine WITH a Watchmode client + the payload activeRegions when the key is set', async () => {
    hoisted.watchmodeKeyValue.current = 'a-real-key';

    await runWorker(shardTask(['NL', 'DE']));

    const config = capturedConfig();
    expect(config.watchmode).toBe(hoisted.watchmodeSentinel);
    expect(config.activeRegions).toEqual(['NL', 'DE']);
    // 0089/D2 retry args stay wired on the nightly (sharded) path.
    expect(config.retryErroredPasses).toBe(1);
    expect(config.retryDelayMs).toBe(2000);
  }, 60000);

  it('builds the engine WITHOUT a Watchmode client (undefined) when the key is empty (graceful degrade)', async () => {
    hoisted.watchmodeKeyValue.current = '';

    await runWorker(shardTask(['NL', 'DE']));

    const config = capturedConfig();
    expect(config.watchmode).toBeUndefined();
    // activeRegions is still passed through (harmless when there is no client).
    expect(config.activeRegions).toEqual(['NL', 'DE']);
  }, 60000);
});
