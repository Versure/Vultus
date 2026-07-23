import { beforeEach, describe, expect, it, vi } from 'vitest';

// Verifies the spec-0099 composition-root wiring: the `syncTitles` cron handler
// builds its sync engine WITH a Watchmode client + activeRegions when
// WATCHMODE_API_KEY is set, and WITHOUT a client (undefined) when the key is
// empty (graceful no-key degrade). It invokes the REAL onRequest handler and
// inspects the config handed to `createSyncEngine` via a spy, mirroring the
// entry-point-shape test in sync-episodes.spec.ts.

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
    createTraktClient: vi.fn(() => ({}) as never),
    createWatchmodeClient: vi.fn(() => hoisted.watchmodeSentinel as never),
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
  getFirestore: vi.fn(
    () =>
      ({
        collectionGroup: () => ({ get: () => Promise.resolve({ docs: [] }) }),
      }) as never,
  ),
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

// The cron path computes activeRegions via gatherActiveRegions; stub the IO.
vi.mock('./lib/firestore-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/firestore-io')>();
  return {
    ...actual,
    gatherActiveRegions: vi.fn(() => Promise.resolve(['NL', 'DE'])),
    verifyIdToken: vi.fn(() => Promise.resolve({ uid: 'u1' })),
    readSyncState: vi.fn(() => Promise.resolve({ lastRunAt: null })),
    writeSyncState: vi.fn(() => Promise.resolve()),
    writeSyncRun: vi.fn(() => Promise.resolve()),
  };
});

async function invokeCron() {
  const { syncTitles } = await import('./main');
  const res = {
    status: () => res,
    json: () => res,
    send: () => res,
    headersSent: false,
  };
  const req = {
    method: 'POST',
    headers: { 'x-vultus-sync-secret': 'test-secret' },
    body: { force: true },
  };
  await (syncTitles as unknown as (rq: unknown, rs: unknown) => Promise<void>)(
    req,
    res,
  );
}

describe('syncTitles composition-root Watchmode wiring (spec 0099)', () => {
  beforeEach(() => {
    hoisted.syncEngineConfigSpy.mockClear();
  });

  // The config from the MOST RECENT createSyncEngine call. (The module graph is
  // imported once + cached; the spy is cleared per test so the last call is this
  // test's cron invocation.)
  function capturedConfig(): Record<string, unknown> {
    const calls = hoisted.syncEngineConfigSpy.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    return calls[calls.length - 1][0] as Record<string, unknown>;
  }

  it('builds the engine WITH a Watchmode client + activeRegions when the key is set', async () => {
    hoisted.watchmodeKeyValue.current = 'a-real-key';

    await invokeCron();

    const config = capturedConfig();
    expect(config.watchmode).toBe(hoisted.watchmodeSentinel);
    expect(config.activeRegions).toEqual(['NL', 'DE']);
  }, 60000);

  it('builds the engine WITHOUT a Watchmode client (undefined) when the key is empty (graceful degrade)', async () => {
    hoisted.watchmodeKeyValue.current = '';

    await invokeCron();

    const config = capturedConfig();
    expect(config.watchmode).toBeUndefined();
    // activeRegions is still computed + passed (harmless when no client).
    expect(config.activeRegions).toEqual(['NL', 'DE']);
  }, 60000);
});
