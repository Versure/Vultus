import { Injectable, signal } from '@angular/core';
import { REGIONS, type Region } from '@vultus/shared/domain';
import { SettingsService } from './settings.service';

/**
 * Mock settings service for the `mock` build profile (spec 0018).
 *
 * Build-time file replacement swaps `settings.providers.ts` for this file so
 * the Settings page renders with seeded data and no Firebase. It does NOT
 * extend `SettingsService` (that injects `Firestore` / `AUTH_UID`); it
 * structurally mirrors the public surface — `regions`, `region`,
 * `notificationsEnabled`, `loaded` signals and `load` / `setRegion` /
 * `setNotificationsEnabled` — with `loaded` pre-resolved (no spinner) and
 * sensible defaults for visual testing.
 */
@Injectable()
class MockSettingsServiceImpl {
  readonly regions: readonly Region[] = REGIONS;

  private readonly _region = signal<Region | null>('NL');
  private readonly _notificationsEnabled = signal<boolean>(true);
  private readonly _loaded = signal<boolean>(true);

  readonly region = this._region.asReadonly();
  readonly notificationsEnabled = this._notificationsEnabled.asReadonly();
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
}

export const SETTINGS_PROVIDERS = [
  { provide: SettingsService, useClass: MockSettingsServiceImpl },
] as const;
