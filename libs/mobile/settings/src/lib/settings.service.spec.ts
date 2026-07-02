import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Firestore } from '@angular/fire/firestore';
import { AUTH_UID, GET_WATCH_PROVIDERS } from '@vultus/shared/domain/tokens';
import type { CatalogProvider, Region } from '@vultus/shared/domain';
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
    deliveryHour?: number | null;
  };
  myProviderIds?: number[];
  hasPlex?: boolean;
}): SnapLike {
  return {
    exists: () => true,
    data: () => ({
      ...data,
      notificationPrefs: {
        deliveryHour: null,
        ...data.notificationPrefs,
      },
      fcmTokens: [],
      // Omitting `myProviderIds` simulates a legacy (pre-0060) doc; when
      // present it round-trips via the converter's `?? []` coalesce.
      ...(data.myProviderIds !== undefined
        ? { myProviderIds: data.myProviderIds }
        : {}),
      // Omitting `hasPlex` simulates a legacy (pre-0061) doc; when present it
      // round-trips via the converter's `?? false` coalesce.
      ...(data.hasPlex !== undefined ? { hasPlex: data.hasPlex } : {}),
    }),
  };
}

const missingDoc: SnapLike = { exists: () => false, data: () => undefined };

// A stub catalog thunk the tests can drive per-case. Reset in `beforeEach`.
let getWatchProvidersMock: ReturnType<
  typeof vi.fn<(region: Region) => Promise<CatalogProvider[]>>
>;

function createService(uid: string | null): SettingsService {
  return createServiceWithUidSignal(uid).service;
}

/**
 * Variant that also returns the writable `AUTH_UID` signal so a test can
 * `.set(...)` it to simulate anonymous auth resolving AFTER the page mounted
 * (the spec 0032 load race). The service is constructed inside the TestBed
 * injection context, so its constructor `effect()` is wired but only fires when
 * effects are flushed via `TestBed.tick()`.
 */
function createServiceWithUidSignal(uid: string | null): {
  service: SettingsService;
  uidSignal: WritableSignal<string | null>;
} {
  const uidSignal = signal<string | null>(uid);
  TestBed.configureTestingModule({
    providers: [
      SettingsService,
      { provide: Firestore, useValue: {} },
      { provide: AUTH_UID, useValue: uidSignal },
      { provide: GET_WATCH_PROVIDERS, useValue: getWatchProvidersMock },
    ],
  });
  return { service: TestBed.inject(SettingsService), uidSignal };
}

/** Flush Angular effects, then drain the async `load()` microtasks. */
async function flushEffectsAndMicrotasks(): Promise<void> {
  TestBed.tick();
  await Promise.resolve();
  await Promise.resolve();
}

describe('SettingsService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    docMock.mockClear();
    getDocMock.mockReset();
    setDocMock.mockReset();
    updateDocMock.mockReset();
    // Default: the catalog thunk resolves to an empty catalog. Individual
    // tests override with `.mockResolvedValueOnce` / `.mockRejectedValueOnce`.
    getWatchProvidersMock = vi.fn(() => Promise.resolve<CatalogProvider[]>([]));
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
        deliveryHour: null,
      },
      fcmTokens: [],
      myProviderIds: [],
      hasPlex: false,
    });
    expect(service.region()).toBe('NL');
    expect(service.notificationsEnabled()).toBe(true);
    expect(service.deliveryHour()).toBe(null);
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
        deliveryHour: null,
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
        deliveryHour: null,
      },
    });
    expect(Object.keys(payload as object)).not.toContain('fcmTokens');
    expect(service.notificationsEnabled()).toBe(true);
  });

  it('setNotificationsEnabled preserves the current deliveryHour (spec 0051)', async () => {
    // Load an existing doc carrying a delivery hour, then toggle notifications.
    getDocMock.mockResolvedValue(
      existingDoc({
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
          deliveryHour: 14,
        },
      }),
    );
    const service = createService(UID);
    await service.load();
    expect(service.deliveryHour()).toBe(14);

    await service.setNotificationsEnabled(false);

    const [, payload] = updateDocMock.mock.calls[0];
    expect(payload).toEqual({
      notificationPrefs: {
        episodeAired: false,
        movieAvailable: false,
        cameToPlatform: false,
        deliveryHour: 14,
      },
    });
    // The delivery hour signal is untouched by the notifications toggle.
    expect(service.deliveryHour()).toBe(14);
  });

  it('setDeliveryHour writes the whole prefs, preserving the three booleans', async () => {
    // Load a doc whose booleans are NOT all-true so we can prove they survive.
    getDocMock.mockResolvedValue(
      existingDoc({
        region: 'NL',
        notificationPrefs: {
          episodeAired: false,
          movieAvailable: true,
          cameToPlatform: false,
          deliveryHour: null,
        },
      }),
    );
    const service = createService(UID);
    await service.load();

    await service.setDeliveryHour(8);

    expect(updateDocMock).toHaveBeenCalledTimes(1);
    const [ref, payload] = updateDocMock.mock.calls[0];
    expect(ref).toEqual({ path: USER_DOC });
    expect(payload).toEqual({
      notificationPrefs: {
        episodeAired: false,
        movieAvailable: true,
        cameToPlatform: false,
        deliveryHour: 8,
      },
    });
    expect(Object.keys(payload as object)).not.toContain('fcmTokens');
    expect(service.deliveryHour()).toBe(8);
  });

  it('setDeliveryHour(null) clears the delivery hour to "Any time"', async () => {
    getDocMock.mockResolvedValue(
      existingDoc({
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
          deliveryHour: 9,
        },
      }),
    );
    const service = createService(UID);
    await service.load();

    await service.setDeliveryHour(null);

    const [, payload] = updateDocMock.mock.calls[0];
    expect(payload).toEqual({
      notificationPrefs: {
        episodeAired: true,
        movieAvailable: true,
        cameToPlatform: true,
        deliveryHour: null,
      },
    });
    expect(service.deliveryHour()).toBe(null);
  });

  it('load() reads deliveryHour into the signal from the user doc', async () => {
    getDocMock.mockResolvedValue(
      existingDoc({
        region: 'DE',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
          deliveryHour: 21,
        },
      }),
    );
    const service = createService(UID);

    await service.load();

    expect(service.deliveryHour()).toBe(21);
  });

  it('deliveryHours exposes the 24 UTC hours 0..23', () => {
    const service = createService(UID);
    expect(service.deliveryHours.length).toBe(24);
    expect(service.deliveryHours[0]).toBe(0);
    expect(service.deliveryHours[23]).toBe(23);
  });

  it('null-uid guard: no Firestore access on load/setRegion/setNotificationsEnabled/setDeliveryHour', async () => {
    const service = createService(null);

    await service.load();
    await service.setRegion('DE');
    await service.setNotificationsEnabled(false);
    await service.setDeliveryHour(8);

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

  it('reactive load: uid null→non-null transition auto-loads (spec 0032 regression)', async () => {
    getDocMock.mockResolvedValue(missingDoc);
    const { service, uidSignal } = createServiceWithUidSignal(null);

    // Mimic ngOnInit's one-shot load() while uid is still null: silent no-op.
    await service.load();
    expect(getDocMock).not.toHaveBeenCalled();
    expect(service.loaded()).toBe(false);
    expect(service.loadFailed()).toBe(false);

    // Anonymous auth resolves AFTER mount → the effect must drive load().
    uidSignal.set(UID);
    await flushEffectsAndMicrotasks();

    expect(getDocMock).toHaveBeenCalledTimes(1);
    expect(service.loaded()).toBe(true);
  });

  it('reactive load: no double-load when uid present at init', async () => {
    getDocMock.mockResolvedValue(missingDoc);
    const service = createService(UID);

    // Fast path: ngOnInit-equivalent load() reads/creates the doc once.
    await service.load();
    expect(service.loaded()).toBe(true);
    expect(getDocMock).toHaveBeenCalledTimes(1);

    // Flushing the effect must NOT trigger a second read (the !_loaded guard).
    await flushEffectsAndMicrotasks();
    expect(getDocMock).toHaveBeenCalledTimes(1);
  });

  // ── My Providers (spec 0060) ─────────────────────────────────────────────

  const NETFLIX: CatalogProvider = {
    providerId: 8,
    name: 'Netflix',
    logoPath: '/n.jpg',
  };
  const DISNEY: CatalogProvider = {
    providerId: 337,
    name: 'Disney Plus',
    logoPath: '/d.jpg',
  };
  const MAX: CatalogProvider = {
    providerId: 1899,
    name: 'Max',
    logoPath: null,
  };

  it('load() reads myProviderIds into the signal', async () => {
    getDocMock.mockResolvedValue(
      existingDoc({
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
        },
        myProviderIds: [8, 337],
      }),
    );
    const service = createService(UID);

    await service.load();

    expect(service.myProviderIds()).toEqual([8, 337]);
  });

  it('load() defaults myProviderIds to [] for a legacy doc missing the field', async () => {
    getDocMock.mockResolvedValue(
      existingDoc({
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
        },
        // no myProviderIds → converter coalesces to []
      }),
    );
    const service = createService(UID);

    await service.load();

    expect(service.myProviderIds()).toEqual([]);
  });

  it('eager-create writes myProviderIds: [] in the default User literal', async () => {
    getDocMock.mockResolvedValue(missingDoc);
    const service = createService(UID);

    await service.load();

    const [, payload] = setDocMock.mock.calls[0];
    expect((payload as { myProviderIds: number[] }).myProviderIds).toEqual([]);
    expect(service.myProviderIds()).toEqual([]);
  });

  // ── Plex — hasPlex (spec 0061) ───────────────────────────────────────────

  it('load() reads hasPlex: true into the signal', async () => {
    getDocMock.mockResolvedValue(
      existingDoc({
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
        },
        hasPlex: true,
      }),
    );
    const service = createService(UID);

    await service.load();

    expect(service.hasPlex()).toBe(true);
  });

  it('load() defaults hasPlex to false for a legacy doc missing the field', async () => {
    getDocMock.mockResolvedValue(
      existingDoc({
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
        },
        // no hasPlex → converter coalesces to false
      }),
    );
    const service = createService(UID);

    await service.load();

    expect(service.hasPlex()).toBe(false);
  });

  it('eager-create writes hasPlex: false in the default User literal', async () => {
    getDocMock.mockResolvedValue(missingDoc);
    const service = createService(UID);

    await service.load();

    const [, payload] = setDocMock.mock.calls[0];
    expect((payload as { hasPlex: boolean }).hasPlex).toBe(false);
    expect(service.hasPlex()).toBe(false);
  });

  it('toggleHasPlex flips false→true and persists { hasPlex: true } to users/{uid}', async () => {
    getDocMock.mockResolvedValue(
      existingDoc({
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
        },
        hasPlex: false,
      }),
    );
    const service = createService(UID);
    await service.load();
    expect(service.hasPlex()).toBe(false);

    await service.toggleHasPlex();

    expect(updateDocMock).toHaveBeenCalledTimes(1);
    const [ref, payload] = updateDocMock.mock.calls[0];
    expect(ref).toEqual({ path: USER_DOC });
    expect(payload).toEqual({ hasPlex: true });
    expect(service.hasPlex()).toBe(true);
  });

  it('toggleHasPlex flips true→false and persists { hasPlex: false }', async () => {
    getDocMock.mockResolvedValue(
      existingDoc({
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
        },
        hasPlex: true,
      }),
    );
    const service = createService(UID);
    await service.load();
    expect(service.hasPlex()).toBe(true);

    await service.toggleHasPlex();

    const [, payload] = updateDocMock.mock.calls[0];
    expect(payload).toEqual({ hasPlex: false });
    expect(service.hasPlex()).toBe(false);
  });

  it('toggleHasPlex never touches myProviderIds (separate scalar write)', async () => {
    getDocMock.mockResolvedValue(
      existingDoc({
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
        },
        myProviderIds: [8, 337],
        hasPlex: false,
      }),
    );
    const service = createService(UID);
    await service.load();

    await service.toggleHasPlex();

    const [, payload] = updateDocMock.mock.calls[0];
    expect(Object.keys(payload as object)).not.toContain('myProviderIds');
    // The selection is untouched.
    expect(service.myProviderIds()).toEqual([8, 337]);
  });

  it('toggleHasPlex null-uid guard: no write', async () => {
    const service = createService(null);

    await service.toggleHasPlex();

    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('toggleProvider adds an absent id and persists the whole array', async () => {
    getDocMock.mockResolvedValue(
      existingDoc({
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
        },
        myProviderIds: [8],
      }),
    );
    const service = createService(UID);
    await service.load();

    await service.toggleProvider(337);

    expect(updateDocMock).toHaveBeenCalledTimes(1);
    const [ref, payload] = updateDocMock.mock.calls[0];
    expect(ref).toEqual({ path: USER_DOC });
    expect(payload).toEqual({ myProviderIds: [8, 337] });
    expect(service.myProviderIds()).toEqual([8, 337]);
  });

  it('toggleProvider removes a present id and persists the whole array', async () => {
    getDocMock.mockResolvedValue(
      existingDoc({
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
        },
        myProviderIds: [8, 337],
      }),
    );
    const service = createService(UID);
    await service.load();

    await service.toggleProvider(8);

    const [, payload] = updateDocMock.mock.calls[0];
    expect(payload).toEqual({ myProviderIds: [337] });
    expect(service.myProviderIds()).toEqual([337]);
  });

  it('toggleProvider null-uid guard: no write', async () => {
    const service = createService(null);

    await service.toggleProvider(8);

    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('loadProviderCatalog calls the thunk once per region and populates the signal', async () => {
    getDocMock.mockResolvedValue(
      existingDoc({
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
        },
        myProviderIds: [],
      }),
    );
    getWatchProvidersMock.mockResolvedValue([NETFLIX, DISNEY]);
    const service = createService(UID);
    await service.load();

    await service.loadProviderCatalog();
    // Second call for the SAME region is a no-op (already loaded).
    await service.loadProviderCatalog();

    expect(getWatchProvidersMock).toHaveBeenCalledTimes(1);
    expect(getWatchProvidersMock).toHaveBeenCalledWith('NL');
    expect(service.providerCatalog()).toEqual([NETFLIX, DISNEY]);
    expect(service.catalogLoading()).toBe(false);
  });

  it('loadProviderCatalog no-ops when no region resolved yet', async () => {
    const service = createService(UID); // never loaded → region null

    await service.loadProviderCatalog();

    expect(getWatchProvidersMock).not.toHaveBeenCalled();
  });

  it('setRegion prunes myProviderIds to the new catalog and reports the dropped count', async () => {
    getDocMock.mockResolvedValue(
      existingDoc({
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
        },
        myProviderIds: [8, 337, 1899],
      }),
    );
    const service = createService(UID);
    await service.load();
    updateDocMock.mockClear();

    // New region (DE) catalog only carries Netflix (8) + Max (1899); Disney
    // (337) is dropped.
    getWatchProvidersMock.mockResolvedValue([NETFLIX, MAX]);

    await service.setRegion('DE');

    // Two sequential writes: region, then pruned myProviderIds.
    expect(updateDocMock).toHaveBeenCalledTimes(2);
    expect(updateDocMock.mock.calls[0][1]).toEqual({ region: 'DE' });
    expect(updateDocMock.mock.calls[1][1]).toEqual({
      myProviderIds: [8, 1899],
    });
    expect(service.myProviderIds()).toEqual([8, 1899]);
    expect(service.lastPrunedCount()).toBe(1);
  });

  it('setRegion with nothing to prune writes only the region and reports 0 dropped', async () => {
    getDocMock.mockResolvedValue(
      existingDoc({
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
        },
        myProviderIds: [8],
      }),
    );
    const service = createService(UID);
    await service.load();
    updateDocMock.mockClear();

    getWatchProvidersMock.mockResolvedValue([NETFLIX, DISNEY]);

    await service.setRegion('DE');

    // Only the region write; no prune write (nothing dropped).
    expect(updateDocMock).toHaveBeenCalledTimes(1);
    expect(updateDocMock.mock.calls[0][1]).toEqual({ region: 'DE' });
    expect(service.myProviderIds()).toEqual([8]);
    expect(service.lastPrunedCount()).toBe(0);
  });

  it('setRegion skips the prune (preserves data) when the new catalog fails to load', async () => {
    getDocMock.mockResolvedValue(
      existingDoc({
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
        },
        myProviderIds: [8, 337, 1899],
      }),
    );
    const service = createService(UID);
    await service.load();
    updateDocMock.mockClear();

    getWatchProvidersMock.mockRejectedValue(new Error('offline'));

    await service.setRegion('DE');

    // The region write persisted; the prune is SKIPPED (no second write), the
    // provider list is untouched, and nothing is reported dropped.
    expect(updateDocMock).toHaveBeenCalledTimes(1);
    expect(updateDocMock.mock.calls[0][1]).toEqual({ region: 'DE' });
    expect(service.myProviderIds()).toEqual([8, 337, 1899]);
    expect(service.lastPrunedCount()).toBe(0);
    expect(service.region()).toBe('DE');
  });

  it('setRegion null-uid guard: no write and no catalog load', async () => {
    const service = createService(null);

    await service.setRegion('DE');

    expect(updateDocMock).not.toHaveBeenCalled();
    expect(getWatchProvidersMock).not.toHaveBeenCalled();
  });

  it('reactive load: does not auto-load while in a failed state (only retryLoad re-enters)', async () => {
    getDocMock.mockRejectedValue(new Error('offline'));
    const service = createService(UID);

    await service.load();
    expect(service.loadFailed()).toBe(true);
    expect(getDocMock).toHaveBeenCalledTimes(1);

    // Effect must respect the !_loadFailed guard: no auto re-attempt.
    await flushEffectsAndMicrotasks();
    expect(getDocMock).toHaveBeenCalledTimes(1);
    expect(service.loadFailed()).toBe(true);
  });
});
