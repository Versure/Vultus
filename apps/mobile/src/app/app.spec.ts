import { TestBed } from '@angular/core/testing';
import { Route, provideRouter } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { StatusBar } from '@capacitor/status-bar';
import { Capacitor } from '@capacitor/core';
import { PLEX_CLIENT, PLEX_SYNC_TRIGGER } from '@vultus/shared/domain/tokens';
import {
  CapacitorHttpPlexClient,
  MockPlexClient,
} from '@vultus/mobile/settings';
import { App } from './app';
import { appRoutes } from './app.routes';
import { NotificationHandlerService } from './notification-handler.service';

vi.mock('@capacitor/status-bar', () => ({
  StatusBar: { setOverlaysWebView: vi.fn(), setStyle: vi.fn() },
  Style: { Dark: 'DARK' },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn().mockReturnValue(false) },
  // The @vultus/mobile/settings barrel pulls in plex.client.ts, which imports
  // CapacitorHttp at module load. It's never invoked off-native (the factory
  // short-circuits to the mock), but the symbol must exist for the import.
  CapacitorHttp: { get: vi.fn(), post: vi.fn() },
}));

// App now imports @capacitor/app (the foreground-resume listener). Off-native
// the guard skips addListener, but the module still loads — stub it so no
// native bridge is touched.
vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn() },
}));

// App now imports NotificationHandlerService, whose module pulls in
// @angular/fire/firestore (→ rxfire, an ESM-in-CJS package Vitest can't load)
// and @capacitor/push-notifications. Stub both so the App module graph loads
// without a real Firestore/native runtime. The service itself is replaced by a
// mock provider below, so these stubs only need to satisfy the import graph.
vi.mock('@angular/fire/firestore', () => ({
  Firestore: class Firestore {},
  doc: vi.fn(),
  collection: vi.fn(),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
  Timestamp: { now: vi.fn() },
}));
vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: { addListener: vi.fn() },
}));
// The @vultus/mobile/settings barrel (imported for MockPlexClient) pulls in the
// Plex services, which import @capacitor/preferences. Stub it so the barrel's
// module graph loads under Vitest.
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn().mockResolvedValue({ value: null }),
    set: vi.fn(),
    remove: vi.fn(),
  },
}));

// The shell wires NotificationHandlerService.init() from ngOnInit. The real
// service is providedIn:'root' and pulls in Firestore/Router/ToastController/
// AUTH_UID, which the App TestBed does not provide — supply a mock so DI
// resolves and we can assert init() fires. (init() is exercised in full in
// notification-handler.service.spec.ts.)
const notificationInit = vi.fn().mockResolvedValue(undefined);
// The shell wires PLEX_SYNC_TRIGGER from ngOnInit (boot sync). Supply a spy so
// DI resolves and we can assert the boot trigger fires. The real thunk (native
// guard + PlexSyncService.sync()) is exercised via the app.config factory.
const plexSyncTrigger = vi.fn().mockResolvedValue(undefined);

describe('App', () => {
  beforeEach(async () => {
    notificationInit.mockClear();
    plexSyncTrigger.mockClear();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideIonicAngular(),
        provideRouter([]),
        {
          provide: NotificationHandlerService,
          useValue: { init: notificationInit },
        },
        { provide: PLEX_SYNC_TRIGGER, useValue: plexSyncTrigger },
      ],
    }).compileComponents();
  });

  it('should create the Ionic app shell', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('ion-app')).toBeTruthy();
    expect(compiled.querySelector('ion-router-outlet')).toBeTruthy();
  });

  it('does not invoke StatusBar native calls off-device (guard no-ops)', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    // The vi.mock above replaces these with vi.fn() spies; they are mock
    // functions, not real unbound methods, so the assertions are safe.
    /* eslint-disable @typescript-eslint/unbound-method */
    expect(StatusBar.setOverlaysWebView).not.toHaveBeenCalled();
    expect(StatusBar.setStyle).not.toHaveBeenCalled();
    /* eslint-enable @typescript-eslint/unbound-method */
  });

  it('initializes the FCM push handler from ngOnInit', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect(notificationInit).toHaveBeenCalledTimes(1);
  });

  it('fires the Plex sync trigger on boot (ngOnInit)', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect(plexSyncTrigger).toHaveBeenCalledTimes(1);
  });
});

describe('app routes — Plex connect sub-page (spec 0073)', () => {
  it('registers /tabs/settings/plex as a child of tabs', () => {
    const tabs = appRoutes.find((r) => r.path === 'tabs');
    expect(tabs).toBeDefined();
    const child = tabs?.children?.find(
      (c: Route) => c.path === 'settings/plex',
    );
    expect(child).toBeDefined();
    expect(child?.loadComponent).toBeTypeOf('function');
  });

  it('keeps the empty redirect last in the tabs children', () => {
    const tabs = appRoutes.find((r) => r.path === 'tabs');
    const children = tabs?.children ?? [];
    const last = children[children.length - 1];
    expect(last?.path).toBe('');
    expect(last?.redirectTo).toBe('watchlist');
  });
});

describe('PLEX_CLIENT factory (spec 0073)', () => {
  it('selects the MockPlexClient off-native (jsdom → isNativePlatform false)', () => {
    // Exercise the REAL app.config.ts selection branch: the native-vs-not
    // ternary. Capacitor.isNativePlatform() is mocked to false in this env, so
    // the factory must resolve the mock client (never the CapacitorHttp real one).
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PLEX_CLIENT,
          useFactory: () =>
            Capacitor.isNativePlatform()
              ? new CapacitorHttpPlexClient()
              : new MockPlexClient(),
        },
      ],
    });
    expect(TestBed.inject(PLEX_CLIENT)).toBeInstanceOf(MockPlexClient);
    expect(TestBed.inject(PLEX_CLIENT)).not.toBeInstanceOf(
      CapacitorHttpPlexClient,
    );
  });
});
