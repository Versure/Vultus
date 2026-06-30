import { Injectable, signal } from '@angular/core';
import { REGIONS, type Region, type SyncRun } from '@vultus/shared/domain';
import { SettingsService } from './settings.service';
import { SyncStatusService } from './sync-status.service';

/**
 * Mock settings service for the `mock` build profile (spec 0018).
 *
 * Build-time file replacement swaps `settings.providers.ts` for this file so
 * the Settings page renders with seeded data and no Firebase. It does NOT
 * extend `SettingsService` (that injects `Firestore` / `AUTH_UID`); it
 * structurally mirrors the public surface — `regions`, `deliveryHours`,
 * `region`, `notificationsEnabled`, `deliveryHour`, `loaded` signals and
 * `load` / `setRegion` / `setNotificationsEnabled` / `setDeliveryHour` — with
 * `loaded` pre-resolved (no spinner) and sensible defaults for visual testing.
 */
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

  readonly region = this._region.asReadonly();
  readonly notificationsEnabled = this._notificationsEnabled.asReadonly();
  readonly deliveryHour = this._deliveryHour.asReadonly();
  readonly loaded = this._loaded.asReadonly();

  load(): Promise<void> {
    return Promise.resolve();
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
