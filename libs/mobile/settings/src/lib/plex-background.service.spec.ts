import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- @transistorsoft/capacitor-background-fetch mock ---
// The `NETWORK_TYPE_UNMETERED` value the service reads off the plugin. Inlined as
// a literal in the (hoisted) vi.mock factory below — a plain top-level const
// can't be referenced there (TDZ); only the `vi.fn()` mocks are hoisted with it.
const NETWORK_TYPE_UNMETERED = 3;
const configureMock =
  vi.fn<
    (
      config: unknown,
      onEvent: (taskId: string) => void,
      onTimeout: (taskId: string) => void,
    ) => Promise<number>
  >();
const stopMock = vi.fn<() => Promise<void>>();
const finishMock = vi.fn<(taskId: string) => Promise<void>>();
vi.mock('@transistorsoft/capacitor-background-fetch', () => ({
  BackgroundFetch: {
    NETWORK_TYPE_UNMETERED: 3,
    configure: (
      config: unknown,
      onEvent: (taskId: string) => void,
      onTimeout: (taskId: string) => void,
    ): Promise<number> => configureMock(config, onEvent, onTimeout),
    stop: (): Promise<void> => stopMock(),
    finish: (taskId: string): Promise<void> => finishMock(taskId),
  },
}));

// --- @capacitor/core mock ---
const isNativeMock = vi.fn<() => boolean>();
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: (): boolean => isNativeMock() },
}));

// --- @capacitor/preferences mock ---
let store: Record<string, string | null>;
const prefsGetMock =
  vi.fn<(opts: { key: string }) => Promise<{ value: string | null }>>();
const prefsSetMock =
  vi.fn<(opts: { key: string; value: string }) => Promise<void>>();
const prefsRemoveMock = vi.fn<(opts: { key: string }) => Promise<void>>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: (opts: { key: string }): Promise<{ value: string | null }> =>
      prefsGetMock(opts),
    set: (opts: { key: string; value: string }): Promise<void> =>
      prefsSetMock(opts),
    remove: (opts: { key: string }): Promise<void> => prefsRemoveMock(opts),
  },
}));

// --- local-module mocks (avoid the real @angular/fire / plugin import chains) ---
// The service imports ONLY the `PLEX_TOKEN_KEY` constant from plex-link.service —
// supply its real value so the linked check reads the correct key.
vi.mock('./plex-link.service', () => ({ PLEX_TOKEN_KEY: 'plex_token' }));
vi.mock('./plex-sync.service', () => ({
  PlexSyncService: class PlexSyncService {},
}));

import {
  PLEX_BG_ENABLED_KEY,
  PLEX_BG_INTERVAL_KEY,
  PlexBackgroundService,
} from './plex-background.service';
import { PlexSyncService } from './plex-sync.service';

const TOKEN_KEY = 'plex_token';

interface SyncMock {
  sync: ReturnType<typeof vi.fn>;
}

function makeService(
  sync: SyncMock = { sync: vi.fn().mockResolvedValue({ status: 'ok' }) },
) {
  TestBed.configureTestingModule({
    providers: [
      PlexBackgroundService,
      { provide: PlexSyncService, useValue: sync },
    ],
  });
  return TestBed.inject(PlexBackgroundService);
}

/** Extract the onFetch (arg 1) / onTimeout (arg 2) callbacks passed to configure. */
function fetchCallbacks(): {
  onFetch: (taskId: string) => void;
  onTimeout: (taskId: string) => void;
} {
  const call = configureMock.mock.calls[0];
  return { onFetch: call[1], onTimeout: call[2] };
}

/**
 * Drain the microtask queue so the fire-and-forget `onFetch`/`onTimeout` work
 * (the callbacks are registered as `void`-returning per the plugin's type) runs
 * to completion, including the `finally` finish. A macrotask tick fires only
 * after all chained microtasks settle.
 */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('PlexBackgroundService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.resetTestingModule();
    store = {};
    isNativeMock.mockReturnValue(true);
    prefsGetMock.mockImplementation(({ key }) =>
      Promise.resolve({ value: store[key] ?? null }),
    );
    prefsSetMock.mockResolvedValue(undefined);
    prefsRemoveMock.mockResolvedValue(undefined);
    configureMock.mockResolvedValue(NETWORK_TYPE_UNMETERED);
    stopMock.mockResolvedValue(undefined);
    finishMock.mockResolvedValue(undefined);
  });

  it('defaults to enabled=true, intervalMinutes=60 with empty Preferences', async () => {
    const service = makeService();
    await service.init();
    expect(service.enabled()).toBe(true);
    expect(service.intervalMinutes()).toBe(60);
  });

  it('loads persisted config, overriding the defaults', async () => {
    store[PLEX_BG_ENABLED_KEY] = 'false';
    store[PLEX_BG_INTERVAL_KEY] = '180';
    const service = makeService();
    await service.init();
    expect(service.enabled()).toBe(false);
    expect(service.intervalMinutes()).toBe(180);
  });

  it('init (native) configures the plugin with the pinned args', async () => {
    const service = makeService();
    await service.init();
    expect(configureMock).toHaveBeenCalledTimes(1);
    const config = configureMock.mock.calls[0][0] as Record<string, unknown>;
    expect(config).toEqual({
      minimumFetchInterval: 60,
      requiredNetworkType: NETWORK_TYPE_UNMETERED,
      requiresBatteryNotLow: true,
      requiresCharging: false,
      stopOnTerminate: false,
      startOnBoot: true,
      enableHeadless: true,
    });
  });

  it('init (native) uses the persisted interval as minimumFetchInterval', async () => {
    store[PLEX_BG_INTERVAL_KEY] = '15';
    const service = makeService();
    await service.init();
    const config = configureMock.mock.calls[0][0] as {
      minimumFetchInterval: number;
    };
    expect(config.minimumFetchInterval).toBe(15);
  });

  it('init (native) when disabled configures then stops so nothing schedules', async () => {
    store[PLEX_BG_ENABLED_KEY] = 'false';
    const service = makeService();
    await service.init();
    expect(configureMock).toHaveBeenCalledTimes(1);
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it('init off-native is a no-op: no configure, no Preferences read, signals stay default', async () => {
    isNativeMock.mockReturnValue(false);
    const service = makeService();
    await service.init();
    expect(configureMock).not.toHaveBeenCalled();
    expect(prefsGetMock).not.toHaveBeenCalled();
    expect(service.enabled()).toBe(true);
    expect(service.intervalMinutes()).toBe(60);
  });

  it('onFetch runs sync when enabled AND linked, then always finishes', async () => {
    store[TOKEN_KEY] = 'device-token';
    const sync = { sync: vi.fn().mockResolvedValue({ status: 'ok' }) };
    const service = makeService(sync);
    await service.init();
    const { onFetch } = fetchCallbacks();
    onFetch('task-1');
    await flush();
    expect(sync.sync).toHaveBeenCalledTimes(1);
    expect(finishMock).toHaveBeenCalledWith('task-1');
  });

  it('onFetch does NOT sync when disabled, but still finishes', async () => {
    store[PLEX_BG_ENABLED_KEY] = 'false';
    store[TOKEN_KEY] = 'device-token';
    const sync = { sync: vi.fn().mockResolvedValue({ status: 'ok' }) };
    const service = makeService(sync);
    await service.init();
    const { onFetch } = fetchCallbacks();
    onFetch('task-2');
    await flush();
    expect(sync.sync).not.toHaveBeenCalled();
    expect(finishMock).toHaveBeenCalledWith('task-2');
  });

  it('onFetch does NOT sync when the plex_token is empty/absent, but still finishes', async () => {
    // No token in the store → not linked on this device.
    const sync = { sync: vi.fn().mockResolvedValue({ status: 'ok' }) };
    const service = makeService(sync);
    await service.init();
    const { onFetch } = fetchCallbacks();
    onFetch('task-3');
    await flush();
    expect(sync.sync).not.toHaveBeenCalled();
    expect(finishMock).toHaveBeenCalledWith('task-3');
  });

  it('onFetch ALWAYS finishes even when sync() throws (fail quietly)', async () => {
    store[TOKEN_KEY] = 'device-token';
    const sync = { sync: vi.fn().mockRejectedValue(new Error('boom')) };
    const service = makeService(sync);
    await service.init();
    const { onFetch } = fetchCallbacks();
    onFetch('task-4');
    await flush();
    expect(finishMock).toHaveBeenCalledWith('task-4');
  });

  it('onTimeout finishes the task', async () => {
    const service = makeService();
    await service.init();
    const { onTimeout } = fetchCallbacks();
    onTimeout('task-5');
    await flush();
    expect(finishMock).toHaveBeenCalledWith('task-5');
  });

  it('web-guard: setEnabled/setIntervalMinutes/stop write Preferences but make NO plugin call off-native', async () => {
    isNativeMock.mockReturnValue(false);
    const service = makeService();
    await service.setEnabled(false);
    await service.setIntervalMinutes(180);
    await service.stop();
    // Preferences still written/cleared.
    expect(prefsSetMock).toHaveBeenCalledWith({
      key: PLEX_BG_ENABLED_KEY,
      value: 'false',
    });
    expect(prefsSetMock).toHaveBeenCalledWith({
      key: PLEX_BG_INTERVAL_KEY,
      value: '180',
    });
    expect(prefsRemoveMock).toHaveBeenCalledWith({ key: PLEX_BG_ENABLED_KEY });
    expect(prefsRemoveMock).toHaveBeenCalledWith({ key: PLEX_BG_INTERVAL_KEY });
    // But the plugin is NEVER touched off-native.
    expect(configureMock).not.toHaveBeenCalled();
    expect(stopMock).not.toHaveBeenCalled();
    // The signals still update for the UI.
    expect(service.enabled()).toBe(false);
    expect(service.intervalMinutes()).toBe(180);
  });

  it('setEnabled(false) (native) persists false and stops the plugin', async () => {
    const service = makeService();
    await service.setEnabled(false);
    expect(prefsSetMock).toHaveBeenCalledWith({
      key: PLEX_BG_ENABLED_KEY,
      value: 'false',
    });
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it('setEnabled(true) (native) persists true and configures/starts the plugin', async () => {
    const service = makeService();
    await service.setEnabled(true);
    expect(prefsSetMock).toHaveBeenCalledWith({
      key: PLEX_BG_ENABLED_KEY,
      value: 'true',
    });
    expect(configureMock).toHaveBeenCalledTimes(1);
    expect(stopMock).not.toHaveBeenCalled();
  });

  it('setIntervalMinutes(180) (native) persists 180 and reconfigures with minimumFetchInterval 180', async () => {
    const service = makeService();
    await service.setIntervalMinutes(180);
    expect(prefsSetMock).toHaveBeenCalledWith({
      key: PLEX_BG_INTERVAL_KEY,
      value: '180',
    });
    const config = configureMock.mock.calls[0][0] as {
      minimumFetchInterval: number;
    };
    expect(config.minimumFetchInterval).toBe(180);
    expect(service.intervalMinutes()).toBe(180);
  });

  it('setIntervalMinutes clamps a value below 15 to 15', async () => {
    const service = makeService();
    await service.setIntervalMinutes(5);
    expect(service.intervalMinutes()).toBe(15);
    expect(prefsSetMock).toHaveBeenCalledWith({
      key: PLEX_BG_INTERVAL_KEY,
      value: '15',
    });
    const config = configureMock.mock.calls[0][0] as {
      minimumFetchInterval: number;
    };
    expect(config.minimumFetchInterval).toBe(15);
  });

  it('stop() clears both bg keys unconditionally and calls BackgroundFetch.stop() when native', async () => {
    const service = makeService();
    await service.stop();
    expect(prefsRemoveMock).toHaveBeenCalledWith({ key: PLEX_BG_ENABLED_KEY });
    expect(prefsRemoveMock).toHaveBeenCalledWith({ key: PLEX_BG_INTERVAL_KEY });
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it('stop() off-native clears the keys but does NOT call BackgroundFetch.stop()', async () => {
    isNativeMock.mockReturnValue(false);
    const service = makeService();
    await service.stop();
    expect(prefsRemoveMock).toHaveBeenCalledTimes(2);
    expect(stopMock).not.toHaveBeenCalled();
  });
});
