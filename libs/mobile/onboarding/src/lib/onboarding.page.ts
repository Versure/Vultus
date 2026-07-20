import { Component, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonButton,
  IonContent,
  IonIcon,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonToggle,
} from '@ionic/angular/standalone';
import {
  regionDisplayName,
  type CatalogProvider,
  type Region,
} from '@vultus/shared/domain';
import { addIcons } from 'ionicons';
import { alertCircle, checkmarkCircle, shieldCheckmark } from 'ionicons/icons';
import { OnboardingPlexLinkService } from './onboarding-plex-link.service';
import { ONBOARDING_PROVIDERS } from './onboarding.providers';
import { OnboardingService } from './onboarding.service';

// TMDB logo path base for provider chips. `logoPath` on `CatalogProvider` is a
// bare TMDB path (e.g. `/abc.jpg`); w92 is the smallest TMDB logo size, ample
// for a ~48px chip tile. Slice-local copy of the same base the Settings slice
// uses — NOT imported cross-slice (spec 0078 decision 5, 2 slices < 3+).
const TMDB_LOGO_BASE = 'https://image.tmdb.org/t/p/w92';

/**
 * First-launch onboarding page (spec 0078; reworks spec 0022 into a wizard).
 *
 * A SINGLE Angular route (`/onboarding`, same guard, same barrel exports) that
 * renders ONE of five ordered steps from `OnboardingService.currentStep()` —
 * NO new Angular routes:
 *
 *   1. Region → 2. My Providers → 3. Notifications → 4. Plex link → 5. Finish
 *
 * Each step persists WRITE-AS-YOU-GO through `OnboardingService`
 * (`users/{uid}`), so "Back" (steps 2-5) simply moves the step signal with the
 * prior value still shown. Step 4 injects the onboarding-owned
 * `OnboardingPlexLinkService` (its own class — NOT the `slice:settings`
 * `PlexLinkService`); it starts in `idle` with a user-initiated "Connect Plex"
 * button and renders one of its stages once started, and it carries a
 * "Skip for now" affordance (present in every non-connected stage) that stops
 * the poll and advances without any `hasPlex`/`plexSync` write.
 *
 * DESIGN: step CONTENT is aligned to the in-repo Settings / Connect-Plex markup
 * (already Stitch-aligned — My Providers `cebdfd02c7d44023b0e0019dd4907d48`,
 * notification controls `81945ff3381e453dafcc4e5ce896fcfa`, Connect Plex
 * `398cde766832491e92e1c0c5cc09ab4e`). The WIZARD CHROME (progress indicator,
 * Back, Skip) has NO Stitch screen — it is built to the spec's token-only
 * contract and is flagged for human visual verification.
 *
 * SHERIFF: scope:mobile / slice:onboarding. Imports only `@vultus/shared/*` +
 * itself + third-party (Ionic, ionicons). No `slice:settings` import.
 */
@Component({
  selector: 'lib-onboarding',
  providers: [...ONBOARDING_PROVIDERS],
  imports: [
    IonContent,
    IonButton,
    IonSelect,
    IonSelectOption,
    IonSpinner,
    IonToggle,
    IonIcon,
  ],
  templateUrl: './onboarding.page.html',
  styleUrl: './onboarding.page.scss',
})
export class OnboardingPage {
  protected readonly service = inject(OnboardingService);
  protected readonly plexLink = inject(OnboardingPlexLinkService);
  private readonly router = inject(Router);

  /** Step-1 selection (defaults to `NL`); persisted via `setRegion` on Continue.
   *  Held on the component so a Back-nav to step 1 still shows the prior pick. */
  protected readonly selectedRegion = signal<Region>('NL');

  /**
   * Presentation helper: maps a raw ISO `Region` code to its human-readable
   * endonym for the option label (spec 0079). The persisted value stays the raw
   * code via `[value]="region"` — this is display-only.
   */
  protected readonly regionDisplayName = regionDisplayName;

  /** True while a step's own async write (region create / `complete()`) is in
   *  flight — disables that step's primary CTA so a double-tap can't double-fire. */
  protected readonly busy = signal(false);

  /** True while a single provider-chip toggle write is in flight (step 2). */
  protected readonly providerBusy = signal(false);

  /** Error-stage heading for step 4, chosen by the link service's reason so a
   *  post-authorization failure is NOT mislabeled as an expired code. */
  protected readonly plexErrorHeading = computed(() => {
    switch (this.plexLink.errorReason()) {
      case 'no-server':
        return 'No local server found';
      case 'network':
        return "Couldn't reach Plex";
      default:
        return 'Code expired';
    }
  });

  /** Error-stage detail line for step 4, paired with `plexErrorHeading`. */
  protected readonly plexErrorDetail = computed(() => {
    switch (this.plexLink.errorReason()) {
      case 'no-server':
        return 'Your account is linked, but no Plex Media Server was found on this network. Make sure your server is running and signed in to the same Plex account, then try again.';
      case 'network':
        return 'Something went wrong reaching Plex. Check your connection and try again.';
      default:
        return 'This link code timed out before it was entered. Get a new code and enter it at plex.tv/link.';
    }
  });

  constructor() {
    addIcons({ checkmarkCircle, alertCircle, shieldCheckmark });

    // Step-entry side effect: load the provider catalog when the wizard reaches
    // step 2 (no-ops when already loaded for the region). Fires on the STEP change
    // alone.
    //
    // The step-4 Plex link is DELIBERATELY NOT auto-started here — the PIN flow is
    // user-initiated from the idle stage's "Connect Plex" button (see `startLink`).
    // Auto-requesting a PIN on step-4 ENTRY conflated "navigate into step 4" with
    // "run the live PIN/discovery", which spec 0078 decision 7 keeps distinct
    // (navigate-in + skip is in e2e scope; the live link is device-only). Worse,
    // every NON-native surface (e2e / serve-mock / web) resolves `PLEX_CLIENT` to
    // the deterministic `MockPlexClient`, whose `checkPin` AUTO-authorizes on the
    // first poll: an auto-started poll therefore raced straight to `connected`,
    // writing `hasPlex`/`plexSync` and tearing the "Skip for now" button out of
    // the DOM mid-click — the deterministic e2e detachment failure. Leaving step 4
    // in `idle` until the user taps "Connect Plex" keeps the skip affordance a
    // stable, always-clickable node and guarantees the skip path performs no
    // Plex write.
    effect(() => {
      const step = this.service.currentStep();
      if (step === 2) {
        // Swallow a rejected catalog load (e.g. the GET_WATCH_PROVIDERS callable
        // being unavailable, as in the e2e emulator harness) so it doesn't surface
        // as an unhandled promise rejection / console noise.
        this.service.loadProviderCatalog().catch(() => undefined);
      }
    });
  }

  // --- Step 1: region -------------------------------------------------------
  protected onRegionChange(event: CustomEvent): void {
    this.selectedRegion.set((event.detail as { value: Region }).value);
  }

  /** Persist the chosen region (create-with-defaults on first write), then
   *  advance. Guards against a double-tap while the write is in flight. */
  protected async onContinueRegion(): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    try {
      await this.service.setRegion(this.selectedRegion());
      this.service.next();
    } finally {
      this.busy.set(false);
    }
  }

  // --- Step 2: providers ----------------------------------------------------
  /** Toggle one provider chip (persists the whole `myProviderIds` array). */
  protected async onProviderToggle(providerId: number): Promise<void> {
    if (this.providerBusy()) {
      return;
    }
    this.providerBusy.set(true);
    try {
      await this.service.toggleProvider(providerId);
    } finally {
      this.providerBusy.set(false);
    }
  }

  /** Builds the full TMDB logo URL for a provider chip, or null when unknown. */
  protected providerLogoUrl(provider: CatalogProvider): string | null {
    return provider.logoPath ? `${TMDB_LOGO_BASE}${provider.logoPath}` : null;
  }

  // --- Step 3: notifications ------------------------------------------------
  protected onNotificationsChange(event: CustomEvent): void {
    void this.service.setNotificationsEnabled(
      (event.detail as { checked: boolean }).checked,
    );
  }

  protected onDeliveryHourChange(event: CustomEvent): void {
    void this.service.setDeliveryHour(
      (event.detail as { value: number | null }).value,
    );
  }

  /** Zero-pads an hour to `HH:00 UTC` (DecimalPipe is not imported here). */
  protected formatHour(hour: number): string {
    return `${String(hour).padStart(2, '0')}:00 UTC`;
  }

  // --- Step 4: Plex link ----------------------------------------------------
  /** "Connect Plex" (step-4 idle stage) — user-initiated START of the PIN-link
   *  flow. NOT fired on step entry (see the constructor effect comment): keeping
   *  the flow user-triggered stops the auto-authorizing MockPlexClient from
   *  racing to `connected` before the user can skip. */
  protected startLink(): void {
    void this.plexLink.requestCode();
  }

  /** "Get a new code" / "Try again" — request a fresh PIN. */
  protected regenerate(): void {
    void this.plexLink.regenerateCode();
  }

  /** "Skip for now" (step 4 only) — stop any live poll, then advance to step 5
   *  WITHOUT any `hasPlex`/`plexSync` write. */
  protected onSkip(): void {
    this.plexLink.cancel();
    this.service.next();
  }

  // --- Shared nav -----------------------------------------------------------
  /** "Back" (steps 2-5). Leaving step 4 also cancels the link poll/countdown. */
  protected onBack(): void {
    if (this.service.currentStep() === 4) {
      this.plexLink.cancel();
    }
    this.service.back();
  }

  // --- Step 5: finish -------------------------------------------------------
  /** "Get started" — complete onboarding (push permission + flag LAST), then
   *  navigate to the app with `replaceUrl` so the back button can't return to
   *  onboarding (issue #65). Disabled + busy while in flight. */
  protected async onGetStarted(): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    try {
      await this.service.complete();
      await this.router.navigate(['/tabs/today'], { replaceUrl: true });
    } catch {
      // Completion is best-effort; navigate anyway so the user is never stuck,
      // but re-enable the button on an unexpected error. Still `replaceUrl` so
      // the back button never lands on the stuck onboarding page.
      await this.router.navigate(['/tabs/today'], { replaceUrl: true });
      this.busy.set(false);
    }
  }
}
