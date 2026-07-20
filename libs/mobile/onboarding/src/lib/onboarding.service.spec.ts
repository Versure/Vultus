import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Firestore } from '@angular/fire/firestore';
import type { CatalogProvider } from '@vultus/shared/domain';
import { AUTH_UID, GET_WATCH_PROVIDERS } from '@vultus/shared/domain/tokens';
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

// Provider catalog fixtures (TMDB ids used elsewhere in the repo's specs).
const NETFLIX: CatalogProvider = {
  providerId: 8,
  name: 'Netflix',
  logoPath: '/netflix.jpg',
};
const DISNEY: CatalogProvider = {
  providerId: 337,
  name: 'Disney Plus',
  logoPath: '/disney.jpg',
};
const MAX: CatalogProvider = {
  providerId: 1899,
  name: 'Max',
  logoPath: '/max.jpg',
};

let getWatchProvidersMock: ReturnType<
  typeof vi.fn<(region: string) => Promise<CatalogProvider[]>>
>;

function createService(uid: string | null): OnboardingService {
  TestBed.configureTestingModule({
    providers: [
      OnboardingService,
      { provide: Firestore, useValue: {} },
      { provide: AUTH_UID, useValue: signal<string | null>(uid) },
      { provide: GET_WATCH_PROVIDERS, useValue: getWatchProvidersMock },
    ],
  });
  return TestBed.inject(OnboardingService);
}

const DEFAULT_PREFS = {
  episodeAired: true,
  movieAvailable: true,
  cameToPlatform: true,
  deliveryHour: null,
};

describe('OnboardingService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    docMock.mockClear();
    setDocMock.mockReset().mockResolvedValue(undefined);
    updateDocMock.mockReset().mockResolvedValue(undefined);
    getDocMock.mockReset();
    arrayUnionMock.mockClear();
    isNativePlatformMock.mockReset().mockReturnValue(false);
    requestPermissionsMock.mockReset().mockResolvedValue({ receive: 'denied' });
    registerMock.mockReset().mockResolvedValue(undefined);
    preferencesSetMock.mockReset().mockResolvedValue(undefined);
    addListenerMock.mockClear();
    getWatchProvidersMock = vi.fn(() => Promise.resolve<CatalogProvider[]>([]));
  });

  // --- Step state ------------------------------------------------------------
  describe('step navigation', () => {
    it('starts at step 1 and advances/retreats within 1..5', () => {
      const service = createService(UID);
      expect(service.currentStep()).toBe(1);

      service.next();
      expect(service.currentStep()).toBe(2);
      service.back();
      expect(service.currentStep()).toBe(1);

      // back() is a no-op before step 1.
      service.back();
      expect(service.currentStep()).toBe(1);

      // next() is a no-op past step 5.
      service.next();
      service.next();
      service.next();
      service.next();
      service.next();
      expect(service.currentStep()).toBe(5);
    });
  });

  // --- Step 1: region create-with-defaults -----------------------------------
  describe('setRegion (step 1)', () => {
    it('first write creates users/{uid} with defaults via merge', async () => {
      const service = createService(UID);

      await service.setRegion('DE');

      expect(setDocMock).toHaveBeenCalledTimes(1);
      const [ref, payload, opts] = setDocMock.mock.calls[0];
      expect(ref).toEqual({ path: USER_DOC });
      expect(payload).toEqual({
        region: 'DE',
        notificationPrefs: DEFAULT_PREFS,
        fcmTokens: [],
        myProviderIds: [],
        hasPlex: false,
        plexSync: null,
      });
      expect(opts).toEqual({ merge: true });
      expect(service.region()).toBe('DE');
    });

    it('a later write updates only the region (no re-create) when nothing selected', async () => {
      getWatchProvidersMock.mockResolvedValue([NETFLIX, DISNEY]);
      const service = createService(UID);

      await service.setRegion('NL'); // create
      setDocMock.mockClear();
      updateDocMock.mockClear();

      await service.setRegion('DE'); // later write, no providers selected

      expect(setDocMock).not.toHaveBeenCalled();
      // First write is the region scalar; no prune write (empty selection).
      expect(updateDocMock).toHaveBeenCalledTimes(1);
      expect(updateDocMock.mock.calls[0][1]).toEqual({ region: 'DE' });
      expect(service.region()).toBe('DE');
    });
  });

  // --- Step 2: providers -----------------------------------------------------
  describe('toggleProvider (step 2)', () => {
    it('persists the WHOLE myProviderIds array (add then remove)', async () => {
      const service = createService(UID);

      await service.toggleProvider(8);
      expect(updateDocMock.mock.calls[0][1]).toEqual({ myProviderIds: [8] });

      await service.toggleProvider(15);
      expect(updateDocMock.mock.calls[1][1]).toEqual({
        myProviderIds: [8, 15],
      });
      expect(service.myProviderIds()).toEqual([8, 15]);

      // Re-toggling 8 removes it.
      await service.toggleProvider(8);
      expect(updateDocMock.mock.calls[2][1]).toEqual({ myProviderIds: [15] });
      expect(service.myProviderIds()).toEqual([15]);

      // Every provider write targets users/{uid}.
      for (const [ref] of updateDocMock.mock.calls) {
        expect(ref).toEqual({ path: USER_DOC });
      }
    });

    it('loadProviderCatalog fetches for the current region once', async () => {
      getWatchProvidersMock.mockResolvedValue([NETFLIX, DISNEY]);
      const service = createService(UID);
      await service.setRegion('NL'); // sets region signal

      await service.loadProviderCatalog();
      await service.loadProviderCatalog(); // same region → no-op

      expect(getWatchProvidersMock).toHaveBeenCalledTimes(1);
      expect(getWatchProvidersMock).toHaveBeenCalledWith('NL');
      expect(service.providerCatalog()).toEqual([NETFLIX, DISNEY]);
      expect(service.catalogLoading()).toBe(false);
    });

    it('loadProviderCatalog no-ops when no region resolved yet', async () => {
      const service = createService(UID);
      await service.loadProviderCatalog();
      expect(getWatchProvidersMock).not.toHaveBeenCalled();
    });
  });

  // --- Region-change prune coupling (Risks) ----------------------------------
  describe('setRegion prune coupling (step 1 ↔ step 2)', () => {
    it('changing region drops selected ids absent from the new catalog and persists the pruned array', async () => {
      const service = createService(UID);

      await service.setRegion('NL'); // create
      await service.toggleProvider(8); // Netflix
      await service.toggleProvider(337); // Disney
      await service.toggleProvider(1899); // Max
      expect(service.myProviderIds()).toEqual([8, 337, 1899]);

      setDocMock.mockClear();
      updateDocMock.mockClear();

      // New region (DE) catalog carries Netflix (8) + Max (1899); Disney (337)
      // is dropped.
      getWatchProvidersMock.mockResolvedValue([NETFLIX, MAX]);

      await service.setRegion('DE');

      // Two writes: the region scalar, then the pruned array.
      expect(updateDocMock).toHaveBeenCalledTimes(2);
      expect(updateDocMock.mock.calls[0][1]).toEqual({ region: 'DE' });
      expect(updateDocMock.mock.calls[1][1]).toEqual({
        myProviderIds: [8, 1899],
      });
      expect(service.myProviderIds()).toEqual([8, 1899]);
      for (const [ref] of updateDocMock.mock.calls) {
        expect(ref).toEqual({ path: USER_DOC });
      }
    });

    it('SKIPS the prune (preserves the list) when the new catalog fails to load', async () => {
      const service = createService(UID);

      await service.setRegion('NL'); // create
      await service.toggleProvider(8);
      await service.toggleProvider(337);
      await service.toggleProvider(1899);

      updateDocMock.mockClear();

      // Catalog load fails → the prune must be skipped, the list preserved.
      getWatchProvidersMock.mockRejectedValue(new Error('offline'));

      await service.setRegion('DE');

      // Only the region write fired; the selection is untouched.
      expect(updateDocMock).toHaveBeenCalledTimes(1);
      expect(updateDocMock.mock.calls[0][1]).toEqual({ region: 'DE' });
      expect(service.myProviderIds()).toEqual([8, 337, 1899]);
    });
  });

  // --- Step 3: notifications -------------------------------------------------
  describe('notifications (step 3)', () => {
    it('notificationsEnabled reads true iff all three per-type prefs are true', async () => {
      const service = createService(UID);
      // Default create sets all three true.
      await service.setRegion('NL');
      expect(service.notificationsEnabled()).toBe(true);

      await service.setNotificationsEnabled(false);
      expect(service.notificationsEnabled()).toBe(false);

      await service.setNotificationsEnabled(true);
      expect(service.notificationsEnabled()).toBe(true);
    });

    it('setNotificationsEnabled(false) sets all three false while preserving deliveryHour', async () => {
      const service = createService(UID);
      await service.setRegion('NL');
      await service.setDeliveryHour(9); // set a quiet hour first
      updateDocMock.mockClear();

      await service.setNotificationsEnabled(false);

      expect(updateDocMock).toHaveBeenCalledTimes(1);
      const [ref, payload] = updateDocMock.mock.calls[0];
      expect(ref).toEqual({ path: USER_DOC });
      expect(payload).toEqual({
        notificationPrefs: {
          episodeAired: false,
          movieAvailable: false,
          cameToPlatform: false,
          deliveryHour: 9,
        },
      });
      expect(service.deliveryHour()).toBe(9);
      expect(service.notificationsEnabled()).toBe(false);
    });

    it('setDeliveryHour(9) preserves the three booleans and sets the hour', async () => {
      const service = createService(UID);
      await service.setRegion('NL'); // defaults all true
      updateDocMock.mockClear();

      await service.setDeliveryHour(9);

      expect(updateDocMock).toHaveBeenCalledTimes(1);
      expect(updateDocMock.mock.calls[0][1]).toEqual({
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
          deliveryHour: 9,
        },
      });
      expect(service.deliveryHour()).toBe(9);
      expect(service.notificationsEnabled()).toBe(true);
    });

    it('exposes deliveryHours 0..23', () => {
      const service = createService(UID);
      expect(service.deliveryHours).toHaveLength(24);
      expect(service.deliveryHours[0]).toBe(0);
      expect(service.deliveryHours[23]).toBe(23);
    });
  });

  // --- Step 5: complete() (spec-0022 parity) ---------------------------------
  describe('complete (step 5)', () => {
    it('web (non-native) skips push flow but still sets the completion flag', async () => {
      isNativePlatformMock.mockReturnValue(false);
      const service = createService(UID);

      await service.complete();

      expect(requestPermissionsMock).not.toHaveBeenCalled();
      expect(registerMock).not.toHaveBeenCalled();
      expect(updateDocMock).not.toHaveBeenCalled();
      expect(preferencesSetMock).toHaveBeenCalledWith({
        key: ONBOARDING_DONE_KEY,
        value: 'true',
      });
    });

    it('native + granted arrayUnions one token, then sets the flag LAST', async () => {
      isNativePlatformMock.mockReturnValue(true);
      requestPermissionsMock.mockResolvedValue({ receive: 'granted' });
      const service = createService(UID);

      await service.complete();

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
      expect(payload).toEqual({ fcmTokens: { __arrayUnion: unioned } });

      // The completion flag is the LAST write of the whole wizard.
      expect(preferencesSetMock).toHaveBeenCalledWith({
        key: ONBOARDING_DONE_KEY,
        value: 'true',
      });
      expect(preferencesSetMock.mock.invocationCallOrder[0]).toBeGreaterThan(
        updateDocMock.mock.invocationCallOrder[0],
      );
    });

    it('native + denied proceeds silently and still sets the flag', async () => {
      isNativePlatformMock.mockReturnValue(true);
      requestPermissionsMock.mockResolvedValue({ receive: 'denied' });
      const service = createService(UID);

      await expect(service.complete()).resolves.toBeUndefined();

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

      await expect(service.complete()).resolves.toBeUndefined();

      expect(updateDocMock).not.toHaveBeenCalled();
      expect(preferencesSetMock).toHaveBeenCalledWith({
        key: ONBOARDING_DONE_KEY,
        value: 'true',
      });
    });
  });

  // --- Null-uid guard --------------------------------------------------------
  describe('null-uid guard', () => {
    it('no Firestore/callable access fires on any step when AUTH_UID() is null', async () => {
      const service = createService(null);

      await service.setRegion('DE');
      await service.toggleProvider(8);
      await service.loadProviderCatalog();
      await service.setNotificationsEnabled(false);
      await service.setDeliveryHour(9);
      await service.complete();

      expect(setDocMock).not.toHaveBeenCalled();
      expect(updateDocMock).not.toHaveBeenCalled();
      expect(getDocMock).not.toHaveBeenCalled();
      expect(getWatchProvidersMock).not.toHaveBeenCalled();
      // Even without a uid the user must be able to proceed — flag always set.
      expect(preferencesSetMock).toHaveBeenCalledWith({
        key: ONBOARDING_DONE_KEY,
        value: 'true',
      });
    });
  });

  // --- Guardrail: no write outside users/{uid} -------------------------------
  it('every Firestore write across the whole wizard targets users/{uid}', async () => {
    isNativePlatformMock.mockReturnValue(true);
    requestPermissionsMock.mockResolvedValue({ receive: 'granted' });
    getWatchProvidersMock.mockResolvedValue([NETFLIX, MAX]);
    const service = createService(UID);

    await service.setRegion('NL'); // create
    await service.toggleProvider(8);
    await service.toggleProvider(337);
    await service.setNotificationsEnabled(false);
    await service.setDeliveryHour(9);
    await service.setRegion('DE'); // update + prune (337 dropped)
    await service.complete();

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
