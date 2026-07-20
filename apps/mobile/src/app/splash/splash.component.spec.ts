import { TestBed } from '@angular/core/testing';
import { NavigationEnd, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { Capacitor } from '@capacitor/core';
import { SplashScreen } from '@capacitor/splash-screen';
import { SplashComponent } from './splash.component';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn().mockReturnValue(false) },
}));

vi.mock('@capacitor/splash-screen', () => ({
  SplashScreen: { hide: vi.fn().mockResolvedValue(undefined) },
}));

describe('SplashComponent', () => {
  let routerEvents: Subject<unknown>;
  let routerStub: { navigated: boolean; events: Subject<unknown> };

  const createFixture = () => {
    const fixture = TestBed.createComponent(SplashComponent);
    fixture.detectChanges(); // triggers ngOnInit
    return fixture;
  };

  const emitNavigationEnd = () => {
    routerEvents.next(new NavigationEnd(1, '/', '/tabs/today'));
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    // The vi.mock above replaces hide with a vi.fn() spy — not a real unbound
    // method, so clearing it by reference is safe (same idiom as app.spec.ts).
    /* eslint-disable-next-line @typescript-eslint/unbound-method */
    vi.mocked(SplashScreen.hide).mockClear();
    routerEvents = new Subject();
    routerStub = { navigated: false, events: routerEvents };
    await TestBed.configureTestingModule({
      imports: [SplashComponent],
      providers: [{ provide: Router, useValue: routerStub }],
    }).compileComponents();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the brand, tagline, and initial status line', () => {
    const fixture = createFixture();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.splash__title')?.textContent?.trim()).toBe(
      'Vultus',
    );
    expect(el.querySelector('.splash__tagline')?.textContent?.trim()).toBe(
      'High Fidelity Media Tracking',
    );
    expect(el.querySelector('.splash__status')?.textContent?.trim()).toBe(
      'Initializing library...',
    );
    // The flickering letter is the "u" (Stitch: V<span>u</span>ltus).
    expect(el.querySelector('.splash__flicker')?.textContent).toBe('u');
  });

  it('does not touch the native SplashScreen bridge off-native', () => {
    createFixture();
    /* eslint-disable-next-line @typescript-eslint/unbound-method */
    expect(SplashScreen.hide).not.toHaveBeenCalled();
  });

  it('hides the native splash on init when running natively', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    createFixture();
    /* eslint-disable-next-line @typescript-eslint/unbound-method */
    expect(SplashScreen.hide).toHaveBeenCalledTimes(1);
  });

  it('cycles the status messages every 3s with a 700ms fade', async () => {
    const fixture = createFixture();
    const el = fixture.nativeElement as HTMLElement;
    const status = () => el.querySelector('.splash__status');

    await vi.advanceTimersByTimeAsync(3000);
    fixture.detectChanges();
    // Mid-fade: text still the old one, faded out.
    expect(status()?.classList.contains('splash__status--faded')).toBe(true);

    await vi.advanceTimersByTimeAsync(700);
    fixture.detectChanges();
    expect(status()?.textContent?.trim()).toBe('Loading cinematic assets...');
    expect(status()?.classList.contains('splash__status--faded')).toBe(false);
  });

  it('stays up past the minimum display until the first navigation ends', async () => {
    const fixture = createFixture();
    const el = fixture.nativeElement as HTMLElement;

    await vi.advanceTimersByTimeAsync(2500);
    fixture.detectChanges();
    expect(el.querySelector('.splash--exiting')).toBeNull();

    emitNavigationEnd();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(el.querySelector('.splash--exiting')).not.toBeNull();

    // Exit transition (800ms) ends → overlay leaves the DOM entirely.
    await vi.advanceTimersByTimeAsync(800);
    fixture.detectChanges();
    expect(el.querySelector('.splash')).toBeNull();
  });

  it('waits for the minimum display even when navigation is already done', async () => {
    routerStub.navigated = true;
    const fixture = createFixture();
    const el = fixture.nativeElement as HTMLElement;

    await vi.advanceTimersByTimeAsync(2400);
    fixture.detectChanges();
    expect(el.querySelector('.splash--exiting')).toBeNull();

    await vi.advanceTimersByTimeAsync(100);
    fixture.detectChanges();
    expect(el.querySelector('.splash--exiting')).not.toBeNull();
  });

  it('dismisses at the hard cap when no navigation ever settles', async () => {
    const fixture = createFixture();
    const el = fixture.nativeElement as HTMLElement;

    await vi.advanceTimersByTimeAsync(8000);
    fixture.detectChanges();
    expect(el.querySelector('.splash--exiting')).not.toBeNull();
  });
});
