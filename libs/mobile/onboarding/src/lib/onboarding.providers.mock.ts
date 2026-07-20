import { Injectable, computed, signal } from '@angular/core';
import {
  REGIONS,
  type CatalogProvider,
  type PlexServer,
  type Region,
  type User,
} from '@vultus/shared/domain';
import { OnboardingPlexLinkService } from './onboarding-plex-link.service';
import { OnboardingService } from './onboarding.service';

/**
 * Mock onboarding providers for the `mock` build profile (spec 0018 / 0078).
 *
 * Build-time file replacement swaps `onboarding.providers.ts` for this file so
 * ALL FIVE wizard steps render and navigate with NO Firebase, NO native plugins
 * and NO live callables under `--configuration=mock`. Neither mock class extends
 * the real service (those inject `Firestore` / `AUTH_UID` /
 * `GET_WATCH_PROVIDERS` / `PLEX_CLIENT`); each structurally mirrors only the
 * public surface the wizard page consumes:
 *
 * - `MockOnboardingServiceImpl` → `OnboardingService`: step state
 *   (`currentStep`/`next`/`back`), region (`regions`/`region`/`setRegion`),
 *   providers (`providerCatalog`/`myProviderIds`/`catalogLoading`/
 *   `loadProviderCatalog`/`toggleProvider`), notifications
 *   (`notificationsEnabled`/`deliveryHour`/`deliveryHours`/
 *   `setNotificationsEnabled`/`setDeliveryHour`) and `complete()`.
 * - `MockOnboardingPlexLinkServiceImpl` → `OnboardingPlexLinkService`: the
 *   four-stage PIN machine surface (`stage`/`errorReason`/`code`/`server`/
 *   `expiresInSeconds`/`countdown` + `requestCode`/`regenerateCode`/`cancel`),
 *   provided PAGE-SCOPED here to shadow the `providedIn:'root'` real service.
 *
 * The catalog is seeded (Netflix selected + several unselected) so step 2 shows
 * both chip states; `requestCode` walks code → connected so step 4's code and
 * connected stages are eyeball-able, and "Skip for now"/`cancel` returns to
 * idle. Flip `SEED_ERROR` to eyeball the error stages.
 */
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

function defaultPrefs(): User['notificationPrefs'] {
  return {
    episodeAired: true,
    movieAvailable: true,
    cameToPlatform: true,
    deliveryHour: null,
  };
}

@Injectable()
class MockOnboardingServiceImpl {
  readonly regions: readonly Region[] = REGIONS;
  readonly deliveryHours: readonly number[] = Array.from(
    { length: 24 },
    (_v, i) => i,
  );

  private readonly _currentStep = signal<1 | 2 | 3 | 4 | 5>(1);
  private readonly _region = signal<Region | null>(null);
  private readonly _providerCatalog = signal<CatalogProvider[]>(MOCK_CATALOG);
  private readonly _myProviderIds = signal<number[]>([8]);
  private readonly _catalogLoading = signal<boolean>(false);
  private readonly _prefs = signal<User['notificationPrefs']>(defaultPrefs());

  readonly currentStep = this._currentStep.asReadonly();
  readonly region = this._region.asReadonly();
  readonly providerCatalog = this._providerCatalog.asReadonly();
  readonly myProviderIds = this._myProviderIds.asReadonly();
  readonly catalogLoading = this._catalogLoading.asReadonly();
  readonly notificationsEnabled = computed(() => {
    const p = this._prefs();
    return p.episodeAired && p.movieAvailable && p.cameToPlatform;
  });
  readonly deliveryHour = computed(() => this._prefs().deliveryHour);

  next(): void {
    const step = this._currentStep();
    if (step < 5) {
      this._currentStep.set((step + 1) as 1 | 2 | 3 | 4 | 5);
    }
  }

  back(): void {
    const step = this._currentStep();
    if (step > 1) {
      this._currentStep.set((step - 1) as 1 | 2 | 3 | 4 | 5);
    }
  }

  setRegion(region: Region): Promise<void> {
    this._region.set(region);
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

  setNotificationsEnabled(enabled: boolean): Promise<void> {
    this._prefs.set({
      episodeAired: enabled,
      movieAvailable: enabled,
      cameToPlatform: enabled,
      deliveryHour: this._prefs().deliveryHour,
    });
    return Promise.resolve();
  }

  setDeliveryHour(hour: number | null): Promise<void> {
    const current = this._prefs();
    this._prefs.set({ ...current, deliveryHour: hour });
    return Promise.resolve();
  }

  complete(): Promise<void> {
    return Promise.resolve();
  }
}

/** Flip to `true` to eyeball the step-4 error stages in serve-mock. */
const SEED_ERROR = false;

@Injectable()
class MockOnboardingPlexLinkServiceImpl {
  private readonly _stage = signal<
    'idle' | 'code' | 'waiting' | 'connected' | 'error'
  >('idle');
  private readonly _errorReason = signal<
    'expired' | 'no-server' | 'network' | null
  >(null);
  private readonly _code = signal<string | null>(null);
  private readonly _server = signal<PlexServer | null>(null);
  private readonly _expiresInSeconds = signal<number>(0);

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

  requestCode(): Promise<void> {
    if (SEED_ERROR) {
      this._errorReason.set('no-server');
      this._stage.set('error');
      return Promise.resolve();
    }
    this._code.set('H7X2');
    this._expiresInSeconds.set(14 * 60 + 32);
    this._stage.set('code');
    this._stage.set('waiting');
    // Auto-advance to connected so the connected stage is eyeball-able.
    setTimeout(() => {
      this._server.set({
        name: 'Vultus Media Server',
        baseUrl: 'http://192.168.1.20:32400',
        accessToken: 'mock',
      });
      this._expiresInSeconds.set(0);
      this._stage.set('connected');
    }, 1500);
    return Promise.resolve();
  }

  regenerateCode(): Promise<void> {
    return this.requestCode();
  }

  cancel(): void {
    this._stage.set('idle');
    this._errorReason.set(null);
    this._code.set(null);
    this._server.set(null);
    this._expiresInSeconds.set(0);
  }
}

export const ONBOARDING_PROVIDERS = [
  { provide: OnboardingService, useClass: MockOnboardingServiceImpl },
  // Page-scoped mock mirror of the ROOT OnboardingPlexLinkService (spec 0078),
  // so serve-mock renders step 4's stages without Preferences / plex.tv. The
  // REAL onboarding.providers.ts stays clean of the link service (the page
  // injects the shell-provided root singleton there).
  {
    provide: OnboardingPlexLinkService,
    useClass: MockOnboardingPlexLinkServiceImpl,
  },
] as const;
