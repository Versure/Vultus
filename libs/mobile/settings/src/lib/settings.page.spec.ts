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
  region: WritableSignal<Region | null>;
  notificationsEnabled: WritableSignal<boolean>;
  loaded: WritableSignal<boolean>;
  loadFailed: WritableSignal<boolean>;
  load: ReturnType<typeof vi.fn>;
  setRegion: ReturnType<typeof vi.fn>;
  setNotificationsEnabled: ReturnType<typeof vi.fn>;
  retryLoad: ReturnType<typeof vi.fn>;
}

vi.mock('./settings.service', () => ({
  // A bare class is enough to act as the DI token; the instance is supplied via
  // a useValue provider in each test.
  SettingsService: class SettingsService {},
}));

import { SettingsPage } from './settings.page';
import { SettingsService } from './settings.service';

function mockService(loaded: boolean, loadFailed = false): MockSettingsService {
  return {
    regions: REGIONS,
    region: signal<Region | null>('NL'),
    notificationsEnabled: signal<boolean>(true),
    loaded: signal<boolean>(loaded),
    loadFailed: signal<boolean>(loadFailed),
    load: vi.fn().mockResolvedValue(undefined),
    setRegion: vi.fn().mockResolvedValue(undefined),
    setNotificationsEnabled: vi.fn().mockResolvedValue(undefined),
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

  it('lists the ten regions as select options', async () => {
    const { el } = await setup(true);
    const options = el.querySelectorAll('ion-select-option');
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
