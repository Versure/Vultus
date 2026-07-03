import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import {
  AlertController,
  provideIonicAngular,
} from '@ionic/angular/standalone';
import {
  REGIONS,
  type CatalogProvider,
  type Region,
} from '@vultus/shared/domain';
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
  providerCatalog: WritableSignal<CatalogProvider[]>;
  myProviderIds: WritableSignal<number[]>;
  catalogLoading: WritableSignal<boolean>;
  lastPrunedCount: WritableSignal<number>;
  hasPlex: WritableSignal<boolean>;
  load: ReturnType<typeof vi.fn>;
  setRegion: ReturnType<typeof vi.fn>;
  setNotificationsEnabled: ReturnType<typeof vi.fn>;
  setDeliveryHour: ReturnType<typeof vi.fn>;
  retryLoad: ReturnType<typeof vi.fn>;
  loadProviderCatalog: ReturnType<typeof vi.fn>;
  toggleProvider: ReturnType<typeof vi.fn>;
  toggleHasPlex: ReturnType<typeof vi.fn>;
}

const CATALOG: CatalogProvider[] = [
  { providerId: 8, name: 'Netflix', logoPath: '/n.jpg' },
  { providerId: 337, name: 'Disney Plus', logoPath: '/d.jpg' },
  { providerId: 1899, name: 'Max', logoPath: null },
];

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
  // The page also imports `relativeTime` from this module (spec 0073 Plex card
  // "Last synced — {relative}"); provide a deterministic stub.
  return {
    SyncStatusCardComponent: StubSyncStatusCardComponent,
    relativeTime: (): string => '12 minutes ago',
  };
});

// Mock the Plex service modules so the page test stays off the
// `@angular/fire/firestore` / `@capacitor/*` import chains (bare classes act as
// DI tokens; instances are supplied via useValue in setup).
vi.mock('./plex-link.service', () => ({
  PlexLinkService: class PlexLinkService {},
}));
vi.mock('./plex-sync.service', () => ({
  PlexSyncService: class PlexSyncService {},
}));

// `./settings.providers` (imported transitively by the page) statically imports
// the real `SyncStatusService`, which pulls in `@angular/fire/firestore`. Mock
// it to a bare class so the page test stays off the rxfire ESM-in-CJS chain.
vi.mock('./sync-status.service', () => ({
  SyncStatusService: class SyncStatusService {},
}));

import { SettingsPage } from './settings.page';
import { SettingsService } from './settings.service';
import { PlexLinkService } from './plex-link.service';
import { PlexSyncService } from './plex-sync.service';

interface MockPlexLink {
  linked: WritableSignal<boolean>;
  serverName: WritableSignal<string | null>;
  lastSyncAt: WritableSignal<string | null>;
  loadState: ReturnType<typeof vi.fn>;
  unlink: ReturnType<typeof vi.fn>;
}
interface MockPlexSync {
  running: WritableSignal<boolean>;
  sync: ReturnType<typeof vi.fn>;
}

function mockPlexLink(linked: boolean): MockPlexLink {
  return {
    linked: signal<boolean>(linked),
    serverName: signal<string | null>('Vultus Media Server'),
    lastSyncAt: signal<string | null>(new Date().toISOString()),
    loadState: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
}
function mockPlexSync(): MockPlexSync {
  return {
    running: signal<boolean>(false),
    sync: vi.fn().mockResolvedValue({ added: 0, updated: 0, skipped: 0 }),
  };
}

function mockService(loaded: boolean, loadFailed = false): MockSettingsService {
  return {
    regions: REGIONS,
    deliveryHours: Array.from({ length: 24 }, (_v, i) => i),
    region: signal<Region | null>('NL'),
    notificationsEnabled: signal<boolean>(true),
    deliveryHour: signal<number | null>(null),
    loaded: signal<boolean>(loaded),
    loadFailed: signal<boolean>(loadFailed),
    providerCatalog: signal<CatalogProvider[]>(CATALOG),
    myProviderIds: signal<number[]>([8]),
    catalogLoading: signal<boolean>(false),
    lastPrunedCount: signal<number>(0),
    hasPlex: signal<boolean>(true),
    load: vi.fn().mockResolvedValue(undefined),
    setRegion: vi.fn().mockResolvedValue(undefined),
    setNotificationsEnabled: vi.fn().mockResolvedValue(undefined),
    setDeliveryHour: vi.fn().mockResolvedValue(undefined),
    retryLoad: vi.fn(),
    loadProviderCatalog: vi.fn().mockResolvedValue(undefined),
    toggleProvider: vi.fn().mockResolvedValue(undefined),
    toggleHasPlex: vi.fn().mockResolvedValue(undefined),
  };
}

async function setupWithService(
  service: MockSettingsService,
  opts: { plexLinked?: boolean } = {},
) {
  const plexLink = mockPlexLink(opts.plexLinked ?? false);
  const plexSync = mockPlexSync();
  const router = { navigate: vi.fn() };
  const alertPresent = vi.fn().mockResolvedValue(undefined);
  const alertController = {
    create: vi.fn().mockResolvedValue({ present: alertPresent }),
  };
  await TestBed.configureTestingModule({
    imports: [SettingsPage],
    providers: [
      provideIonicAngular(),
      { provide: SettingsService, useValue: service },
      { provide: PlexLinkService, useValue: plexLink },
      { provide: PlexSyncService, useValue: plexSync },
      { provide: Router, useValue: router },
      { provide: AlertController, useValue: alertController },
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
  return {
    fixture,
    service,
    el,
    plexLink,
    plexSync,
    router,
    alertController,
    alertPresent,
  };
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

  // ── My Providers card (spec 0060) ────────────────────────────────────────

  it('calls loadProviderCatalog() on init', async () => {
    const { service } = await setup(true);
    expect(service.loadProviderCatalog).toHaveBeenCalledTimes(1);
  });

  it('renders a chip per provider in the catalog (plus the Plex chip)', async () => {
    const { el } = await setup(true);
    // The Plex chip (spec 0061) is also a `.provider-chip`; exclude it to count
    // only the TMDB catalog chips.
    const catalogChips = el.querySelectorAll(
      '.provider-chip:not(.provider-chip--plex)',
    );
    expect(catalogChips.length).toBe(CATALOG.length);
  });

  it('marks the selected chip (id in myProviderIds) with aria-pressed and the selected class', async () => {
    const { el } = await setup(true); // myProviderIds seeded [8] = Netflix
    const chips = Array.from(el.querySelectorAll('.provider-chip'));
    // Netflix (id 8) is the first catalog entry and is selected.
    const netflix = chips[0];
    const disney = chips[1];
    expect(netflix.getAttribute('aria-pressed')).toBe('true');
    expect(netflix.classList.contains('provider-chip--selected')).toBe(true);
    expect(netflix.querySelector('.provider-chip__badge')).toBeTruthy();
    expect(disney.getAttribute('aria-pressed')).toBe('false');
    expect(disney.classList.contains('provider-chip--selected')).toBe(false);
    expect(disney.querySelector('.provider-chip__badge')).toBeFalsy();
  });

  it('tapping a chip calls onProviderToggle → toggleProvider with the provider id', async () => {
    const { el, service } = await setup(true);
    const disney = el.querySelectorAll('.provider-chip')[1] as HTMLElement;
    disney.click();
    expect(service.toggleProvider).toHaveBeenCalledWith(337);
  });

  it('renders the footer count "N of M selected · Region: {region}"', async () => {
    const { el } = await setup(true);
    const footer = el.querySelector('.provider-footer');
    expect(footer?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '1 of 3 selected · Region: NL',
    );
  });

  it('shows a spinner (not chips) while the catalog is loading', async () => {
    const service = mockService(true);
    service.catalogLoading.set(true);
    const { el } = await setupWithService(service);
    expect(el.querySelector('.providers-loading ion-spinner')).toBeTruthy();
    expect(el.querySelector('.provider-chip')).toBeFalsy();
  });

  it('falls back to a letter tile when a provider has no logo path', async () => {
    const { el } = await setup(true);
    // Max (id 1899, logoPath null) is the third chip.
    const max = el.querySelectorAll('.provider-chip')[2] as HTMLElement;
    expect(
      max.querySelector('.provider-chip__logo-fallback')?.textContent,
    ).toBe('M');
    expect(max.querySelector('img')).toBeFalsy();
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

  // ── Plex chip (spec 0061) ────────────────────────────────────────────────

  it('renders the Plex chip as the last chip in the grid', async () => {
    const { el } = await setup(true);
    const grid = el.querySelector('.provider-grid');
    const chips = Array.from(grid?.querySelectorAll('.provider-chip') ?? []);
    const plex = grid?.querySelector('.provider-chip--plex');
    expect(plex).toBeTruthy();
    // It sits AFTER all the TMDB catalog chips.
    expect(chips[chips.length - 1]).toBe(plex);
    expect(plex?.querySelector('.provider-chip__name')?.textContent).toBe(
      'Plex',
    );
    expect(plex?.querySelector('img')?.getAttribute('src')).toBe(
      '/assets/plex-logo.svg',
    );
  });

  it('renders the Plex-only "Manual" secondary caption', async () => {
    const { el } = await setup(true);
    const plex = el.querySelector('.provider-chip--plex');
    expect(plex?.querySelector('.provider-chip__caption')?.textContent).toBe(
      'Manual',
    );
    // Sibling TMDB chips have no caption.
    const firstCatalog = el.querySelector(
      '.provider-chip:not(.provider-chip--plex)',
    );
    expect(firstCatalog?.querySelector('.provider-chip__caption')).toBeFalsy();
  });

  it('renders the Plex chip selected (badge + aria-pressed) when hasPlex is true', async () => {
    const service = mockService(true);
    service.hasPlex.set(true);
    const { el } = await setupWithService(service);
    const plex = el.querySelector('.provider-chip--plex');
    expect(plex?.getAttribute('aria-pressed')).toBe('true');
    expect(plex?.classList.contains('provider-chip--selected')).toBe(true);
    expect(plex?.querySelector('.provider-chip__badge')).toBeTruthy();
  });

  it('renders the Plex chip unselected (no badge) when hasPlex is false', async () => {
    const service = mockService(true);
    service.hasPlex.set(false);
    const { el } = await setupWithService(service);
    const plex = el.querySelector('.provider-chip--plex');
    expect(plex?.getAttribute('aria-pressed')).toBe('false');
    expect(plex?.classList.contains('provider-chip--selected')).toBe(false);
    expect(plex?.querySelector('.provider-chip__badge')).toBeFalsy();
  });

  it('tapping the Plex chip calls onPlexToggle → toggleHasPlex', async () => {
    const { el, service } = await setup(true);
    const plex = el.querySelectorAll('.provider-chip--plex')[0] as HTMLElement;
    plex.click();
    expect(service.toggleHasPlex).toHaveBeenCalledTimes(1);
    // It never calls the TMDB provider toggle.
    expect(service.toggleProvider).not.toHaveBeenCalled();
  });

  // ── Plex Server card (spec 0073) ─────────────────────────────────────────

  it('loads the Plex link state on init', async () => {
    const { plexLink } = await setup(true);
    expect(plexLink.loadState).toHaveBeenCalledTimes(1);
  });

  it('disconnected: renders EXACT "Connect Plex Server" + caption, gated on !linked', async () => {
    const { el } = await setupWithService(mockService(true), {
      plexLinked: false,
    });
    const row = el.querySelector('.plex-connect-row');
    expect(row).toBeTruthy();
    expect(row?.querySelector('.plex-connect-row__title')?.textContent).toBe(
      'Connect Plex Server',
    );
    expect(row?.querySelector('.plex-connect-row__caption')?.textContent).toBe(
      'Sync library additions and watch history',
    );
    // Connected block is NOT rendered.
    expect(el.querySelector('.plex-connected')).toBeFalsy();
  });

  it('disconnected: tapping the row navigates to /tabs/settings/plex', async () => {
    const { el, router } = await setupWithService(mockService(true), {
      plexLinked: false,
    });
    (el.querySelectorAll('.plex-connect-row')[0] as HTMLElement).click();
    expect(router.navigate).toHaveBeenCalledWith(['/tabs/settings/plex']);
  });

  it('connected: renders the server name, EXACT "Connected", "Sync now", "Disconnect"', async () => {
    const { el } = await setupWithService(mockService(true), {
      plexLinked: true,
    });
    const block = el.querySelector('.plex-connected');
    expect(block).toBeTruthy();
    expect(
      block?.querySelector('.plex-connected__name')?.textContent,
    ).toContain('Vultus Media Server');
    expect(
      block?.querySelector('.plex-connected__status-label')?.textContent,
    ).toBe('Connected');
    expect(
      block?.querySelector('.plex-text-button--primary')?.textContent?.trim(),
    ).toBe('Sync now');
    expect(
      block?.querySelector('.plex-text-button--danger')?.textContent?.trim(),
    ).toBe('Disconnect');
    // Disconnected row is NOT rendered.
    expect(el.querySelector('.plex-connect-row')).toBeFalsy();
  });

  it('connected: "Sync now" calls PlexSyncService.sync()', async () => {
    const { el, plexSync } = await setupWithService(mockService(true), {
      plexLinked: true,
    });
    (
      el.querySelectorAll('.plex-text-button--primary')[0] as HTMLElement
    ).click();
    expect(plexSync.sync).toHaveBeenCalledTimes(1);
  });

  it('connected: "Sync now" disabled and shows "Syncing…" while running()', async () => {
    const service = mockService(true);
    const { el, plexSync, fixture } = await setupWithService(service, {
      plexLinked: true,
    });
    plexSync.running.set(true);
    fixture.detectChanges();
    const button = el.querySelectorAll(
      '.plex-text-button--primary',
    )[0] as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent?.trim()).toBe('Syncing…');
  });

  it('connected: "Disconnect" opens a confirm alert (unlink runs from its handler)', async () => {
    const { el, alertController } = await setupWithService(mockService(true), {
      plexLinked: true,
    });
    (
      el.querySelectorAll('.plex-text-button--danger')[0] as HTMLElement
    ).click();
    await Promise.resolve();
    expect(alertController.create).toHaveBeenCalledTimes(1);
    const arg = alertController.create.mock.calls[0][0] as {
      buttons: { text: string; handler?: () => void }[];
    };
    const disconnectBtn = arg.buttons.find((b) => b.text === 'Disconnect');
    expect(disconnectBtn).toBeTruthy();
  });

  it('connected: confirming the alert calls PlexLinkService.unlink()', async () => {
    const { el, alertController, plexLink } = await setupWithService(
      mockService(true),
      { plexLinked: true },
    );
    (
      el.querySelectorAll('.plex-text-button--danger')[0] as HTMLElement
    ).click();
    await Promise.resolve();
    const arg = alertController.create.mock.calls[0][0] as {
      buttons: { text: string; handler?: () => void }[];
    };
    const disconnectBtn = arg.buttons.find((b) => b.text === 'Disconnect');
    disconnectBtn?.handler?.();
    expect(plexLink.unlink).toHaveBeenCalledTimes(1);
  });

  it('connected: renders "Not synced yet" when lastSyncAt is null', async () => {
    const service = mockService(true);
    const link = mockPlexLink(true);
    link.lastSyncAt.set(null);
    const plexSync = mockPlexSync();
    await TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [
        provideIonicAngular(),
        { provide: SettingsService, useValue: service },
        { provide: PlexLinkService, useValue: link },
        { provide: PlexSyncService, useValue: plexSync },
        { provide: Router, useValue: { navigate: vi.fn() } },
        {
          provide: AlertController,
          useValue: { create: vi.fn().mockResolvedValue({ present: vi.fn() }) },
        },
      ],
    })
      .overrideComponent(SettingsPage, { set: { providers: [] } })
      .compileComponents();
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(
      el.querySelector('.plex-connected__last-synced')?.textContent?.trim(),
    ).toBe('Not synced yet');
  });
});
