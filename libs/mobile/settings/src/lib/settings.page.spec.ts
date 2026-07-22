import { signal, type WritableSignal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router } from '@angular/router';
import {
  AlertController,
  ToastController,
  provideIonicAngular,
} from '@ionic/angular/standalone';
import {
  REGIONS,
  regionDisplayName,
  type CatalogProvider,
  type PlexUnmatchedTitle,
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
  movieLeavingPlatform: WritableSignal<boolean>;
  showLeavingPlatform: WritableSignal<boolean>;
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
  setMovieLeavingPlatform: ReturnType<typeof vi.fn>;
  setShowLeavingPlatform: ReturnType<typeof vi.fn>;
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
vi.mock('./plex-background.service', () => ({
  PlexBackgroundService: class PlexBackgroundService {},
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
import { PlexBackgroundService } from './plex-background.service';

interface MockPlexLink {
  linked: WritableSignal<boolean>;
  serverName: WritableSignal<string | null>;
  lastSyncAt: WritableSignal<string | null>;
  unmatched: WritableSignal<PlexUnmatchedTitle[]>;
  loadState: ReturnType<typeof vi.fn>;
  unlink: ReturnType<typeof vi.fn>;
}
interface MockPlexSync {
  running: WritableSignal<boolean>;
  sync: ReturnType<typeof vi.fn>;
}
interface MockPlexBackground {
  enabled: WritableSignal<boolean>;
  intervalMinutes: WritableSignal<number>;
  init: ReturnType<typeof vi.fn>;
  setEnabled: ReturnType<typeof vi.fn>;
  setIntervalMinutes: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function mockPlexLink(linked: boolean): MockPlexLink {
  return {
    linked: signal<boolean>(linked),
    serverName: signal<string | null>('Vultus Media Server'),
    lastSyncAt: signal<string | null>(new Date().toISOString()),
    unmatched: signal<PlexUnmatchedTitle[]>([]),
    loadState: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
}
function mockPlexSync(): MockPlexSync {
  return {
    running: signal<boolean>(false),
    sync: vi.fn().mockResolvedValue({
      status: 'ok',
      summary: { added: 0, updated: 0, skipped: 0, unmatched: 0 },
    }),
  };
}
function mockPlexBackground(enabled = true, interval = 60): MockPlexBackground {
  return {
    enabled: signal<boolean>(enabled),
    intervalMinutes: signal<number>(interval),
    init: vi.fn().mockResolvedValue(undefined),
    setEnabled: vi.fn().mockResolvedValue(undefined),
    setIntervalMinutes: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function mockService(loaded: boolean, loadFailed = false): MockSettingsService {
  return {
    regions: REGIONS,
    deliveryHours: Array.from({ length: 24 }, (_v, i) => i),
    region: signal<Region | null>('NL'),
    notificationsEnabled: signal<boolean>(true),
    deliveryHour: signal<number | null>(null),
    movieLeavingPlatform: signal<boolean>(true),
    showLeavingPlatform: signal<boolean>(true),
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
    setMovieLeavingPlatform: vi.fn().mockResolvedValue(undefined),
    setShowLeavingPlatform: vi.fn().mockResolvedValue(undefined),
    retryLoad: vi.fn(),
    loadProviderCatalog: vi.fn().mockResolvedValue(undefined),
    toggleProvider: vi.fn().mockResolvedValue(undefined),
    toggleHasPlex: vi.fn().mockResolvedValue(undefined),
  };
}

async function setupWithService(
  service: MockSettingsService,
  opts: { plexLinked?: boolean; plexBackground?: MockPlexBackground } = {},
) {
  const plexLink = mockPlexLink(opts.plexLinked ?? false);
  const plexSync = mockPlexSync();
  const plexBackground = opts.plexBackground ?? mockPlexBackground();
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
      { provide: PlexBackgroundService, useValue: plexBackground },
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
    plexBackground,
    router,
    alertController,
    alertPresent,
  };
}

async function setup(loaded: boolean, loadFailed = false) {
  return setupWithService(mockService(loaded, loadFailed));
}

// #166: the "My Providers" grid is COLLAPSED by default. Tests that assert on the
// chip grid must first expand the card by tapping the disclosure header.
function expandProviders(
  fixture: ComponentFixture<SettingsPage>,
  el: HTMLElement,
): void {
  (
    el.querySelectorAll('button.settings-row--header')[0] as HTMLElement
  ).click();
  fixture.detectChanges();
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

  it('lists the ten regions as select options — display-name labels, raw-code values', async () => {
    const { el } = await setup(true);
    // The region select is the FIRST ion-select; scope to it so the new
    // delivery-time select's options don't inflate the count.
    const regionSelect = el.querySelectorAll('ion-select')[0];
    const options = regionSelect.querySelectorAll('ion-select-option');
    expect(options.length).toBe(10);
    expect(options.length).toBe(REGIONS.length);
    // spec 0079: the VALUE stays the raw ISO code (what persists), while the
    // visible LABEL is the human-readable endonym. Source expected text from the
    // shared helper — never a re-hardcoded literal — so a future rename can't
    // silently desync the test from source.
    options.forEach((option, i) => {
      const region = REGIONS[i];
      expect((option as HTMLElement & { value: Region }).value).toBe(region);
      expect(option.textContent?.trim()).toBe(regionDisplayName(region));
    });
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

  // ── Leaving-platform toggle rows (spec 0057) ─────────────────────────────
  // With Plex disconnected (setup default), the ion-toggles in DOM order are:
  // [0] Notifications, [1] Movie leaving, [2] Show leaving.

  it('renders the two leaving-platform toggle rows reflecting the service signals', async () => {
    const service = mockService(true);
    service.movieLeavingPlatform.set(true);
    service.showLeavingPlatform.set(false);
    const { el } = await setupWithService(service);
    const toggles = el.querySelectorAll('ion-toggle');
    const movie = toggles[1] as HTMLElement & { checked: boolean };
    const show = toggles[2] as HTMLElement & { checked: boolean };
    expect(movie.textContent?.trim()).toBe('Movie leaving your platform');
    expect(movie.checked).toBe(true);
    expect(show.textContent?.trim()).toBe('Show leaving your platform');
    expect(show.checked).toBe(false);
  });

  it('toggling "Movie leaving your platform" calls setMovieLeavingPlatform with the new boolean', async () => {
    const { el, service } = await setup(true);
    const movie = el.querySelectorAll('ion-toggle')[1];
    movie.dispatchEvent(
      new CustomEvent('ionChange', { detail: { checked: false } }),
    );
    expect(service.setMovieLeavingPlatform).toHaveBeenCalledWith(false);
  });

  it('toggling "Show leaving your platform" calls setShowLeavingPlatform with the new boolean', async () => {
    const { el, service } = await setup(true);
    const show = el.querySelectorAll('ion-toggle')[2];
    show.dispatchEvent(
      new CustomEvent('ionChange', { detail: { checked: false } }),
    );
    expect(service.setShowLeavingPlatform).toHaveBeenCalledWith(false);
  });

  // ── My Providers card (spec 0060 + 0075 #166) ────────────────────────────

  it('#166: collapsed by default — grid absent, header aria-expanded="false"', async () => {
    const { el } = await setup(true);
    expect(el.querySelector('.provider-grid')).toBeFalsy();
    const header = el.querySelector('button.settings-row--header');
    expect(header).toBeTruthy();
    expect(header?.getAttribute('aria-expanded')).toBe('false');
  });

  it('#166: tapping the header expands — grid present, aria-expanded="true", chevron rotated', async () => {
    const { el, fixture } = await setup(true);
    expandProviders(fixture, el);
    expect(el.querySelector('.provider-grid')).toBeTruthy();
    const header = el.querySelector('button.settings-row--header');
    expect(header?.getAttribute('aria-expanded')).toBe('true');
    const chevron = el.querySelector('ion-icon.providers-chevron');
    expect(chevron?.classList.contains('expanded')).toBe(true);
  });

  it('#166: footer is visible in BOTH collapsed and expanded states', async () => {
    const { el, fixture } = await setup(true);
    // Collapsed (default): footer present even though the grid is not.
    expect(el.querySelector('.provider-footer')).toBeTruthy();
    expect(el.querySelector('.provider-grid')).toBeFalsy();
    // Expanded: footer still present.
    expandProviders(fixture, el);
    expect(el.querySelector('.provider-footer')).toBeTruthy();
  });

  it('renders a chip per provider in the catalog (plus the Plex chip)', async () => {
    const { el, fixture } = await setup(true);
    expandProviders(fixture, el);
    // The Plex chip (spec 0061) is also a `.provider-chip`; exclude it to count
    // only the TMDB catalog chips.
    const catalogChips = el.querySelectorAll(
      '.provider-chip:not(.provider-chip--plex)',
    );
    expect(catalogChips.length).toBe(CATALOG.length);
  });

  it('marks the selected chip (id in myProviderIds) with aria-pressed and the selected class', async () => {
    const { el, fixture } = await setup(true); // myProviderIds seeded [8] = Netflix
    expandProviders(fixture, el);
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
    const { el, service, fixture } = await setup(true);
    expandProviders(fixture, el);
    const disney = el.querySelectorAll('.provider-chip')[1] as HTMLElement;
    disney.click();
    expect(service.toggleProvider).toHaveBeenCalledWith(337);
  });

  it('renders the footer count "N of M selected · Region: {displayName}"', async () => {
    const { el } = await setup(true);
    const footer = el.querySelector('.provider-footer');
    // #166 (F3): exact rendered string, single .trim() only — no \s+ collapse.
    // spec 0079: the trailing region now renders its display name (endonym),
    // sourced from the shared helper, not a re-hardcoded literal. The persisted
    // value stays the raw ISO code (asserted in the options test above).
    expect(footer?.textContent?.trim()).toBe(
      `1 of 3 selected · Region: ${regionDisplayName('NL')}`,
    );
  });

  it('prune toast: message names the region by its display name (endonym), not the raw code', async () => {
    // `presentPruneToast` is private; drive it through its public wiring — the
    // effect that fires when `lastPrunedCount > 0` (settings.page.ts) — and
    // capture the built message via a mocked ToastController.create. Seed the
    // count > 0 BEFORE first change detection so the effect's initial run fires.
    const service = mockService(true); // region seeded 'NL'
    service.lastPrunedCount.set(2);
    const toastPresent = vi.fn().mockResolvedValue(undefined);
    const toastController = {
      create: vi.fn().mockResolvedValue({ present: toastPresent }),
    };
    await TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [
        provideIonicAngular(),
        { provide: SettingsService, useValue: service },
        { provide: PlexLinkService, useValue: mockPlexLink(false) },
        { provide: PlexSyncService, useValue: mockPlexSync() },
        { provide: PlexBackgroundService, useValue: mockPlexBackground() },
        { provide: Router, useValue: { navigate: vi.fn() } },
        {
          provide: AlertController,
          useValue: { create: vi.fn().mockResolvedValue({ present: vi.fn() }) },
        },
        // Overrides the ToastController provideIonicAngular() registers.
        { provide: ToastController, useValue: toastController },
      ],
    })
      .overrideComponent(SettingsPage, { set: { providers: [] } })
      .compileComponents();
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(toastController.create).toHaveBeenCalledTimes(1);
    const arg = toastController.create.mock.calls[0][0] as { message: string };
    // Exact substring from the shared helper — NL → its endonym, not "NL".
    expect(arg.message).toContain(
      `aren't available in ${regionDisplayName('NL')}`,
    );
    expect(arg.message).not.toContain("aren't available in NL");
    expect(arg.message).toContain('2 providers');
  });

  it('shows a spinner (not chips) while the catalog is loading', async () => {
    const service = mockService(true);
    service.catalogLoading.set(true);
    const { el } = await setupWithService(service);
    expect(el.querySelector('.providers-loading ion-spinner')).toBeTruthy();
    expect(el.querySelector('.provider-chip')).toBeFalsy();
  });

  it('falls back to a letter tile when a provider has no logo path', async () => {
    const { el, fixture } = await setup(true);
    expandProviders(fixture, el);
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
    const { el, fixture } = await setup(true);
    expandProviders(fixture, el);
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
    const { el, fixture } = await setup(true);
    expandProviders(fixture, el);
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
    const { el, fixture } = await setupWithService(service);
    expandProviders(fixture, el);
    const plex = el.querySelector('.provider-chip--plex');
    expect(plex?.getAttribute('aria-pressed')).toBe('true');
    expect(plex?.classList.contains('provider-chip--selected')).toBe(true);
    expect(plex?.querySelector('.provider-chip__badge')).toBeTruthy();
  });

  it('renders the Plex chip unselected (no badge) when hasPlex is false', async () => {
    const service = mockService(true);
    service.hasPlex.set(false);
    const { el, fixture } = await setupWithService(service);
    expandProviders(fixture, el);
    const plex = el.querySelector('.provider-chip--plex');
    expect(plex?.getAttribute('aria-pressed')).toBe('false');
    expect(plex?.classList.contains('provider-chip--selected')).toBe(false);
    expect(plex?.querySelector('.provider-chip__badge')).toBeFalsy();
  });

  it('tapping the Plex chip calls onPlexToggle → toggleHasPlex', async () => {
    const { el, service, fixture } = await setup(true);
    expandProviders(fixture, el);
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
        { provide: PlexBackgroundService, useValue: mockPlexBackground() },
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

  // ── Background sync controls (spec 0085) ─────────────────────────────────

  it('connected: renders the "Sync in background" toggle reflecting enabled()', async () => {
    const bg = mockPlexBackground(true, 60);
    const { el } = await setupWithService(mockService(true), {
      plexLinked: true,
      plexBackground: bg,
    });
    const toggle = el.querySelectorAll(
      '.plex-connected__background .settings-row__toggle',
    )[0] as HTMLElement & { checked: boolean };
    expect(toggle).toBeTruthy();
    // EXACT rendered string (single .trim() only — no whitespace collapse).
    expect(toggle.textContent?.trim()).toBe('Sync in background');
    expect(toggle.checked).toBe(true);
  });

  it('connected: the "Sync in background" toggle reflects enabled()=false', async () => {
    const bg = mockPlexBackground(false, 60);
    const { el } = await setupWithService(mockService(true), {
      plexLinked: true,
      plexBackground: bg,
    });
    const toggle = el.querySelectorAll(
      '.plex-connected__background .settings-row__toggle',
    )[0] as HTMLElement & { checked: boolean };
    expect(toggle.checked).toBe(false);
  });

  it('connected: renders the EXACT background-sync helper caption', async () => {
    const { el } = await setupWithService(mockService(true), {
      plexLinked: true,
    });
    const helper = el.querySelector(
      '.plex-connected__background .settings-row__helper',
    );
    expect(helper?.textContent?.trim()).toBe(
      'Periodically sync your Plex library while on Wi-Fi. Android only.',
    );
  });

  it('connected: toggling "Sync in background" calls setEnabled with the new value', async () => {
    const bg = mockPlexBackground(true);
    const { el } = await setupWithService(mockService(true), {
      plexLinked: true,
      plexBackground: bg,
    });
    const toggle = el.querySelector(
      '.plex-connected__background .settings-row__toggle',
    );
    toggle?.dispatchEvent(
      new CustomEvent('ionChange', { detail: { checked: false } }),
    );
    expect(bg.setEnabled).toHaveBeenCalledWith(false);
  });

  it('connected: renders the interval select with the current value + EXACT option labels', async () => {
    const bg = mockPlexBackground(true, 180);
    const { el } = await setupWithService(mockService(true), {
      plexLinked: true,
      plexBackground: bg,
    });
    const select = el.querySelectorAll(
      '.plex-connected__background .settings-row__select',
    )[0] as HTMLElement & { value: number };
    expect(select).toBeTruthy();
    expect(select.getAttribute('label')).toBe('Sync frequency');
    expect(select.value).toBe(180);
    const labels = Array.from(select.querySelectorAll('ion-select-option')).map(
      (o) => o.textContent?.trim(),
    );
    expect(labels).toEqual([
      'Every 15 minutes',
      'Every 30 minutes',
      'Every hour',
      'Every 3 hours',
      'Every 6 hours',
    ]);
  });

  it('connected: renders the EXACT interval helper caption', async () => {
    const { el } = await setupWithService(mockService(true), {
      plexLinked: true,
    });
    const helpers = el.querySelectorAll(
      '.plex-connected__background .settings-row__helper',
    );
    expect(helpers[1]?.textContent?.trim()).toBe(
      'How often to check Plex in the background (minimum 15 minutes).',
    );
  });

  it('connected: interval select is disabled when the background toggle is OFF', async () => {
    const bg = mockPlexBackground(false, 60);
    const { el } = await setupWithService(mockService(true), {
      plexLinked: true,
      plexBackground: bg,
    });
    const select = el.querySelectorAll(
      '.plex-connected__background .settings-row__select',
    )[0] as HTMLElement & { disabled: boolean };
    expect(select.disabled).toBe(true);
  });

  it('connected: interval select is enabled when the background toggle is ON', async () => {
    const bg = mockPlexBackground(true, 60);
    const { el } = await setupWithService(mockService(true), {
      plexLinked: true,
      plexBackground: bg,
    });
    const select = el.querySelectorAll(
      '.plex-connected__background .settings-row__select',
    )[0] as HTMLElement & { disabled: boolean };
    expect(select.disabled).toBe(false);
  });

  it('connected: changing the interval select calls setIntervalMinutes with the numeric value', async () => {
    const bg = mockPlexBackground(true, 60);
    const { el } = await setupWithService(mockService(true), {
      plexLinked: true,
      plexBackground: bg,
    });
    const select = el.querySelector(
      '.plex-connected__background .settings-row__select',
    );
    select?.dispatchEvent(
      new CustomEvent('ionChange', { detail: { value: 180 } }),
    );
    expect(bg.setIntervalMinutes).toHaveBeenCalledWith(180);
  });

  // ── Sync toast wording (spec 0097) ───────────────────────────────────────
  // The four `ok` branches, asserted as EXACT strings (no whitespace-collapse).

  async function setupConnectedToast(summary: {
    added: number;
    updated: number;
    skipped: number;
    unmatched: number;
  }) {
    const service = mockService(true);
    const link = mockPlexLink(true);
    const plexSync: MockPlexSync = {
      running: signal<boolean>(false),
      sync: vi.fn().mockResolvedValue({ status: 'ok', summary }),
    };
    const toastPresent = vi.fn().mockResolvedValue(undefined);
    const toastController = {
      create: vi.fn().mockResolvedValue({ present: toastPresent }),
    };
    await TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [
        provideIonicAngular(),
        { provide: SettingsService, useValue: service },
        { provide: PlexLinkService, useValue: link },
        { provide: PlexSyncService, useValue: plexSync },
        { provide: PlexBackgroundService, useValue: mockPlexBackground() },
        { provide: Router, useValue: { navigate: vi.fn() } },
        {
          provide: AlertController,
          useValue: { create: vi.fn().mockResolvedValue({ present: vi.fn() }) },
        },
        { provide: ToastController, useValue: toastController },
      ],
    })
      .overrideComponent(SettingsPage, { set: { providers: [] } })
      .compileComponents();
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    return { el, toastController };
  }

  /** Click "Sync now" and flush the async syncPlexNow() → toast chain. */
  async function syncAndReadToastMessage(
    el: HTMLElement,
    toastController: { create: ReturnType<typeof vi.fn> },
  ): Promise<string> {
    (
      el.querySelectorAll('.plex-text-button--primary')[0] as HTMLElement
    ).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toastController.create).toHaveBeenCalledTimes(1);
    return (toastController.create.mock.calls[0][0] as { message: string })
      .message;
  }

  it('toast: added+updated>0 and unmatched=0 → "N added, M updated"', async () => {
    const { el, toastController } = await setupConnectedToast({
      added: 2,
      updated: 1,
      skipped: 0,
      unmatched: 0,
    });
    expect(await syncAndReadToastMessage(el, toastController)).toBe(
      'Plex sync complete — 2 added, 1 updated',
    );
  });

  it("toast: added+updated>0 and unmatched>0 → appends the couldn't-be-matched count", async () => {
    const { el, toastController } = await setupConnectedToast({
      added: 2,
      updated: 1,
      skipped: 0,
      unmatched: 3,
    });
    expect(await syncAndReadToastMessage(el, toastController)).toBe(
      "Plex sync complete — 2 added, 1 updated, 3 couldn't be matched",
    );
  });

  it("toast: added+updated=0 and unmatched>0 → couldn't-be-matched only", async () => {
    const { el, toastController } = await setupConnectedToast({
      added: 0,
      updated: 0,
      skipped: 0,
      unmatched: 5,
    });
    expect(await syncAndReadToastMessage(el, toastController)).toBe(
      "Plex sync complete — 5 couldn't be matched",
    );
  });

  it('toast: added+updated=0 and unmatched=0 → "already up to date"', async () => {
    const { el, toastController } = await setupConnectedToast({
      added: 0,
      updated: 0,
      skipped: 0,
      unmatched: 0,
    });
    expect(await syncAndReadToastMessage(el, toastController)).toBe(
      'Plex sync complete — already up to date',
    );
  });

  // ── Unmatched-titles list (spec 0097) ────────────────────────────────────

  it('connected: renders the unmatched list heading + rows with EXACT reason labels (2 entries)', async () => {
    const { el, fixture, plexLink } = await setupWithService(
      mockService(true),
      {
        plexLinked: true,
      },
    );
    plexLink.unmatched.set([
      { title: 'Lucky', reason: 'guid-unresolved' },
      { title: 'Home Movie 2019', reason: 'no-guid' },
    ]);
    fixture.detectChanges();

    const block = el.querySelector('.plex-unmatched');
    expect(block).toBeTruthy();
    expect(
      block?.querySelector('.settings-row__helper')?.textContent?.trim(),
    ).toBe("Couldn't match 2 titles");
    const rows = block?.querySelectorAll('.plex-unmatched__row') ?? [];
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector('.plex-unmatched__title')?.textContent).toBe(
      'Lucky',
    );
    expect(rows[0].querySelector('.plex-unmatched__reason')?.textContent).toBe(
      'No TMDB match',
    );
    expect(rows[1].querySelector('.plex-unmatched__title')?.textContent).toBe(
      'Home Movie 2019',
    );
    expect(rows[1].querySelector('.plex-unmatched__reason')?.textContent).toBe(
      'Not identified',
    );
  });

  it('connected: SINGULAR heading "Couldn\'t match 1 title" + "Sync error" label for a 1-entry fixture', async () => {
    const { el, fixture, plexLink } = await setupWithService(
      mockService(true),
      {
        plexLinked: true,
      },
    );
    plexLink.unmatched.set([{ title: 'Solo', reason: 'error' }]);
    fixture.detectChanges();

    const block = el.querySelector('.plex-unmatched');
    expect(
      block?.querySelector('.settings-row__helper')?.textContent?.trim(),
    ).toBe("Couldn't match 1 title");
    expect(block?.querySelector('.plex-unmatched__reason')?.textContent).toBe(
      'Sync error',
    );
  });

  it('connected: the unmatched list is HIDDEN (element absent) when unmatched() is empty', async () => {
    const { el, plexLink } = await setupWithService(mockService(true), {
      plexLinked: true,
    });
    expect(plexLink.unmatched().length).toBe(0);
    expect(el.querySelector('.plex-unmatched')).toBeFalsy();
  });
});
