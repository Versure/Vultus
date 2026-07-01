import { Injectable, signal } from '@angular/core';
import {
  REGIONS,
  type CatalogProvider,
  type Region,
  type SyncRun,
} from '@vultus/shared/domain';
import { SettingsService } from './settings.service';
import { SyncStatusService } from './sync-status.service';

/**
 * Mock settings service for the `mock` build profile (spec 0018).
 *
 * Build-time file replacement swaps `settings.providers.ts` for this file so
 * the Settings page renders with seeded data and no Firebase. It does NOT
 * extend `SettingsService` (that injects `Firestore` / `AUTH_UID` /
 * `GET_WATCH_PROVIDERS`); it structurally mirrors the public surface:
 * - option lists `regions`, `deliveryHours`;
 * - signals `region`, `notificationsEnabled`, `deliveryHour`, `loaded`,
 *   `loadFailed`, and the "My Providers" (spec 0060) signals `providerCatalog`,
 *   `myProviderIds`, `catalogLoading`, `lastPrunedCount`;
 * - methods `load`, `setRegion`, `setNotificationsEnabled`, `setDeliveryHour`,
 *   `retryLoad`, and the "My Providers" methods `loadProviderCatalog`,
 *   `toggleProvider`.
 *
 * `loaded` is pre-resolved (no spinner). The provider catalog is seeded with a
 * plausible set (Netflix, Disney Plus, Max, Prime Video) and `myProviderIds`
 * with a selected/unselected mix (`[8]` = Netflix) so `mobile:serve-mock`
 * renders both selected and unselected chips. `loadProviderCatalog` /
 * `toggleProvider` mutate the in-memory signals (no callable).
 */
// Seeded provider catalog (TMDB provider ids + real logo paths) so the mock
// renders logos + a selected/unselected mix.
const MOCK_CATALOG: CatalogProvider[] = [
  {
    providerId: 8,
    name: 'Netflix',
    logoPath: '/pbpMk2JmcoNnQwx5JGpXngfoWtp.jpg',
  },
  {
    providerId: 337,
    name: 'Disney Plus',
    logoPath: '/97yvRBw1GzX7fXprcF80er19ot.jpg',
  },
  {
    providerId: 1899,
    name: 'Max',
    logoPath: '/6Q3ZYUNA9Hsgj6iWnVsw2gR5V6z.jpg',
  },
  {
    providerId: 119,
    name: 'Amazon Prime Video',
    logoPath: '/pvske1MyAoymrs5bguRfVqYiM9a.jpg',
  },
];

@Injectable()
class MockSettingsServiceImpl {
  readonly regions: readonly Region[] = REGIONS;
  readonly deliveryHours: readonly number[] = Array.from(
    { length: 24 },
    (_v, i) => i,
  );

  private readonly _region = signal<Region | null>('NL');
  private readonly _notificationsEnabled = signal<boolean>(true);
  // Seeded to "Any time" (null) so `mobile:serve-mock` renders the default.
  private readonly _deliveryHour = signal<number | null>(null);
  private readonly _loaded = signal<boolean>(true);
  private readonly _loadFailed = signal<boolean>(false);

  // "My Providers" (spec 0060) seeded state: full catalog loaded, Netflix (8)
  // selected so a selected + several unselected chips render.
  private readonly _providerCatalog = signal<CatalogProvider[]>(MOCK_CATALOG);
  private readonly _myProviderIds = signal<number[]>([8]);
  private readonly _catalogLoading = signal<boolean>(false);
  private readonly _lastPrunedCount = signal<number>(0);

  readonly region = this._region.asReadonly();
  readonly notificationsEnabled = this._notificationsEnabled.asReadonly();
  readonly deliveryHour = this._deliveryHour.asReadonly();
  readonly loaded = this._loaded.asReadonly();
  readonly loadFailed = this._loadFailed.asReadonly();
  readonly providerCatalog = this._providerCatalog.asReadonly();
  readonly myProviderIds = this._myProviderIds.asReadonly();
  readonly catalogLoading = this._catalogLoading.asReadonly();
  readonly lastPrunedCount = this._lastPrunedCount.asReadonly();

  load(): Promise<void> {
    return Promise.resolve();
  }

  retryLoad(): void {
    this._loadFailed.set(false);
  }

  setRegion(region: Region): Promise<void> {
    this._region.set(region);
    return Promise.resolve();
  }

  setNotificationsEnabled(enabled: boolean): Promise<void> {
    this._notificationsEnabled.set(enabled);
    return Promise.resolve();
  }

  setDeliveryHour(hour: number | null): Promise<void> {
    this._deliveryHour.set(hour);
    return Promise.resolve();
  }

  loadProviderCatalog(): Promise<void> {
    // Catalog is pre-seeded; nothing to fetch in mock mode.
    return Promise.resolve();
  }

  toggleProvider(providerId: number): Promise<void> {
    const current = this._myProviderIds();
    this._myProviderIds.set(
      current.includes(providerId)
        ? current.filter((id) => id !== providerId)
        : [...current, providerId],
    );
    return Promise.resolve();
  }
}

/**
 * Mock sync-status service for the `mock` build profile (spec 0049).
 *
 * Structurally mirrors `SyncStatusService`'s public surface (`lastRun`,
 * `loaded`, `loadFailed` signals + `load()`) with NO Firebase. Seeded with a
 * plausible recent SUCCESS run (~2h ago, 12 gathered / 3 updated, no errors) so
 * `mobile:serve-mock` renders the success state. Flip `SEEDED_RUN` to `null` to
 * eyeball never-synced, or bump `errorCount` to eyeball the with-errors chip.
 */
const SEEDED_RUN: SyncRun | null = {
  runId: 'mock-run-1',
  kind: 'cron',
  userId: null,
  startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  completedAt: new Date(Date.now() - 2 * 60 * 60 * 1000 + 45_000).toISOString(),
  durationMs: 45_000,
  titlesGathered: 12,
  titlesUpdated: 3,
  errorCount: 0,
  errors: [],
};

@Injectable()
class MockSyncStatusServiceImpl {
  private readonly _lastRun = signal<SyncRun | null>(SEEDED_RUN);
  private readonly _loaded = signal<boolean>(true);
  private readonly _loadFailed = signal<boolean>(false);

  readonly lastRun = this._lastRun.asReadonly();
  readonly loaded = this._loaded.asReadonly();
  readonly loadFailed = this._loadFailed.asReadonly();

  load(): Promise<void> {
    return Promise.resolve();
  }
}

export const SETTINGS_PROVIDERS = [
  { provide: SettingsService, useClass: MockSettingsServiceImpl },
  { provide: SyncStatusService, useClass: MockSyncStatusServiceImpl },
] as const;
