import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavController, provideIonicAngular } from '@ionic/angular/standalone';
import type { PlexServer } from '@vultus/shared/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the two data-access service modules so the page test never pulls in the
// real `@angular/fire/firestore` / `@capacitor/*` import chains.
vi.mock('./plex-link.service', () => ({
  PlexLinkService: class PlexLinkService {},
}));
vi.mock('./plex-sync.service', () => ({
  PlexSyncService: class PlexSyncService {},
}));
vi.mock('./plex-background.service', () => ({
  PlexBackgroundService: class PlexBackgroundService {},
}));
// Mock @capacitor/browser so the "Open plex.tv/link" button never opens a real
// tab under test; we assert the page called Browser.open with the fixed URL.
// The factory delegates to a standalone `vi.fn()` (house style, mirrors
// plex-background.service.spec.ts) so assertions reference a plain function
// rather than the `Browser.open` method (avoids @typescript-eslint/unbound-method).
const browserOpenMock = vi
  .fn<(opts: { url: string }) => Promise<void>>()
  .mockResolvedValue(undefined);
vi.mock('@capacitor/browser', () => ({
  Browser: {
    open: (opts: { url: string }): Promise<void> => browserOpenMock(opts),
  },
}));

import { PlexConnectPage } from './plex-connect.page';
import { PlexLinkService } from './plex-link.service';
import { PlexSyncService } from './plex-sync.service';
import { PlexBackgroundService } from './plex-background.service';

type Stage = 'idle' | 'code' | 'waiting' | 'connected' | 'error';
type ErrorReason = 'expired' | 'no-server' | 'network' | null;

interface MockLink {
  stage: WritableSignal<Stage>;
  errorReason: WritableSignal<ErrorReason>;
  code: WritableSignal<string | null>;
  server: WritableSignal<PlexServer | null>;
  expiresInSeconds: WritableSignal<number>;
  countdown: WritableSignal<string>;
  requestCode: ReturnType<typeof vi.fn>;
  regenerateCode: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
}

interface MockSync {
  running: WritableSignal<boolean>;
  sync: ReturnType<typeof vi.fn>;
}

function mockLink(stage: Stage, errorReason: ErrorReason = null): MockLink {
  return {
    stage: signal<Stage>(stage),
    errorReason: signal<ErrorReason>(errorReason),
    code: signal<string | null>('H7X2'),
    server: signal<PlexServer | null>({
      name: 'Vultus Media Server',
      baseUrl: 'http://192.168.1.20:32400',
      accessToken: 't',
    }),
    expiresInSeconds: signal<number>(14 * 60 + 32),
    countdown: signal<string>('14:32'),
    requestCode: vi.fn().mockResolvedValue(undefined),
    regenerateCode: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
  };
}

function mockSync(): MockSync {
  return {
    running: signal<boolean>(false),
    sync: vi.fn().mockResolvedValue({ added: 0, updated: 0, skipped: 0 }),
  };
}

async function setup(stage: Stage, errorReason: ErrorReason = null) {
  const link = mockLink(stage, errorReason);
  const sync = mockSync();
  const background = { init: vi.fn().mockResolvedValue(undefined) };
  const nav = { navigateBack: vi.fn() };
  await TestBed.configureTestingModule({
    imports: [PlexConnectPage],
    providers: [
      provideIonicAngular(),
      { provide: PlexLinkService, useValue: link },
      { provide: PlexSyncService, useValue: sync },
      { provide: PlexBackgroundService, useValue: background },
      { provide: NavController, useValue: nav },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(PlexConnectPage);
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, link, sync, background, nav };
}

describe('PlexConnectPage', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    browserOpenMock.mockClear();
    // jsdom has no `navigator.clipboard` — stub the WEB Clipboard API the page
    // uses (navigator.clipboard.writeText), fresh per test.
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  it('renders the fixed header with the "Connect Plex" title and a back button', async () => {
    const { el } = await setup('code');
    expect(el.querySelector('ion-title')?.textContent).toContain(
      'Connect Plex',
    );
    expect(el.querySelector('.back-button')).toBeTruthy();
    // No bottom nav on this pushed sub-page.
    expect(el.querySelector('ion-tab-bar')).toBeFalsy();
  });

  it('kicks the link flow on init when idle', async () => {
    const { link } = await setup('idle');
    expect(link.requestCode).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-kick the link flow when entering mid-flow (code stage)', async () => {
    const { link } = await setup('code');
    expect(link.requestCode).not.toHaveBeenCalled();
  });

  it('stage "code": renders the code, the countdown, and "Get a new code"', async () => {
    const { el } = await setup('code');
    expect(el.querySelector('.code-value')?.textContent).toContain('H7X2');
    expect(
      el.querySelector('[data-test="code-countdown"]')?.textContent?.trim(),
    ).toBe('Code expires in 14:32');
    const solid = el.querySelector('.solid-button');
    expect(solid?.textContent?.trim()).toBe('Get a new code');
  });

  it('tapping "Get a new code" calls regenerateCode()', async () => {
    const { el, link } = await setup('code');
    (el.querySelectorAll('.solid-button')[0] as HTMLElement).click();
    expect(link.regenerateCode).toHaveBeenCalledTimes(1);
  });

  it('stage "code": tapping copy writes the code and shows "Copied" feedback', async () => {
    const { el, fixture } = await setup('code');
    expect(el.querySelector('[data-test="copied-feedback"]')).toBeFalsy();

    (el.querySelectorAll('.copy-button')[0] as HTMLElement).click();
    // Let the async writeText resolve, then flush the resulting signal update.
    await fixture.whenStable();
    fixture.detectChanges();

    expect(writeText).toHaveBeenCalledWith('H7X2');
    expect(
      el.querySelector('[data-test="copied-feedback"]')?.textContent?.trim(),
    ).toBe('Copied');
  });

  it('stage "code": renders "Open plex.tv/link" and opens the URL on tap', async () => {
    const { el } = await setup('code');
    const open = el.querySelector('[data-test="open-plex-link"]');
    expect(open?.textContent?.trim()).toBe('Open plex.tv/link');

    (open as HTMLElement).click();
    expect(browserOpenMock).toHaveBeenCalledTimes(1);
    expect(browserOpenMock).toHaveBeenCalledWith({
      url: 'https://plex.tv/link',
    });
  });

  it('"Open plex.tv/link" is present in the code/waiting stage only', async () => {
    for (const stage of ['code', 'waiting'] as const) {
      const { el } = await setup(stage);
      expect(el.querySelector('[data-test="open-plex-link"]')).toBeTruthy();
      TestBed.resetTestingModule();
    }
    for (const [stage, reason] of [
      ['idle', null],
      ['connected', null],
      ['error', 'expired'],
    ] as const) {
      const { el } = await setup(stage, reason);
      expect(el.querySelector('[data-test="open-plex-link"]')).toBeFalsy();
      TestBed.resetTestingModule();
    }
  });

  it('stage "waiting": renders "Waiting for authorization…" and "Cancel"', async () => {
    const { el } = await setup('waiting');
    expect(el.querySelector('.waiting-label')?.textContent).toBe(
      'Waiting for authorization…',
    );
    const cancel = el.querySelector('.text-button-muted');
    expect(cancel?.textContent?.trim()).toBe('Cancel');
  });

  it('tapping "Cancel" calls cancel() and navigates back', async () => {
    const { el, link, nav } = await setup('waiting');
    (el.querySelectorAll('.text-button-muted')[0] as HTMLElement).click();
    expect(link.cancel).toHaveBeenCalledTimes(1);
    expect(nav.navigateBack).toHaveBeenCalledWith('/tabs/settings');
  });

  it('stage "connected": renders "Connected to Plex", the server row, and "Done"', async () => {
    const { el } = await setup('connected');
    expect(el.querySelector('.connected-heading')?.textContent).toBe(
      'Connected to Plex',
    );
    const serverRow = el.querySelector('[data-test="server-row"]');
    expect(
      serverRow?.querySelector('.server-row__name')?.textContent,
    ).toContain('Vultus Media Server');
    expect(
      serverRow?.querySelector('.server-row__caption')?.textContent,
    ).toContain('Local network · http://192.168.1.20:32400');
    const solid = el.querySelector('.solid-button');
    expect(solid?.textContent?.trim()).toBe('Done');
  });

  it('tapping "Done" triggers a sync and navigates back', async () => {
    const { el, sync, nav } = await setup('connected');
    (el.querySelectorAll('.solid-button')[0] as HTMLElement).click();
    expect(sync.sync).toHaveBeenCalledTimes(1);
    expect(nav.navigateBack).toHaveBeenCalledWith('/tabs/settings');
  });

  it('tapping "Done" initializes background sync (spec 0085)', async () => {
    const { el, background } = await setup('connected');
    (el.querySelectorAll('.solid-button')[0] as HTMLElement).click();
    expect(background.init).toHaveBeenCalledTimes(1);
  });

  it('stage "error" reason "expired": renders the expired copy + "Try again"', async () => {
    const { el } = await setup('error', 'expired');
    expect(el.querySelector('[data-test="stage-error"]')).toBeTruthy();
    // The old flat "Code expired" code line is gone; error is its own card.
    expect(el.querySelector('[data-test="code-countdown"]')).toBeFalsy();
    expect(
      el.querySelector('[data-test="error-heading"]')?.textContent?.trim(),
    ).toBe('Code expired');
    expect(
      el.querySelector('[data-test="error-detail"]')?.textContent,
    ).toContain('plex.tv/link');
    expect(el.querySelector('.solid-button')?.textContent?.trim()).toBe(
      'Try again',
    );
  });

  it('stage "error" reason "no-server": renders the distinct no-server copy (NOT expired)', async () => {
    const { el } = await setup('error', 'no-server');
    expect(
      el.querySelector('[data-test="error-heading"]')?.textContent?.trim(),
    ).toBe('No local server found');
    expect(
      el.querySelector('[data-test="error-detail"]')?.textContent,
    ).toContain('Plex account');
  });

  it('stage "error" reason "network": renders the distinct network copy', async () => {
    const { el } = await setup('error', 'network');
    expect(
      el.querySelector('[data-test="error-heading"]')?.textContent?.trim(),
    ).toBe("Couldn't reach Plex");
  });

  it('tapping "Try again" from the error stage regenerates the code', async () => {
    const { el, link } = await setup('error', 'no-server');
    (el.querySelectorAll('.solid-button')[0] as HTMLElement).click();
    expect(link.regenerateCode).toHaveBeenCalledTimes(1);
  });

  it('transitions follow PlexLinkService.stage (code → waiting → connected)', async () => {
    const { el, fixture, link } = await setup('code');
    expect(el.querySelector('[data-test="stage-code"]')).toBeTruthy();
    expect(el.querySelector('[data-test="stage-connected"]')).toBeFalsy();

    link.stage.set('waiting');
    fixture.detectChanges();
    expect(el.querySelector('[data-test="stage-waiting"]')).toBeTruthy();

    link.stage.set('connected');
    fixture.detectChanges();
    expect(el.querySelector('[data-test="stage-connected"]')).toBeTruthy();
    expect(el.querySelector('[data-test="stage-code"]')).toBeFalsy();
  });
});
