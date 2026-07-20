import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Firestore } from '@angular/fire/firestore';
import { AUTH_UID, PLEX_CLIENT } from '@vultus/shared/domain/tokens';
import type { PlexClient, PlexServer } from '@vultus/shared/domain';
import { userPath } from '@vultus/shared/firestore-schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the background service module so this spec stays off the plugin /
// @capacitor import chain (spec 0085). The unlink lifecycle only needs a `stop`
// spy; a bare class acts as the DI token, the instance is supplied via useValue.
vi.mock('./plex-background.service', () => ({
  PlexBackgroundService: class PlexBackgroundService {},
}));

import { PlexLinkService } from './plex-link.service';
import { PlexBackgroundService } from './plex-background.service';
import { PlexPinGoneError } from './plex-errors';

const bgStopMock = vi.fn<() => Promise<void>>();

// --- AngularFire mock ---
interface Ref {
  path: string;
}
const docMock = vi.fn((_fs: unknown, path: string): Ref => ({ path }));
const getDocMock = vi.fn<(ref: Ref) => Promise<unknown>>();
const updateDocMock = vi.fn<(ref: Ref, payload: unknown) => Promise<void>>();
// deleteField() returns a sentinel we can identify in the payload.
const DELETE_FIELD = { __op: 'deleteField' };

vi.mock('@angular/fire/firestore', () => ({
  Firestore: class Firestore {},
  doc: (fs: unknown, path: string): Ref => docMock(fs, path),
  getDoc: (ref: Ref): Promise<unknown> => getDocMock(ref),
  updateDoc: (ref: Ref, payload: unknown): Promise<void> =>
    updateDocMock(ref, payload),
  deleteField: () => DELETE_FIELD,
}));

// --- @capacitor/preferences mock ---
const prefsGetMock = vi.fn<() => Promise<{ value: string | null }>>();
const prefsSetMock = vi.fn<() => Promise<void>>();
const prefsRemoveMock = vi.fn<() => Promise<void>>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: (): Promise<{ value: string | null }> => prefsGetMock(),
    set: (): Promise<void> => prefsSetMock(),
    remove: (): Promise<void> => prefsRemoveMock(),
  },
}));

const UID = 'user-123';
const SERVER: PlexServer = {
  name: 'Test PMS',
  baseUrl: 'http://192.168.1.20:32400',
  accessToken: 'srv-token',
};

function snap(data: unknown) {
  return { exists: () => data !== undefined, data: () => data };
}

function makeClient(over: Partial<PlexClient> = {}): PlexClient {
  return {
    requestPin: vi
      .fn()
      .mockResolvedValue({ id: 1, code: 'H7X2', authToken: null }),
    checkPin: vi
      .fn()
      .mockResolvedValue({ id: 1, code: 'H7X2', authToken: 'tok' }),
    discoverServer: vi.fn().mockResolvedValue(SERVER),
    listLibrary: vi.fn().mockResolvedValue([]),
    listEpisodes: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

function makeService(client: PlexClient, uid: string | null = UID) {
  TestBed.configureTestingModule({
    providers: [
      PlexLinkService,
      { provide: Firestore, useValue: {} },
      { provide: AUTH_UID, useValue: signal<string | null>(uid) },
      { provide: PLEX_CLIENT, useValue: client },
      { provide: PlexBackgroundService, useValue: { stop: bgStopMock } },
    ],
  });
  return TestBed.inject(PlexLinkService);
}

/** Wait for pending microtasks + the immediate (0ms) poll timer to run. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('PlexLinkService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    TestBed.resetTestingModule();
    prefsGetMock.mockResolvedValue({ value: null });
    getDocMock.mockResolvedValue(snap(undefined));
    bgStopMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requestCode exposes the pin code and starts the countdown', async () => {
    const client = makeClient({
      // Never authorizes, so the flow stays in the code/waiting stage.
      checkPin: vi
        .fn()
        .mockResolvedValue({ id: 1, code: 'H7X2', authToken: null }),
    });
    const service = makeService(client);
    await service.requestCode();

    expect(service.code()).toBe('H7X2');
    expect(service.expiresInSeconds()).toBeGreaterThan(0);
    // Immediately after requestCode, the flow is waiting on authorization.
    expect(service.stage()).toBe('waiting');
    service.cancel();
  });

  it('poll: on authToken, persists token to Preferences, discovers server, writes hasPlex + plexSync', async () => {
    const discoverServer = vi.fn().mockResolvedValue(SERVER);
    const client = makeClient({ discoverServer });
    const service = makeService(client);
    await service.requestCode();
    await flush();

    // Token persisted ON-DEVICE (Preferences), never to Firestore.
    expect(prefsSetMock).toHaveBeenCalledTimes(1);
    expect(discoverServer).toHaveBeenCalledWith('tok');
    // Firestore link write: hasPlex true + plexSync.
    const write = updateDocMock.mock.calls.find(
      ([ref]) => ref.path === userPath(UID),
    );
    expect(write).toBeTruthy();
    const payload = write?.[1] as {
      hasPlex: boolean;
      plexSync: { linkedAt: string; lastSyncAt: string; serverName: string };
    };
    expect(payload.hasPlex).toBe(true);
    expect(payload.plexSync.serverName).toBe('Test PMS');
    expect(payload.plexSync.linkedAt).toBeTruthy();
    expect(payload.plexSync.lastSyncAt).toBeTruthy();
    expect(service.stage()).toBe('connected');
    expect(service.linked()).toBe(true);
  });

  it('poll never writes the token value to Firestore', async () => {
    const client = makeClient();
    const service = makeService(client);
    await service.requestCode();
    await flush();

    for (const [, payload] of updateDocMock.mock.calls) {
      expect(JSON.stringify(payload)).not.toContain('tok');
    }
  });

  it('pin expiry with no auth → error stage with reason "expired"', async () => {
    const client = makeClient({
      checkPin: vi
        .fn()
        .mockResolvedValue({ id: 1, code: 'H7X2', authToken: null }),
    });
    const service = makeService(client);
    await service.requestCode();
    // Advance past the 15-minute PIN TTL.
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1000);

    expect(service.stage()).toBe('error');
    expect(service.errorReason()).toBe('expired');
    expect(service.expiresInSeconds()).toBe(0);
  });

  it('checkPin PlexPinGoneError (plex.tv 404) → error stage with reason "expired"', async () => {
    const client = makeClient({
      checkPin: vi.fn().mockRejectedValue(new PlexPinGoneError()),
    });
    const service = makeService(client);
    await service.requestCode();
    await flush();

    expect(service.stage()).toBe('error');
    expect(service.errorReason()).toBe('expired');
  });

  it('requestPin throwing → error stage with reason "network"', async () => {
    const client = makeClient({
      requestPin: vi.fn().mockRejectedValue(new Error('offline')),
    });
    const service = makeService(client);
    await service.requestCode();

    expect(service.stage()).toBe('error');
    expect(service.errorReason()).toBe('network');
  });

  it('discoverServer throwing → error stage with reason "network", token NOT persisted', async () => {
    const client = makeClient({
      discoverServer: vi.fn().mockRejectedValue(new Error('http 401')),
    });
    const service = makeService(client);
    await service.requestCode();
    await flush();

    expect(service.stage()).toBe('error');
    expect(service.errorReason()).toBe('network');
    // Discovery runs BEFORE token persistence, so nothing was stored.
    expect(prefsSetMock).not.toHaveBeenCalled();
    expect(service.linked()).toBe(false);
  });

  it('poll tolerates a transient checkPin failure, then completes on the next tick', async () => {
    const checkPin = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket killed'))
      .mockResolvedValue({ id: 1, code: 'H7X2', authToken: 'tok' });
    const client = makeClient({ checkPin });
    const service = makeService(client);
    await service.requestCode();
    // First tick (t=0) rejects; the flow must NOT error — it reschedules.
    await flush();
    expect(service.stage()).toBe('waiting');
    // Next tick (t=2000ms) succeeds → connected.
    await vi.advanceTimersByTimeAsync(2000);

    expect(service.stage()).toBe('connected');
    expect(checkPin).toHaveBeenCalledTimes(2);
  });

  it('poll gives up after repeated checkPin failures → error stage with reason "network"', async () => {
    const client = makeClient({
      checkPin: vi.fn().mockRejectedValue(new Error('offline')),
    });
    const service = makeService(client);
    await service.requestCode();
    // 5 consecutive failures at t=0,2000,...,8000ms → give up.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(service.stage()).toBe('error');
    expect(service.errorReason()).toBe('network');
  });

  it('regenerateCode requests a fresh pin', async () => {
    const requestPin = vi
      .fn()
      .mockResolvedValue({ id: 1, code: 'H7X2', authToken: null });
    const client = makeClient({
      requestPin,
      checkPin: vi
        .fn()
        .mockResolvedValue({ id: 1, code: 'H7X2', authToken: null }),
    });
    const service = makeService(client);
    await service.requestCode();
    await service.regenerateCode();

    expect(requestPin).toHaveBeenCalledTimes(2);
    service.cancel();
  });

  it('discoverServer returning null → error "no-server", token NOT persisted (no half-link)', async () => {
    const client = makeClient({
      discoverServer: vi.fn().mockResolvedValue(null),
    });
    const service = makeService(client);
    await service.requestCode();
    await flush();

    expect(service.stage()).toBe('error');
    expect(service.errorReason()).toBe('no-server');
    // The token must NOT be persisted when discovery fails — otherwise the
    // Settings card would show "Connected" to a server that was never found.
    expect(prefsSetMock).not.toHaveBeenCalled();
    expect(service.linked()).toBe(false);
  });

  it('Firestore write failing after discovery rolls the token back (no half-link)', async () => {
    updateDocMock.mockRejectedValueOnce(new Error('permission-denied'));
    const service = makeService(makeClient());
    await service.requestCode();
    await flush();

    expect(service.stage()).toBe('error');
    expect(service.errorReason()).toBe('network');
    // Token was persisted then rolled back so the device is not half-linked.
    expect(prefsSetMock).toHaveBeenCalledTimes(1);
    expect(prefsRemoveMock).toHaveBeenCalledTimes(1);
    expect(service.linked()).toBe(false);
  });

  it('loadState self-heals a half-linked device: token present but no plexSync → drops token', async () => {
    prefsGetMock.mockResolvedValue({ value: 'orphan-token' });
    getDocMock.mockResolvedValue(
      snap({
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
          deliveryHour: null,
        },
        fcmTokens: [],
        myProviderIds: [],
        hasPlex: true,
        // No plexSync — the account is not linked (e.g. unlinked elsewhere).
      }),
    );
    const service = makeService(makeClient());
    await service.loadState();

    expect(prefsRemoveMock).toHaveBeenCalledTimes(1);
    expect(service.linked()).toBe(false);
    expect(service.serverName()).toBeNull();
  });

  it('unlink clears the Preferences token + writes plexSync deleteField(), keeps hasPlex, no watchlist/episode write', async () => {
    const service = makeService(makeClient());
    await service.unlink();

    expect(prefsRemoveMock).toHaveBeenCalledTimes(1);
    const write = updateDocMock.mock.calls.find(
      ([ref]) => ref.path === userPath(UID),
    );
    expect(write).toBeTruthy();
    const payload = write?.[1] as Record<string, unknown>;
    expect(payload['plexSync']).toBe(DELETE_FIELD);
    // Does NOT touch hasPlex.
    expect('hasPlex' in payload).toBe(false);
    // Touches ONLY the user doc — no watchlist/episode path write.
    for (const [ref] of updateDocMock.mock.calls) {
      expect(ref.path).toBe(userPath(UID));
    }
    expect(service.linked()).toBe(false);
  });

  it('unlink stops the background sync task (spec 0085)', async () => {
    const service = makeService(makeClient());
    await service.unlink();

    expect(bgStopMock).toHaveBeenCalledTimes(1);
  });

  it('unlink is null-uid guarded: clears Preferences but writes no Firestore doc', async () => {
    const service = makeService(makeClient(), null);
    await service.unlink();

    expect(prefsRemoveMock).toHaveBeenCalledTimes(1);
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('completeLink is null-uid guarded: persists token but writes no Firestore doc', async () => {
    const service = makeService(makeClient(), null);
    await service.requestCode();
    await flush();

    // Token still persisted on-device; no Firestore write without a uid.
    expect(prefsSetMock).toHaveBeenCalledTimes(1);
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('isLinked reflects the Preferences token presence', async () => {
    const service = makeService(makeClient());
    prefsGetMock.mockResolvedValue({ value: null });
    expect(await service.isLinked()).toBe(false);
    prefsGetMock.mockResolvedValue({ value: 'device-token' });
    expect(await service.isLinked()).toBe(true);
  });

  it('loadState reads plexSync serverName + lastSyncAt from the user doc', async () => {
    const lastSyncAt = new Date().toISOString();
    prefsGetMock.mockResolvedValue({ value: 'device-token' });
    getDocMock.mockResolvedValue(
      snap({
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
          deliveryHour: null,
        },
        fcmTokens: [],
        myProviderIds: [],
        hasPlex: true,
        plexSync: { linkedAt: lastSyncAt, lastSyncAt, serverName: 'My PMS' },
      }),
    );
    const service = makeService(makeClient());
    await service.loadState();

    expect(service.linked()).toBe(true);
    expect(service.serverName()).toBe('My PMS');
    expect(service.lastSyncAt()).toBe(lastSyncAt);
  });

  it('cancel stops the flow and returns to idle', async () => {
    const client = makeClient({
      checkPin: vi
        .fn()
        .mockResolvedValue({ id: 1, code: 'H7X2', authToken: null }),
    });
    const service = makeService(client);
    await service.requestCode();
    service.cancel();

    expect(service.stage()).toBe('idle');
    expect(service.code()).toBeNull();
  });
});
