import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonButton,
  IonContent,
  IonSelect,
  IonSelectOption,
  IonSpinner,
} from '@ionic/angular/standalone';
import type { Region } from '@vultus/shared/domain';
import { ONBOARDING_PROVIDERS } from './onboarding.providers';
import { OnboardingService } from './onboarding.service';

/**
 * First-launch onboarding page (spec 0022): pick a region, see the push-permission
 * explainer, and tap "Get started" to persist the user doc + completion flag and
 * enter the app.
 *
 * NOTE: there is no Stitch screen for onboarding in the project — this layout is
 * built to the spec's UI contract and is flagged for human visual verification.
 *
 * SHERIFF: scope:mobile / slice:onboarding.
 */
@Component({
  selector: 'lib-onboarding',
  providers: [...ONBOARDING_PROVIDERS],
  imports: [IonContent, IonButton, IonSelect, IonSelectOption, IonSpinner],
  templateUrl: './onboarding.page.html',
  styleUrl: './onboarding.page.scss',
})
export class OnboardingPage {
  protected readonly service = inject(OnboardingService);
  private readonly router = inject(Router);

  protected readonly selectedRegion = signal<Region>('NL');
  protected readonly loading = signal<boolean>(false);

  protected onRegionChange(event: CustomEvent): void {
    this.selectedRegion.set((event.detail as { value: Region }).value);
  }

  protected async onGetStarted(): Promise<void> {
    if (this.loading()) {
      // Guard against a double-tap while the first completion is in flight.
      return;
    }
    this.loading.set(true);
    try {
      await this.service.complete(this.selectedRegion());
      // `replaceUrl: true` drops `/onboarding` from the history stack so the
      // Android hardware back button can't return to it (issue #65).
      await this.router.navigate(['/tabs/watchlist'], { replaceUrl: true });
    } catch {
      // Onboarding completion is best-effort; navigate anyway so the user is
      // never stuck, but re-enable the button on an unexpected error. Still
      // replaceUrl so the back button never lands on the stuck onboarding page.
      await this.router.navigate(['/tabs/watchlist'], { replaceUrl: true });
      this.loading.set(false);
    }
  }
}
