import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { StatusBar } from '@capacitor/status-bar';
import { App } from './app';
import { NotificationHandlerService } from './notification-handler.service';

vi.mock('@capacitor/status-bar', () => ({
  StatusBar: { setOverlaysWebView: vi.fn(), setStyle: vi.fn() },
  Style: { Dark: 'DARK' },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn().mockReturnValue(false) },
}));

// App now imports NotificationHandlerService, whose module pulls in
// @angular/fire/firestore (→ rxfire, an ESM-in-CJS package Vitest can't load)
// and @capacitor/push-notifications. Stub both so the App module graph loads
// without a real Firestore/native runtime. The service itself is replaced by a
// mock provider below, so these stubs only need to satisfy the import graph.
vi.mock('@angular/fire/firestore', () => ({
  Firestore: class Firestore {},
  doc: vi.fn(),
  updateDoc: vi.fn(),
  Timestamp: { now: vi.fn() },
}));
vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: { addListener: vi.fn() },
}));

// The shell wires NotificationHandlerService.init() from ngOnInit. The real
// service is providedIn:'root' and pulls in Firestore/Router/ToastController/
// AUTH_UID, which the App TestBed does not provide — supply a mock so DI
// resolves and we can assert init() fires. (init() is exercised in full in
// notification-handler.service.spec.ts.)
const notificationInit = vi.fn().mockResolvedValue(undefined);

describe('App', () => {
  beforeEach(async () => {
    notificationInit.mockClear();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideIonicAngular(),
        provideRouter([]),
        {
          provide: NotificationHandlerService,
          useValue: { init: notificationInit },
        },
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
});
