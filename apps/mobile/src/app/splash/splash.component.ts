import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { filter, take } from 'rxjs/operators';
import { Capacitor } from '@capacitor/core';
import { SplashScreen } from '@capacitor/splash-screen';

/**
 * Animated web splash overlay — Stitch "Splash Screen - Vultus"
 * (projects/13590348714018893783, screen c0a785aff1d54cd59bd41a5fd5f10d3d).
 *
 * The native Capacitor splash (same #0b1326 surface) stays up until this
 * overlay renders (capacitor.config.ts sets launchAutoHide: false), so the
 * handoff native → web is invisible. The overlay then plays the Stitch boot
 * animations and exits with the 800ms scale+fade once the app is ready.
 */

/** Status lines cycled under the progress bar — verbatim from the Stitch screen. */
const STATUS_MESSAGES = [
  'Syncing watchlist...',
  'Loading cinematic assets...',
  'Checking for updates...',
  'Calibrating lens...',
  'Readying the theater...',
];

/** First status line shown before the cycle starts (Stitch initial DOM text). */
const INITIAL_STATUS = 'Initializing library...';

/** Cycle cadence + fade — the Stitch script swaps every 3s with a 700ms fade. */
const STATUS_CYCLE_MS = 3000;
const STATUS_FADE_MS = 700;

/** Keep the splash up for at least one full progress sweep (2.5s animation). */
const MIN_DISPLAY_MS = 2500;

/** Exit transition length — Stitch's 0.8s scale+fade on app entry. */
const EXIT_MS = 800;

/** Hard cap: dismiss even if the first navigation never settles. */
const MAX_WAIT_MS = 8000;

@Component({
  selector: 'app-splash',
  templateUrl: './splash.component.html',
  styleUrl: './splash.component.scss',
})
export class SplashComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly hidden = signal(false);
  protected readonly exiting = signal(false);
  protected readonly statusText = signal(INITIAL_STATUS);
  protected readonly statusVisible = signal(true);

  private cycleTimer?: ReturnType<typeof setInterval>;
  private swapTimer?: ReturnType<typeof setTimeout>;
  private exitTimer?: ReturnType<typeof setTimeout>;

  ngOnInit(): void {
    // The overlay is painted — drop the native splash behind it (native-only;
    // fire-and-forget, ngOnInit must return void).
    void this.hideNativeSplash();
    this.cycleStatusMessages();
    this.scheduleDismissal();
    this.destroyRef.onDestroy(() => {
      clearInterval(this.cycleTimer);
      clearTimeout(this.swapTimer);
      clearTimeout(this.exitTimer);
    });
  }

  private async hideNativeSplash(): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    await SplashScreen.hide();
  }

  private cycleStatusMessages(): void {
    let index = 0;
    this.cycleTimer = setInterval(() => {
      if (this.exiting()) {
        clearInterval(this.cycleTimer);
        return;
      }
      this.statusVisible.set(false);
      this.swapTimer = setTimeout(() => {
        index = (index + 1) % STATUS_MESSAGES.length;
        this.statusText.set(STATUS_MESSAGES[index]);
        this.statusVisible.set(true);
      }, STATUS_FADE_MS);
    }, STATUS_CYCLE_MS);
  }

  private scheduleDismissal(): void {
    const minDisplay = new Promise<void>((resolve) =>
      setTimeout(resolve, MIN_DISPLAY_MS),
    );
    // App "ready" = the first router navigation has settled (the boot
    // initializer has resolved auth by then, and a guard redirect chain still
    // ends in exactly one NavigationEnd).
    const firstNavigation = this.router.navigated
      ? Promise.resolve()
      : firstValueFrom(
          this.router.events.pipe(
            filter(
              (event): event is NavigationEnd => event instanceof NavigationEnd,
            ),
            take(1),
          ),
        ).then(() => undefined);
    const maxWait = new Promise<void>((resolve) =>
      setTimeout(resolve, MAX_WAIT_MS),
    );
    void Promise.race([
      Promise.all([minDisplay, firstNavigation]),
      maxWait,
    ]).then(() => this.dismiss());
  }

  private dismiss(): void {
    if (this.exiting()) {
      return;
    }
    this.exiting.set(true);
    this.exitTimer = setTimeout(() => this.hidden.set(true), EXIT_MS);
  }
}
