import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Firestore } from '@angular/fire/firestore';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import { userPath } from '@vultus/shared/firestore-schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsService } from './settings.service';

// Mock the AngularFire Firestore module's free functions. `doc()` echoes the
// path so we can assert which document each write targets; getDoc is stubbed
// per-test.
interface DocRef {
  path: string;
}
interface SnapLike {
  exists: () => boolean;
  data: () => unknown;
}

const docMock = vi.fn(
  (_firestore: unknown, path: string): DocRef => ({ path }),
);
const getDocMock = vi.fn<(ref: DocRef) => Promise<SnapLike>>();
const setDocMock = vi.fn<(ref: DocRef, payload: unknown) => Promise<void>>();
const updateDocMock = vi.fn<(ref: DocRef, payload: unknown) => Promise<void>>();

vi.mock('@angular/fire/firestore', () => ({
  Firestore: class Firestore {},
  doc: (firestore: unknown, path: string) => docMock(firestore, path),
  getDoc: (ref: DocRef) => getDocMock(ref),
  setDoc: (ref: DocRef, payload: unknown) => setDocMock(ref, payload),
  updateDoc: (ref: DocRef, payload: unknown) => updateDocMock(ref, payload),
}));

const UID = 'user-123';
const USER_DOC = userPath(UID);

function existingDoc(data: {
  region: string;
  notificationPrefs: {
    episodeAired: boolean;
    movieAvailable: boolean;
    cameToPlatform: boolean;
  };
}): SnapLike {
  return {
    exists: () => true,
    data: () => ({ ...data, fcmTokens: [] }),
  };
}

const missingDoc: SnapLike = { exists: () => false, data: () => undefined };

function createService(uid: string | null): SettingsService {
  TestBed.configureTestingModule({
    providers: [
      SettingsService,
      { provide: Firestore, useValue: {} },
      { provide: AUTH_UID, useValue: signal<string | null>(uid) },
    ],
  });
  return TestBed.inject(SettingsService);
}

describe('SettingsService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    docMock.mockClear();
    getDocMock.mockReset();
    setDocMock.mockReset();
    updateDocMock.mockReset();
  });

  it('read-creates-doc-with-defaults', async () => {
    getDocMock.mockResolvedValue(missingDoc);
    const service = createService(UID);

    await service.load();

    expect(setDocMock).toHaveBeenCalledTimes(1);
    const [ref, payload] = setDocMock.mock.calls[0];
    expect(ref).toEqual({ path: USER_DOC });
    expect(payload).toEqual({
      region: 'NL',
      notificationPrefs: {
        episodeAired: true,
        movieAvailable: true,
        cameToPlatform: true,
      },
      fcmTokens: [],
    });
    expect(service.region()).toBe('NL');
    expect(service.notificationsEnabled()).toBe(true);
    expect(service.loaded()).toBe(true);
  });

  it('read-uses-existing (does not overwrite)', async () => {
    getDocMock.mockResolvedValue(
      existingDoc({
        region: 'DE',
        notificationPrefs: {
          episodeAired: false,
          movieAvailable: true,
          cameToPlatform: true,
        },
      }),
    );
    const service = createService(UID);

    await service.load();

    expect(setDocMock).not.toHaveBeenCalled();
    expect(service.region()).toBe('DE');
    // Projection: not all three true → off.
    expect(service.notificationsEnabled()).toBe(false);
  });

  it('load failure: getDoc throws → loadFailed true, loaded stays false', async () => {
    getDocMock.mockRejectedValue(new Error('offline'));
    const service = createService(UID);

    await service.load();

    expect(service.loadFailed()).toBe(true);
    expect(service.loaded()).toBe(false);
  });

  it('retryLoad clears loadFailed and re-attempts load (then succeeds)', async () => {
    // First attempt fails, second attempt resolves the doc.
    getDocMock.mockRejectedValueOnce(new Error('offline'));
    getDocMock.mockResolvedValueOnce(
      existingDoc({
        region: 'DE',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
        },
      }),
    );
    const service = createService(UID);

    await service.load();
    expect(service.loadFailed()).toBe(true);

    service.retryLoad();
    // retryLoad fires load() without awaiting; let the microtasks drain.
    await Promise.resolve();
    await Promise.resolve();

    expect(getDocMock).toHaveBeenCalledTimes(2);
    expect(service.loadFailed()).toBe(false);
    expect(service.loaded()).toBe(true);
    expect(service.region()).toBe('DE');
  });

  it('setRegion updates only region and the signal', async () => {
    const service = createService(UID);

    await service.setRegion('AU');

    expect(updateDocMock).toHaveBeenCalledTimes(1);
    const [ref, payload] = updateDocMock.mock.calls[0];
    expect(ref).toEqual({ path: USER_DOC });
    expect(payload).toEqual({ region: 'AU' });
    expect(service.region()).toBe('AU');
  });

  it('setNotificationsEnabled(false) sets all three prefs false, no fcmTokens', async () => {
    const service = createService(UID);

    await service.setNotificationsEnabled(false);

    expect(updateDocMock).toHaveBeenCalledTimes(1);
    const [ref, payload] = updateDocMock.mock.calls[0];
    expect(ref).toEqual({ path: USER_DOC });
    expect(payload).toEqual({
      notificationPrefs: {
        episodeAired: false,
        movieAvailable: false,
        cameToPlatform: false,
      },
    });
    expect(Object.keys(payload as object)).not.toContain('fcmTokens');
    expect(service.notificationsEnabled()).toBe(false);
  });

  it('setNotificationsEnabled(true) sets all three prefs true, no fcmTokens', async () => {
    const service = createService(UID);

    await service.setNotificationsEnabled(true);

    const [, payload] = updateDocMock.mock.calls[0];
    expect(payload).toEqual({
      notificationPrefs: {
        episodeAired: true,
        movieAvailable: true,
        cameToPlatform: true,
      },
    });
    expect(Object.keys(payload as object)).not.toContain('fcmTokens');
    expect(service.notificationsEnabled()).toBe(true);
  });

  it('null-uid guard: no Firestore access on load/setRegion/setNotificationsEnabled', async () => {
    const service = createService(null);

    await service.load();
    await service.setRegion('DE');
    await service.setNotificationsEnabled(false);

    expect(getDocMock).not.toHaveBeenCalled();
    expect(setDocMock).not.toHaveBeenCalled();
    expect(updateDocMock).not.toHaveBeenCalled();
    expect(service.loaded()).toBe(false);
  });

  it('every write targets users/{uid} (never a subcollection or title-cache)', async () => {
    getDocMock.mockResolvedValue(missingDoc);
    const service = createService(UID);

    await service.load();
    await service.setRegion('IT');
    await service.setNotificationsEnabled(false);

    const writtenPaths = [
      ...setDocMock.mock.calls,
      ...updateDocMock.mock.calls,
    ].map(([ref]) => ref.path);
    for (const path of writtenPaths) {
      expect(path).toBe(USER_DOC);
    }
  });
});
