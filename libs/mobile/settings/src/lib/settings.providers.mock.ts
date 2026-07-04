import { Injectable, computed, signal } from '@angular/core';
import {
  REGIONS,
  type CatalogProvider,
  type PlexServer,
  type Region,
  type SyncRun,
} from '@vultus/shared/domain';
import { PlexLinkService } from './plex-link.service';
import { PlexSyncService, type PlexSyncSummary } from './plex-sync.service';
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
 *   `loadFailed`, the "My Providers" (spec 0060) signals `providerCatalog`,
 *   `myProviderIds`, `catalogLoading`, `lastPrunedCount`, and the Plex
 *   (spec 0061) signal `hasPlex`;
 * - methods `load`, `setRegion`, `setNotificationsEnabled`, `setDeliveryHour`,
 *   `retryLoad`, the "My Providers" methods `loadProviderCatalog`,
 *   `toggleProvider`, and the Plex method `toggleHasPlex`.
 *
 * `loaded` is pre-resolved (no spinner). The provider catalog is seeded with a
 * plausible set (Netflix, Disney Plus, Max, Prime Video) and `myProviderIds`
 * with a selected/unselected mix (`[8]` = Netflix) so `mobile:serve-mock`
 * renders both selected and unselected chips. `hasPlex` is seeded `true` so the
 * Plex chip renders selected. `loadProviderCatalog` / `toggleProvider` /
 * `toggleHasPlex` mutate the in-memory signals (no callable).
 *
 * Plex (spec 0073): this file ALSO provides page-scoped mock mirrors of the
 * ROOT `PlexLinkService` / `PlexSyncService` (seeded CONNECTED — server name +
 * recent `lastSyncAt`) so `mobile:serve-mock` renders the Settings Plex card's
 * connected block and the Connect page stages without Preferences / plex.tv.
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
  // Plex (spec 0061) seeded selected so `mobile:serve-mock` shows the Plex chip
  // in its selected state.
  private readonly _hasPlex = signal<boolean>(true);

  readonly region = this._region.asReadonly();
  readonly notificationsEnabled = this._notificationsEnabled.asReadonly();
  readonly deliveryHour = this._deliveryHour.asReadonly();
  readonly loaded = this._loaded.asReadonly();
  readonly loadFailed = this._loadFailed.asReadonly();
  readonly providerCatalog = this._providerCatalog.asReadonly();
  readonly myProviderIds = this._myProviderIds.asReadonly();
  readonly catalogLoading = this._catalogLoading.asReadonly();
  readonly lastPrunedCount = this._lastPrunedCount.asReadonly();
  readonly hasPlex = this._hasPlex.asReadonly();

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

  toggleHasPlex(): Promise<void> {
    this._hasPlex.set(!this._hasPlex());
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

/**
 * Mock `PlexLinkService` for the `mock` build profile (spec 0073).
 *
 * Structurally mirrors `PlexLinkService`'s public signal/method surface with NO
 * Preferences / Firebase / plex.tv. Seeded **connected** (a server name + a
 * recent `lastSyncAt`) so `mobile:serve-mock` renders the Settings Plex card's
 * CONNECTED block. `requestCode` walks the connect-page stage machine
 * deterministically (code → connected on the next macrotask) so the connect page
 * is eyeball-able too. `unlink()` flips back to disconnected.
 */
@Injectable()
class MockPlexLinkServiceImpl {
  private readonly _stage = signal<
    'idle' | 'code' | 'waiting' | 'connected' | 'error'
  >('idle');
  private readonly _errorReason = signal<
    'expired' | 'no-server' | 'network' | null
  >(null);
  private readonly _code = signal<string | null>(null);
  private readonly _server = signal<PlexServer | null>(null);
  private readonly _expiresInSeconds = signal<number>(0);
  private readonly _linked = signal<boolean>(true);
  private readonly _serverName = signal<string | null>('Vultus Media Server');
  private readonly _lastSyncAt = signal<string | null>(
    new Date(Date.now() - 12 * 60 * 1000).toISOString(),
  );

  readonly stage = this._stage.asReadonly();
  readonly errorReason = this._errorReason.asReadonly();
  readonly code = this._code.asReadonly();
  readonly server = this._server.asReadonly();
  readonly expiresInSeconds = this._expiresInSeconds.asReadonly();
  readonly countdown = computed(() => {
    const total = this._expiresInSeconds();
    const mm = Math.floor(total / 60);
    const ss = total % 60;
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  });
  readonly linked = this._linked.asReadonly();
  readonly serverName = this._serverName.asReadonly();
  readonly lastSyncAt = this._lastSyncAt.asReadonly();

  isLinked(): Promise<boolean> {
    return Promise.resolve(this._linked());
  }

  loadState(): Promise<void> {
    return Promise.resolve();
  }

  requestCode(): Promise<void> {
    this._code.set('H7X2');
    this._stage.set('code');
    this._expiresInSeconds.set(14 * 60 + 32);
    // Auto-advance to connected so the connected stage is eyeball-able.
    setTimeout(() => {
      this._server.set({
        name: 'Vultus Media Server',
        baseUrl: 'http://192.168.1.20:32400',
        accessToken: 'mock',
      });
      this._stage.set('connected');
    }, 1500);
    return Promise.resolve();
  }

  regenerateCode(): Promise<void> {
    return this.requestCode();
  }

  cancel(): void {
    this._stage.set('idle');
    this._code.set(null);
    this._expiresInSeconds.set(0);
  }

  unlink(): Promise<void> {
    this._linked.set(false);
    this._serverName.set(null);
    this._lastSyncAt.set(null);
    this._stage.set('idle');
    return Promise.resolve();
  }
}

/**
 * Mock `PlexSyncService` mirror (spec 0073) — no Firebase / plex.tv. `sync()`
 * flips `running` briefly then resolves an empty summary so `mobile:serve-mock`
 * can exercise the "Sync now" spinner/disabled state.
 */
@Injectable()
class MockPlexSyncServiceImpl {
  private readonly _running = signal<boolean>(false);
  readonly running = this._running.asReadonly();

  async sync(): Promise<PlexSyncSummary> {
    this._running.set(true);
    await new Promise((resolve) => setTimeout(resolve, 800));
    this._running.set(false);
    return { added: 0, updated: 0, skipped: 0 };
  }
}

export const SETTINGS_PROVIDERS = [
  { provide: SettingsService, useClass: MockSettingsServiceImpl },
  { provide: SyncStatusService, useClass: MockSyncStatusServiceImpl },
  // Page-scoped mock mirrors of the ROOT Plex services (spec 0073), so
  // serve-mock renders the connected card without Preferences / plex.tv. The
  // REAL settings.providers.ts stays clean of Plex services (the page injects
  // the shell-provided root singletons there).
  { provide: PlexLinkService, useClass: MockPlexLinkServiceImpl },
  { provide: PlexSyncService, useClass: MockPlexSyncServiceImpl },
] as const;
