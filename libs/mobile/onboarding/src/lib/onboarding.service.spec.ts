import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Firestore } from '@angular/fire/firestore';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import { userPath } from '@vultus/shared/firestore-schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ONBOARDING_DONE_KEY } from './onboarding.guard';
import { OnboardingService } from './onboarding.service';

// --- AngularFire Firestore mock ---------------------------------------------
// `doc()` echoes the path so we can assert which document each write targets;
// `arrayUnion` wraps its payload so we can inspect the unioned token.
interface DocRef {
  path: string;
}
const docMock = vi.fn(
  (_firestore: unknown, path: string): DocRef => ({ path }),
);
const setDocMock =
  vi.fn<(ref: DocRef, payload: unknown, opts?: unknown) => Promise<void>>();
const updateDocMock = vi.fn<(ref: DocRef, payload: unknown) => Promise<void>>();
const getDocMock = vi.fn<(ref: DocRef) => Promise<unknown>>();
const arrayUnionMock = vi.fn((value: unknown) => ({ __arrayUnion: value }));

vi.mock('@angular/fire/firestore', () => ({
  Firestore: class Firestore {},
  doc: (firestore: unknown, path: string) => docMock(firestore, path),
  setDoc: (ref: DocRef, payload: unknown, opts?: unknown) =>
    setDocMock(ref, payload, opts),
  updateDoc: (ref: DocRef, payload: unknown) => updateDocMock(ref, payload),
  getDoc: (ref: DocRef) => getDocMock(ref),
  arrayUnion: (value: unknown) => arrayUnionMock(value),
}));

// --- Capacitor plugin mocks --------------------------------------------------
const isNativePlatformMock = vi.fn<() => boolean>();
const requestPermissionsMock = vi.fn<() => Promise<{ receive: string }>>();
const registerMock = vi.fn<() => Promise<void>>();
const preferencesSetMock =
  vi.fn<(opts: { key: string; value: string }) => Promise<void>>();

// addListener: when called for 'registration', synchronously invoke the
// callback with a fixed token, then return a handle with a no-op remove().
type Listener = (payload: unknown) => void;
const addListenerMock = vi.fn(
  (event: string, cb: Listener): Promise<{ remove: () => Promise<void> }> => {
    if (event === 'registration') {
      cb({ value: 'test-fcm-token' });
    }
    return Promise.resolve({ remove: () => Promise.resolve() });
  },
);

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => isNativePlatformMock() },
}));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    set: (opts: { key: string; value: string }) => preferencesSetMock(opts),
  },
}));
vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    requestPermissions: () => requestPermissionsMock(),
    register: () => registerMock(),
    addListener: (event: string, cb: Listener) => addListenerMock(event, cb),
  },
}));

const UID = 'user-123';
const USER_DOC = userPath(UID);

function createService(uid: string | null): OnboardingService {
  TestBed.configureTestingModule({
    providers: [
      OnboardingService,
      { provide: Firestore, useValue: {} },
      { provide: AUTH_UID, useValue: signal<string | null>(uid) },
    ],
  });
  return TestBed.inject(OnboardingService);
}

describe('OnboardingService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    docMock.mockClear();
    setDocMock.mockReset().mockResolvedValue(undefined);
    updateDocMock.mockReset().mockResolvedValue(undefined);
    arrayUnionMock.mockClear();
    isNativePlatformMock.mockReset().mockReturnValue(false);
    requestPermissionsMock.mockReset().mockResolvedValue({ receive: 'denied' });
    registerMock.mockReset().mockResolvedValue(undefined);
    preferencesSetMock.mockReset().mockResolvedValue(undefined);
    addListenerMock.mockClear();
  });

  it('creates user doc with chosen region', async () => {
    const service = createService(UID);

    await service.complete('DE');

    expect(setDocMock).toHaveBeenCalledTimes(1);
    const [ref, payload, opts] = setDocMock.mock.calls[0];
    expect(ref).toEqual({ path: USER_DOC });
    expect(payload).toEqual({
      region: 'DE',
      notificationPrefs: {
        episodeAired: true,
        movieAvailable: true,
        cameToPlatform: true,
      },
      fcmTokens: [],
    });
    expect(opts).toEqual({ merge: true });
  });

  it('web (non-native) skips push flow but still completes', async () => {
    isNativePlatformMock.mockReturnValue(false);
    const service = createService(UID);

    await service.complete('NL');

    expect(requestPermissionsMock).not.toHaveBeenCalled();
    expect(registerMock).not.toHaveBeenCalled();
    expect(updateDocMock).not.toHaveBeenCalled();
    expect(preferencesSetMock).toHaveBeenCalledWith({
      key: ONBOARDING_DONE_KEY,
      value: 'true',
    });
  });

  it('native + granted writes a token', async () => {
    isNativePlatformMock.mockReturnValue(true);
    requestPermissionsMock.mockResolvedValue({ receive: 'granted' });
    const service = createService(UID);

    await service.complete('GB');

    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(arrayUnionMock).toHaveBeenCalledTimes(1);
    const unioned = arrayUnionMock.mock.calls[0][0] as {
      token: string;
      deviceId: string;
      createdAt: unknown;
    };
    expect(unioned.token).toBe('test-fcm-token');
    expect(unioned.deviceId).toBe('android');
    expect(unioned.createdAt).toBeInstanceOf(Date);

    expect(updateDocMock).toHaveBeenCalledTimes(1);
    const [ref, payload] = updateDocMock.mock.calls[0];
    expect(ref).toEqual({ path: USER_DOC });
    expect(payload).toEqual({
      fcmTokens: { __arrayUnion: unioned },
    });

    expect(preferencesSetMock).toHaveBeenCalledWith({
      key: ONBOARDING_DONE_KEY,
      value: 'true',
    });
  });

  it('native + denied proceeds silently', async () => {
    isNativePlatformMock.mockReturnValue(true);
    requestPermissionsMock.mockResolvedValue({ receive: 'denied' });
    const service = createService(UID);

    await expect(service.complete('FR')).resolves.toBeUndefined();

    expect(registerMock).not.toHaveBeenCalled();
    expect(updateDocMock).not.toHaveBeenCalled();
    expect(preferencesSetMock).toHaveBeenCalledWith({
      key: ONBOARDING_DONE_KEY,
      value: 'true',
    });
  });

  it('push error never blocks completion', async () => {
    isNativePlatformMock.mockReturnValue(true);
    requestPermissionsMock.mockRejectedValue(new Error('boom'));
    const service = createService(UID);

    await expect(service.complete('US')).resolves.toBeUndefined();

    expect(updateDocMock).not.toHaveBeenCalled();
    expect(preferencesSetMock).toHaveBeenCalledWith({
      key: ONBOARDING_DONE_KEY,
      value: 'true',
    });
  });

  it('null-uid: skips Firestore but still sets completion flag', async () => {
    const service = createService(null);

    await service.complete('DE');

    expect(setDocMock).not.toHaveBeenCalled();
    expect(updateDocMock).not.toHaveBeenCalled();
    expect(getDocMock).not.toHaveBeenCalled();
    // Even without a uid the user must be able to proceed — the flag is always set.
    expect(preferencesSetMock).toHaveBeenCalledWith({
      key: ONBOARDING_DONE_KEY,
      value: 'true',
    });
  });

  it('Firestore write error never blocks completion', async () => {
    setDocMock.mockRejectedValue(new Error('firestore unavailable'));
    const service = createService(UID);

    await expect(service.complete('NL')).resolves.toBeUndefined();

    expect(preferencesSetMock).toHaveBeenCalledWith({
      key: ONBOARDING_DONE_KEY,
      value: 'true',
    });
  });

  it('every write targets users/{uid}', async () => {
    isNativePlatformMock.mockReturnValue(true);
    requestPermissionsMock.mockResolvedValue({ receive: 'granted' });
    const service = createService(UID);

    await service.complete('IT');

    const writtenPaths = [
      ...setDocMock.mock.calls,
      ...updateDocMock.mock.calls,
    ].map(([ref]) => ref.path);
    expect(writtenPaths.length).toBeGreaterThan(0);
    for (const path of writtenPaths) {
      expect(path).toBe(USER_DOC);
    }
  });
});
