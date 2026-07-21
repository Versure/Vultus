import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Firestore } from '@angular/fire/firestore';
import { AUTH_UID, PLEX_CLIENT } from '@vultus/shared/domain/tokens';
import type { PlexClient, PlexServer } from '@vultus/shared/domain';
import { userPath } from '@vultus/shared/firestore-schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingPlexLinkService } from './onboarding-plex-link.service';
import { PlexPinGoneError } from './plex-errors';

// --- AngularFire mock ---
interface Ref {
  path: string;
}
const docMock = vi.fn((_fs: unknown, path: string): Ref => ({ path }));
const updateDocMock = vi.fn<(ref: Ref, payload: unknown) => Promise<void>>();

vi.mock('@angular/fire/firestore', () => ({
  Firestore: class Firestore {},
  doc: (fs: unknown, path: string): Ref => docMock(fs, path),
  updateDoc: (ref: Ref, payload: unknown): Promise<void> =>
    updateDocMock(ref, payload),
}));

// --- @capacitor/preferences mock ---
const prefsSetMock = vi.fn<() => Promise<void>>();
const prefsRemoveMock = vi.fn<() => Promise<void>>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    set: (): Promise<void> => prefsSetMock(),
    remove: (): Promise<void> => prefsRemoveMock(),
  },
}));

const UID = 'user-123';
const AUTH_TOKEN = 'secret-x-plex-token';
const SERVER: PlexServer = {
  name: 'Test PMS',
  baseUrl: 'http://192.168.1.20:32400',
  accessToken: 'srv-token',
};

function makeClient(over: Partial<PlexClient> = {}): PlexClient {
  return {
    requestPin: vi
      .fn()
      .mockResolvedValue({ id: 1, code: 'H7X2', authToken: null }),
    checkPin: vi
      .fn()
      .mockResolvedValue({ id: 1, code: 'H7X2', authToken: AUTH_TOKEN }),
    discoverServer: vi.fn().mockResolvedValue(SERVER),
    listLibrary: vi.fn().mockResolvedValue([]),
    listEpisodes: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

function makeService(client: PlexClient, uid: string | null = UID) {
  TestBed.configureTestingModule({
    providers: [
      OnboardingPlexLinkService,
      { provide: Firestore, useValue: {} },
      { provide: AUTH_UID, useValue: signal<string | null>(uid) },
      { provide: PLEX_CLIENT, useValue: client },
    ],
  });
  return TestBed.inject(OnboardingPlexLinkService);
}

/** Wait for pending microtasks + the immediate (0ms) poll timer to run. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('OnboardingPlexLinkService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requestCode exposes the pin code, starts the countdown, and enters waiting', async () => {
    const client = makeClient({
      // Never authorizes, so the flow stays in the waiting stage.
      checkPin: vi
        .fn()
        .mockResolvedValue({ id: 1, code: 'H7X2', authToken: null }),
    });
    const service = makeService(client);
    await service.requestCode();

    expect(service.code()).toBe('H7X2');
    expect(service.expiresInSeconds()).toBeGreaterThan(0);
    expect(service.stage()).toBe('waiting');
    service.cancel();
  });

  it('happy path: poll returns token → discover → persist token → write hasPlex/plexSync → connected', async () => {
    const discoverServer = vi.fn().mockResolvedValue(SERVER);
    const client = makeClient({ discoverServer });
    const service = makeService(client);
    await service.requestCode();
    await flush();

    // Token persisted ON-DEVICE (Preferences), never to Firestore.
    expect(prefsSetMock).toHaveBeenCalledTimes(1);
    // Discovery runs with the auth token.
    expect(discoverServer).toHaveBeenCalledWith(AUTH_TOKEN);
    // Firestore link write: hasPlex true + plexSync, targeting users/{uid}.
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
    expect(service.server()).toEqual(SERVER);
  });

  it('ordering invariant: discovery returning null → error "no-server", NO token, NO Firestore write', async () => {
    const client = makeClient({
      discoverServer: vi.fn().mockResolvedValue(null),
    });
    const service = makeService(client);
    await service.requestCode();
    await flush();

    expect(service.stage()).toBe('error');
    expect(service.errorReason()).toBe('no-server');
    // The token must NOT be persisted when discovery finds no server, and no
    // Firestore write may occur (no half-linked device).
    expect(prefsSetMock).not.toHaveBeenCalled();
    expect(updateDocMock).not.toHaveBeenCalled();
    expect(service.server()).toBeNull();
  });

  it('ordering invariant: discoverServer throwing → error "network", token NOT persisted', async () => {
    const client = makeClient({
      discoverServer: vi.fn().mockRejectedValue(new Error('http 401')),
    });
    const service = makeService(client);
    await service.requestCode();
    await flush();

    expect(service.stage()).toBe('error');
    expect(service.errorReason()).toBe('network');
    // Discovery runs BEFORE token persistence, so nothing was stored/written.
    expect(prefsSetMock).not.toHaveBeenCalled();
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('rollback: Firestore write failing after token persist removes the token, stage error/network', async () => {
    updateDocMock.mockRejectedValueOnce(new Error('permission-denied'));
    const service = makeService(makeClient());
    await service.requestCode();
    await flush();

    expect(service.stage()).toBe('error');
    expect(service.errorReason()).toBe('network');
    // Token was persisted then rolled back so the device is not half-linked.
    expect(prefsSetMock).toHaveBeenCalledTimes(1);
    expect(prefsRemoveMock).toHaveBeenCalledTimes(1);
    expect(service.server()).toBeNull();
  });

  it('error discrimination: checkPin PlexPinGoneError → error "expired" immediately', async () => {
    const client = makeClient({
      checkPin: vi.fn().mockRejectedValue(new PlexPinGoneError()),
    });
    const service = makeService(client);
    await service.requestCode();
    await flush();

    expect(service.stage()).toBe('error');
    expect(service.errorReason()).toBe('expired');
    // A real expiry: never persists a token.
    expect(prefsSetMock).not.toHaveBeenCalled();
  });

  it('error discrimination: transient checkPin failure is tolerated, then completes on the next tick', async () => {
    const checkPin = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket killed'))
      .mockResolvedValue({ id: 1, code: 'H7X2', authToken: AUTH_TOKEN });
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

  it('error discrimination: repeated checkPin failures give up → error "network"', async () => {
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

  it('requestPin throwing → error stage with reason "network"', async () => {
    const client = makeClient({
      requestPin: vi.fn().mockRejectedValue(new Error('offline')),
    });
    const service = makeService(client);
    await service.requestCode();

    expect(service.stage()).toBe('error');
    expect(service.errorReason()).toBe('network');
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

  it('cancel stops timers and returns to idle (backs the "Skip for now" path)', async () => {
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
    expect(service.expiresInSeconds()).toBe(0);

    // After cancel, the poll must not resume nor complete a link on later ticks.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(service.stage()).toBe('idle');
    expect(prefsSetMock).not.toHaveBeenCalled();
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('null-uid guard: persists token on-device but writes no Firestore doc', async () => {
    const service = makeService(makeClient(), null);
    await service.requestCode();
    await flush();

    expect(prefsSetMock).toHaveBeenCalledTimes(1);
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('never writes the token value to Firestore', async () => {
    const service = makeService(makeClient());
    await service.requestCode();
    await flush();

    for (const [, payload] of updateDocMock.mock.calls) {
      expect(JSON.stringify(payload)).not.toContain(AUTH_TOKEN);
    }
  });

  it('never logs/echoes the token value (no console.* call carries it)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const infoSpy = vi
      .spyOn(console, 'info')
      .mockImplementation(() => undefined);
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const debugSpy = vi
      .spyOn(console, 'debug')
      .mockImplementation(() => undefined);

    const service = makeService(makeClient());
    await service.requestCode();
    await flush();

    const allArgs = [logSpy, infoSpy, warnSpy, errorSpy, debugSpy]
      .flatMap((spy) => spy.mock.calls)
      .flat();
    for (const arg of allArgs) {
      expect(JSON.stringify(arg)).not.toContain(AUTH_TOKEN);
    }

    logSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });
});
