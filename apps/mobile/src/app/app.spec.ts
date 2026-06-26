import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { StatusBar } from '@capacitor/status-bar';
import { App } from './app';

vi.mock('@capacitor/status-bar', () => ({
  StatusBar: { setOverlaysWebView: vi.fn(), setStyle: vi.fn() },
  Style: { Dark: 'DARK' },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn().mockReturnValue(false) },
}));

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideIonicAngular(), provideRouter([])],
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
});
