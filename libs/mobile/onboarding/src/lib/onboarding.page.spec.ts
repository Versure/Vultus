import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { REGIONS, regionDisplayName, type Region } from '@vultus/shared/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the data-access service module so the page test never pulls in the real
// `@angular/fire/firestore` import chain (rxfire ships ESM-in-CJS and breaks the
// jsdom transform). The page is tested in isolation against this mock.
vi.mock('./onboarding.service', () => ({
  OnboardingService: class OnboardingService {},
}));

import { OnboardingPage } from './onboarding.page';
import { OnboardingService } from './onboarding.service';

interface MockOnboardingService {
  regions: readonly Region[];
  complete: ReturnType<typeof vi.fn>;
}

function mockService(): MockOnboardingService {
  return {
    regions: REGIONS,
    complete: vi.fn().mockResolvedValue(undefined),
  };
}

const navigateMock = vi.fn().mockResolvedValue(true);

async function setup() {
  const service = mockService();
  await TestBed.configureTestingModule({
    imports: [OnboardingPage],
    providers: [
      provideIonicAngular(),
      { provide: OnboardingService, useValue: service },
      { provide: Router, useValue: { navigate: navigateMock } },
    ],
  })
    // The component declares providers: [OnboardingService] for lazy-chunk
    // scoping. Override it so the TestBed-level mock takes effect instead.
    .overrideComponent(OnboardingPage, { set: { providers: [] } })
    .compileComponents();

  const fixture = TestBed.createComponent(OnboardingPage);
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, service, el };
}

describe('OnboardingPage', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    navigateMock.mockClear();
  });

  it('renders welcome header, region select, and get started button', async () => {
    const { el } = await setup();
    expect(el.querySelector('.onboarding-title')?.textContent).toContain(
      'Welcome to Vultus',
    );
    expect(el.querySelector('ion-select')).toBeTruthy();
    expect(el.querySelector('ion-button')).toBeTruthy();
  });

  it('region select lists 10 options with NL default', async () => {
    const { el, fixture } = await setup();
    const options = el.querySelectorAll('ion-select-option');
    expect(options.length).toBe(10);
    expect(options.length).toBe(REGIONS.length);
    const select = el.querySelector('ion-select');
    expect(select?.getAttribute('ng-reflect-value') ?? select?.value).toBe(
      'NL',
    );
    void fixture;
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
    const { el, service } = await setup();
    const select = el.querySelector('ion-select');
    select?.dispatchEvent(
      new CustomEvent('ionChange', { detail: { value: 'DE' } }),
    );
    const button = el.querySelector('ion-button');
    button?.dispatchEvent(new CustomEvent('click'));
    expect(service.complete).toHaveBeenCalledWith('DE');
  });

  it('get started disables button and calls service.complete then navigates', async () => {
    const { el, fixture, service } = await setup();
    // complete() pending so the disabled state is observable mid-flight.
    let resolveComplete: () => void = () => undefined;
    service.complete.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveComplete = resolve;
      }),
    );
    const button = el.querySelector('ion-button') as HTMLElement & {
      disabled?: boolean;
    };
    button.dispatchEvent(new CustomEvent('click'));
    fixture.detectChanges();

    expect(button.disabled).toBe(true);
    expect(service.complete).toHaveBeenCalledTimes(1);
    expect(service.complete).toHaveBeenCalledWith('NL');

    resolveComplete();
    await fixture.whenStable();
    // replaceUrl drops /onboarding from history so the Android back button
    // can't return to it (issue #65).
    expect(navigateMock).toHaveBeenCalledWith(['/tabs/watchlist'], {
      replaceUrl: true,
    });
  });

  it('catch path: complete() rejecting still navigates with replaceUrl', async () => {
    const { el, fixture, service } = await setup();
    service.complete.mockRejectedValue(new Error('boom'));
    const button = el.querySelector('ion-button') as HTMLElement & {
      disabled?: boolean;
    };
    button.dispatchEvent(new CustomEvent('click'));
    await fixture.whenStable();

    expect(navigateMock).toHaveBeenCalledWith(['/tabs/watchlist'], {
      replaceUrl: true,
    });
  });

  it('no double-fire: second tap while loading is ignored', async () => {
    // complete() never resolves, so loading stays true after the first click.
    const { el, service } = await setup();
    service.complete.mockReturnValue(new Promise<void>(() => undefined));
    const button = el.querySelector('ion-button');

    button?.dispatchEvent(new CustomEvent('click'));
    button?.dispatchEvent(new CustomEvent('click'));

    expect(service.complete).toHaveBeenCalledTimes(1);
  });
});
