import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { REGIONS, type Region } from '@vultus/shared/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the data-access service module so the page component test never pulls in
// the real `@angular/fire/firestore` import chain (rxfire ships ESM-in-CJS and
// breaks the jsdom transform). The page is tested in isolation against this
// mock, which is all a component test needs.
interface MockSettingsService {
  regions: readonly Region[];
  deliveryHours: readonly number[];
  region: WritableSignal<Region | null>;
  notificationsEnabled: WritableSignal<boolean>;
  deliveryHour: WritableSignal<number | null>;
  loaded: WritableSignal<boolean>;
  loadFailed: WritableSignal<boolean>;
  load: ReturnType<typeof vi.fn>;
  setRegion: ReturnType<typeof vi.fn>;
  setNotificationsEnabled: ReturnType<typeof vi.fn>;
  setDeliveryHour: ReturnType<typeof vi.fn>;
  retryLoad: ReturnType<typeof vi.fn>;
}

vi.mock('./settings.service', () => ({
  // A bare class is enough to act as the DI token; the instance is supplied via
  // a useValue provider in each test.
  SettingsService: class SettingsService {},
}));

// Stub the sync-status card with a lightweight standalone component of the same
// selector so the page test never pulls in the real `@angular/fire/firestore`
// import chain (rxfire ESM-in-CJS breaks the jsdom transform). The card's own
// behaviour is covered by sync-status-card.component.spec.ts. The class is
// defined INSIDE the (hoisted) factory to avoid a temporal-dead-zone reference.
vi.mock('./sync-status-card.component', async () => {
  const { Component } = await import('@angular/core');
  @Component({ selector: 'lib-sync-status-card', template: '' })
  class StubSyncStatusCardComponent {}
  return { SyncStatusCardComponent: StubSyncStatusCardComponent };
});

// `./settings.providers` (imported transitively by the page) statically imports
// the real `SyncStatusService`, which pulls in `@angular/fire/firestore`. Mock
// it to a bare class so the page test stays off the rxfire ESM-in-CJS chain.
vi.mock('./sync-status.service', () => ({
  SyncStatusService: class SyncStatusService {},
}));

import { SettingsPage } from './settings.page';
import { SettingsService } from './settings.service';

function mockService(loaded: boolean, loadFailed = false): MockSettingsService {
  return {
    regions: REGIONS,
    deliveryHours: Array.from({ length: 24 }, (_v, i) => i),
    region: signal<Region | null>('NL'),
    notificationsEnabled: signal<boolean>(true),
    deliveryHour: signal<number | null>(null),
    loaded: signal<boolean>(loaded),
    loadFailed: signal<boolean>(loadFailed),
    load: vi.fn().mockResolvedValue(undefined),
    setRegion: vi.fn().mockResolvedValue(undefined),
    setNotificationsEnabled: vi.fn().mockResolvedValue(undefined),
    setDeliveryHour: vi.fn().mockResolvedValue(undefined),
    retryLoad: vi.fn(),
  };
}

async function setupWithService(service: MockSettingsService) {
  await TestBed.configureTestingModule({
    imports: [SettingsPage],
    providers: [
      provideIonicAngular(),
      { provide: SettingsService, useValue: service },
    ],
  })
    // The component declares providers: [SettingsService] for lazy-chunk scoping.
    // Override it in tests so the TestBed-level mock takes effect instead.
    .overrideComponent(SettingsPage, { set: { providers: [] } })
    .compileComponents();

  const fixture = TestBed.createComponent(SettingsPage);
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, service, el };
}

async function setup(loaded: boolean, loadFailed = false) {
  return setupWithService(mockService(loaded, loadFailed));
}

describe('SettingsPage', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('calls load() on init', async () => {
    const { service } = await setup(true);
    expect(service.load).toHaveBeenCalledTimes(1);
  });

  it('renders the region select and notifications toggle once loaded', async () => {
    const { el } = await setup(true);
    expect(el.querySelector('ion-select')).toBeTruthy();
    expect(el.querySelector('ion-toggle')).toBeTruthy();
    expect(el.querySelector('ion-skeleton-text')).toBeFalsy();
    expect(el.querySelector('vultus-error-state')).toBeFalsy();
  });

  it('renders the sync-status card in the .settings-cards stack once loaded', async () => {
    const { el } = await setup(true);
    const stack = el.querySelector('.settings-cards');
    expect(stack).toBeTruthy();
    const card = stack?.querySelector('lib-sync-status-card');
    expect(card).toBeTruthy();
  });

  it('lists the ten regions as select options', async () => {
    const { el } = await setup(true);
    // The region select is the FIRST ion-select; scope to it so the new
    // delivery-time select's options don't inflate the count.
    const regionSelect = el.querySelectorAll('ion-select')[0];
    const options = regionSelect.querySelectorAll('ion-select-option');
    expect(options.length).toBe(10);
    expect(options.length).toBe(REGIONS.length);
  });

  it('changing the select calls setRegion with the chosen region', async () => {
    const { el, service } = await setup(true);
    const select = el.querySelector('ion-select');
    expect(select).toBeTruthy();
    select?.dispatchEvent(
      new CustomEvent('ionChange', { detail: { value: 'DE' } }),
    );
    expect(service.setRegion).toHaveBeenCalledWith('DE');
  });

  it('renders the Notification time select with 25 options (Any time + 24 hours)', async () => {
    const { el } = await setup(true);
    const selects = el.querySelectorAll('ion-select');
    // Region select [0], delivery-time select [1].
    expect(selects.length).toBe(2);
    const deliverySelect = selects[1];
    expect(deliverySelect.getAttribute('label')).toBe('Notification time');
    const options = deliverySelect.querySelectorAll('ion-select-option');
    expect(options.length).toBe(25);
  });

  it('changing the Notification time select calls setDeliveryHour with the chosen value', async () => {
    const { el, service } = await setup(true);
    const deliverySelect = el.querySelectorAll('ion-select')[1];
    deliverySelect.dispatchEvent(
      new CustomEvent('ionChange', { detail: { value: 8 } }),
    );
    expect(service.setDeliveryHour).toHaveBeenCalledWith(8);
  });

  it('disables the Notification time select when notifications are off', async () => {
    const service = mockService(true);
    service.notificationsEnabled.set(false);
    const { el } = await setupWithService(service);
    // Angular binds `[disabled]` to the ion-select element's `disabled`
    // property (not a reflected attribute under jsdom), so assert the property.
    const deliverySelect = el.querySelectorAll(
      'ion-select',
    )[1] as HTMLElement & {
      disabled: boolean;
    };
    expect(deliverySelect.disabled).toBe(true);
  });

  it('enables the Notification time select when notifications are on', async () => {
    const service = mockService(true);
    service.notificationsEnabled.set(true);
    const { el } = await setupWithService(service);
    const deliverySelect = el.querySelectorAll(
      'ion-select',
    )[1] as HTMLElement & {
      disabled: boolean;
    };
    expect(deliverySelect.disabled).toBe(false);
  });

  it('toggling notifications calls setNotificationsEnabled with the new boolean', async () => {
    const { el, service } = await setup(true);
    const toggle = el.querySelector('ion-toggle');
    expect(toggle).toBeTruthy();
    toggle?.dispatchEvent(
      new CustomEvent('ionChange', { detail: { checked: false } }),
    );
    expect(service.setNotificationsEnabled).toHaveBeenCalledWith(false);
  });

  it('render-gates: shows a skeleton (no form) before load resolves', async () => {
    const { el } = await setup(false);
    expect(el.querySelector('ion-skeleton-text')).toBeTruthy();
    expect(el.querySelector('ion-select')).toBeFalsy();
    expect(el.querySelector('ion-toggle')).toBeFalsy();
    expect(el.querySelector('vultus-error-state')).toBeFalsy();
  });

  it('shows error state (no skeleton, no form) when loadFailed is true', async () => {
    const { el } = await setup(false, true);
    expect(el.querySelector('vultus-error-state')).toBeTruthy();
    expect(el.querySelector('ion-skeleton-text')).toBeFalsy();
    expect(el.querySelector('ion-select')).toBeFalsy();
  });

  it('calls retryLoad() when the error state emits retry', async () => {
    const { el, service } = await setup(false, true);
    const errorEl = el.querySelector('vultus-error-state');
    expect(errorEl).toBeTruthy();
    errorEl?.dispatchEvent(new CustomEvent('retry'));
    expect(service.retryLoad).toHaveBeenCalledTimes(1);
  });
});
