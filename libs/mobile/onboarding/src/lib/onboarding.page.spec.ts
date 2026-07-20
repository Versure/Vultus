import { signal, type Signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';
import {
  REGIONS,
  regionDisplayName,
  type CatalogProvider,
  type PlexServer,
  type Region,
} from '@vultus/shared/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock BOTH data-access modules so the page test never pulls in the real
// `@angular/fire/firestore` import chain (rxfire ships ESM-in-CJS and breaks the
// jsdom transform). The page imports `./onboarding.service` AND
// `./onboarding-plex-link.service` (the latter is new in spec 0078 and drags in
// the same rxfire chain), so both are replaced with bare classes here; the page
// is tested in isolation against the TestBed-level mock instances below.
vi.mock('./onboarding.service', () => ({
  OnboardingService: class OnboardingService {},
}));
vi.mock('./onboarding-plex-link.service', () => ({
  OnboardingPlexLinkService: class OnboardingPlexLinkService {},
}));

import { OnboardingPage } from './onboarding.page';
import { OnboardingPlexLinkService } from './onboarding-plex-link.service';
import { OnboardingService } from './onboarding.service';

// Slice-local copies of the link-service stage unions (the real module is mocked
// away above; these mirror its exported `PlexLinkStage` / `PlexLinkErrorReason`).
type PlexLinkStage = 'idle' | 'code' | 'waiting' | 'connected' | 'error';
type PlexLinkErrorReason = 'expired' | 'no-server' | 'network';

/**
 * Lightweight mock of `OnboardingService`'s public surface (mirrors the real
 * fields the wizard page reads). `currentStep`/`region`/etc. are REAL Angular
 * signals so `next`/`back` (and direct `.set(...)` from a test) actually move the
 * wizard and the template re-renders; the persist methods are resolved spies.
 */
interface MockOnboardingService {
  regions: readonly Region[];
  deliveryHours: readonly number[];
  currentStep: WritableSignal<1 | 2 | 3 | 4 | 5>;
  region: WritableSignal<Region | null>;
  providerCatalog: WritableSignal<CatalogProvider[]>;
  myProviderIds: WritableSignal<number[]>;
  catalogLoading: WritableSignal<boolean>;
  notificationsEnabled: WritableSignal<boolean>;
  deliveryHour: WritableSignal<number | null>;
  next: ReturnType<typeof vi.fn>;
  back: ReturnType<typeof vi.fn>;
  setRegion: ReturnType<typeof vi.fn>;
  loadProviderCatalog: ReturnType<typeof vi.fn>;
  toggleProvider: ReturnType<typeof vi.fn>;
  setNotificationsEnabled: ReturnType<typeof vi.fn>;
  setDeliveryHour: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
}

/** Lightweight mock of `OnboardingPlexLinkService`'s public surface (step 4). */
interface MockPlexLinkService {
  stage: WritableSignal<PlexLinkStage>;
  errorReason: WritableSignal<PlexLinkErrorReason | null>;
  code: WritableSignal<string | null>;
  server: WritableSignal<PlexServer | null>;
  expiresInSeconds: WritableSignal<number>;
  countdown: Signal<string>;
  requestCode: ReturnType<typeof vi.fn>;
  regenerateCode: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
}

function mockService(): MockOnboardingService {
  const currentStep = signal<1 | 2 | 3 | 4 | 5>(1);
  const region = signal<Region | null>(null);
  return {
    regions: REGIONS,
    deliveryHours: Array.from({ length: 24 }, (_v, i) => i),
    currentStep,
    region,
    providerCatalog: signal<CatalogProvider[]>([]),
    myProviderIds: signal<number[]>([]),
    catalogLoading: signal(false),
    notificationsEnabled: signal(true),
    deliveryHour: signal<number | null>(null),
    next: vi.fn(() => {
      const step = currentStep();
      if (step < 5) {
        currentStep.set((step + 1) as 1 | 2 | 3 | 4 | 5);
      }
    }),
    back: vi.fn(() => {
      const step = currentStep();
      if (step > 1) {
        currentStep.set((step - 1) as 1 | 2 | 3 | 4 | 5);
      }
    }),
    setRegion: vi.fn((r: Region) => {
      region.set(r);
      return Promise.resolve();
    }),
    loadProviderCatalog: vi.fn().mockResolvedValue(undefined),
    toggleProvider: vi.fn().mockResolvedValue(undefined),
    setNotificationsEnabled: vi.fn().mockResolvedValue(undefined),
    setDeliveryHour: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
  };
}

function mockPlexLink(): MockPlexLinkService {
  return {
    stage: signal<PlexLinkStage>('idle'),
    errorReason: signal<PlexLinkErrorReason | null>(null),
    code: signal<string | null>(null),
    server: signal<PlexServer | null>(null),
    expiresInSeconds: signal(0),
    countdown: signal('15:00'),
    requestCode: vi.fn().mockResolvedValue(undefined),
    regenerateCode: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
  };
}

const navigateMock = vi.fn().mockResolvedValue(true);

async function setup() {
  const service = mockService();
  const plexLink = mockPlexLink();
  await TestBed.configureTestingModule({
    imports: [OnboardingPage],
    providers: [
      provideIonicAngular(),
      { provide: OnboardingService, useValue: service },
      { provide: OnboardingPlexLinkService, useValue: plexLink },
      { provide: Router, useValue: { navigate: navigateMock } },
    ],
  })
    // The component declares page-scoped `providers: [...ONBOARDING_PROVIDERS]`
    // for lazy-chunk scoping. Override it so the TestBed-level mocks take effect.
    .overrideComponent(OnboardingPage, { set: { providers: [] } })
    .compileComponents();

  const fixture = TestBed.createComponent(OnboardingPage);
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, service, plexLink, el };
}

/** The step-progress label copy (exact string; edges trimmed only). */
function progressText(el: HTMLElement): string {
  return el.querySelector('.wizard-progress__label')?.textContent?.trim() ?? '';
}

/** The current step's heading copy (exact string; edges trimmed only). */
function titleText(el: HTMLElement): string {
  return el.querySelector('.wizard-title')?.textContent?.trim() ?? '';
}

function click(el: HTMLElement, selector: string): void {
  el.querySelector(selector)?.dispatchEvent(new CustomEvent('click'));
}

/** Step 1's "Continue" is async (awaits `setRegion` then `next()`). */
async function continueFromRegion(
  el: HTMLElement,
  fixture: Awaited<ReturnType<typeof setup>>['fixture'],
): Promise<void> {
  click(el, '.wizard-cta');
  await fixture.whenStable();
  fixture.detectChanges();
  await fixture.whenStable();
}

describe('OnboardingPage (5-step wizard)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    navigateMock.mockClear();
  });

  it('renders step 1 (region) first with the "Step 1 of 5" indicator and no Back', async () => {
    const { el } = await setup();
    expect(progressText(el)).toBe('Step 1 of 5');
    expect(titleText(el)).toBe('Choose your region');
    expect(el.querySelector('ion-select')).toBeTruthy();
    // Step 1 has no "Back" control (Back is steps 2-5 only).
    expect(el.querySelector('.wizard-back')).toBeNull();
  });

  it('advances through steps 2 → 3 → 4 → 5 in order, updating the progress indicator', async () => {
    const { el, fixture } = await setup();
    expect(progressText(el)).toBe('Step 1 of 5');

    // Step 1 → 2 (region "Continue").
    await continueFromRegion(el, fixture);
    expect(progressText(el)).toBe('Step 2 of 5');
    expect(titleText(el)).toBe('Your providers');

    // Step 2 → 3 (providers "Continue").
    click(el, '.wizard-cta');
    fixture.detectChanges();
    expect(progressText(el)).toBe('Step 3 of 5');
    expect(titleText(el)).toBe('Notifications');

    // Step 3 → 4 (notifications "Continue").
    click(el, '.wizard-cta');
    fixture.detectChanges();
    expect(progressText(el)).toBe('Step 4 of 5');
    expect(titleText(el)).toBe('Connect Plex');

    // Step 4 → 5 (Plex "Skip for now" — no Continue in the idle/non-connected stage).
    click(el, '.wizard-skip');
    fixture.detectChanges();
    expect(progressText(el)).toBe('Step 5 of 5');
    expect(titleText(el)).toBe("You're all set");
  });

  it('renders each option with the raw code as value and the endonym as label (spec 0079)', async () => {
    const { el } = await setup();
    const options = Array.from(
      el.querySelectorAll('ion-select-option'),
    ) as (HTMLElement & { value?: string })[];
    // Every option keeps the raw ISO code as its [value] (what persists), while
    // its rendered label is the human-readable display name — proving the
    // value/label divergence. Expected text sourced from the shared helper.
    for (const option of options) {
      const value = (option.getAttribute('ng-reflect-value') ??
        option.value) as Region;
      expect(REGIONS).toContain(value);
      expect(option.textContent?.trim()).toBe(regionDisplayName(value));
    }
    // Spot-check the issue's example so the divergence is explicit.
    const nl = options.find(
      (o) => (o.getAttribute('ng-reflect-value') ?? o.value) === 'NL',
    );
    expect(nl?.textContent?.trim()).toBe('Nederland');
    expect(nl?.textContent?.trim()).not.toBe('NL');
  });

  it('changing region select updates internal state', async () => {
    const { el, fixture, service } = await setup();
    const select = el.querySelector('ion-select');
    select?.dispatchEvent(
      new CustomEvent('ionChange', { detail: { value: 'DE' } }),
    );
    // Region persists in step 1 (spec 0078); the picked value flows through on
    // "Continue" via setRegion — complete() no longer takes the region.
    await continueFromRegion(el, fixture);
    expect(service.setRegion).toHaveBeenCalledWith('DE');
  });

  it('Back from step 2 returns to step 1 with the previously-picked region still selected', async () => {
    const { el, fixture, service } = await setup();

    // Pick "DE" on step 1, then advance to step 2.
    const select = el.querySelector('ion-select');
    select?.dispatchEvent(
      new CustomEvent('ionChange', { detail: { value: 'DE' } }),
    );
    fixture.detectChanges();
    await continueFromRegion(el, fixture);

    expect(progressText(el)).toBe('Step 2 of 5');
    expect(service.setRegion).toHaveBeenCalledWith('DE');

    // Back → step 1; the region select still shows the prior pick (persisted state).
    click(el, '.wizard-back');
    fixture.detectChanges();

    expect(progressText(el)).toBe('Step 1 of 5');
    const backSelect = el.querySelector('ion-select');
    expect(
      backSelect?.getAttribute('ng-reflect-value') ?? backSelect?.value,
    ).toBe('DE');
  });

  it('step-4 "Skip for now" advances to step 5, calls cancel(), and performs no Plex link/write', async () => {
    const { el, fixture, service, plexLink } = await setup();

    // Jump to step 4 (entering it fires the link service's requestCode()).
    service.currentStep.set(4);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(progressText(el)).toBe('Step 4 of 5');

    click(el, '.wizard-skip');
    fixture.detectChanges();

    // Skip stops any live poll and advances WITHOUT authorizing/linking.
    expect(plexLink.cancel).toHaveBeenCalledTimes(1);
    expect(progressText(el)).toBe('Step 5 of 5');
    // No hasPlex/plexSync write: the stage never reaches 'connected' (the only
    // path that runs the link service's internal completeLink persistence), and
    // the finish-step complete() has not fired yet.
    expect(plexLink.stage()).not.toBe('connected');
    expect(service.complete).not.toHaveBeenCalled();
  });

  it('step 5 "Get started" disables the button, calls complete() once, then navigates with replaceUrl', async () => {
    const { el, fixture, service } = await setup();
    service.currentStep.set(5);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(progressText(el)).toBe('Step 5 of 5');

    // complete() pending so the disabled state is observable mid-flight.
    let resolveComplete: () => void = () => undefined;
    service.complete.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveComplete = resolve;
      }),
    );

    // The step-5 "Get started" CTA is the first ion-button (Back follows it).
    const button = el.querySelector('ion-button');
    button?.dispatchEvent(new CustomEvent('click'));
    fixture.detectChanges();

    expect(button?.disabled).toBe(true);
    expect(service.complete).toHaveBeenCalledTimes(1);
    // complete() takes ZERO args now (region is persisted in step 1).
    expect(service.complete).toHaveBeenCalledWith();

    resolveComplete();
    await fixture.whenStable();
    // replaceUrl drops /onboarding from history so the Android back button can't
    // return to it (issue #65).
    expect(navigateMock).toHaveBeenCalledWith(['/tabs/today'], {
      replaceUrl: true,
    });
  });

  it('no double-fire: a second "Get started" tap while complete() is in flight is ignored', async () => {
    const { el, fixture, service } = await setup();
    service.currentStep.set(5);
    fixture.detectChanges();
    await fixture.whenStable();

    // complete() never resolves, so loading stays true after the first click.
    service.complete.mockReturnValue(new Promise<void>(() => undefined));
    const button = el.querySelector('.wizard-cta');

    button?.dispatchEvent(new CustomEvent('click'));
    button?.dispatchEvent(new CustomEvent('click'));

    expect(service.complete).toHaveBeenCalledTimes(1);
  });

  it('catch path: complete() rejecting still navigates with replaceUrl', async () => {
    const { el, fixture, service } = await setup();
    service.currentStep.set(5);
    fixture.detectChanges();
    await fixture.whenStable();

    service.complete.mockRejectedValue(new Error('boom'));
    const button = el.querySelector('.wizard-cta');
    button?.dispatchEvent(new CustomEvent('click'));
    await fixture.whenStable();

    expect(navigateMock).toHaveBeenCalledWith(['/tabs/today'], {
      replaceUrl: true,
    });
  });
});
