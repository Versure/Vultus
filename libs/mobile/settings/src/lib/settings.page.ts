import { Component, type OnInit, effect, inject } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonSelect,
  IonSelectOption,
  IonSkeletonText,
  IonSpinner,
  IonTitle,
  IonToggle,
  IonToolbar,
  ToastController,
} from '@ionic/angular/standalone';
import type { CatalogProvider, Region } from '@vultus/shared/domain';
import { VultusErrorState } from '@vultus/shared/ui-kit';
import { addIcons } from 'ionicons';
import {
  albumsOutline,
  checkmarkCircle,
  filmOutline,
  globeOutline,
  notificationsOutline,
  personCircleOutline,
  timeOutline,
} from 'ionicons/icons';
import { SETTINGS_PROVIDERS } from './settings.providers';
import { SettingsService } from './settings.service';
import { SyncStatusCardComponent } from './sync-status-card.component';

// TMDB logo path base for provider logos. `logoPath` on `CatalogProvider` is a
// bare TMDB path (e.g. `/abc.jpg`); w92 is the smallest TMDB logo size, ample
// for a ~48px chip tile. Same hardcoded-base pattern the notifications slice
// uses for poster URLs.
const TMDB_LOGO_BASE = 'https://image.tmdb.org/t/p/w92';

@Component({
  selector: 'lib-settings',
  providers: [...SETTINGS_PROVIDERS],
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonIcon,
    IonSelect,
    IonSelectOption,
    IonToggle,
    IonSkeletonText,
    IonSpinner,
    VultusErrorState,
    SyncStatusCardComponent,
  ],
  templateUrl: './settings.page.html',
  styleUrl: './settings.page.scss',
})
export class SettingsPage implements OnInit {
  protected readonly service = inject(SettingsService);
  private readonly toastController = inject(ToastController);

  constructor() {
    addIcons({
      globeOutline,
      notificationsOutline,
      filmOutline,
      personCircleOutline,
      timeOutline,
      albumsOutline,
      checkmarkCircle,
    });

    // Raise a toast whenever a region change prunes ≥1 provider from the user's
    // selection (spec 0060). Reacts to the service's `lastPrunedCount` signal so
    // the presentation stays in the page; the service owns the prune logic.
    effect(() => {
      const dropped = this.service.lastPrunedCount();
      if (dropped > 0) {
        void this.presentPruneToast(dropped);
      }
    });
  }

  ngOnInit(): void {
    void this.service.load();
    void this.service.loadProviderCatalog();
  }

  protected retry(): void {
    this.service.retryLoad();
  }

  protected onRegionChange(event: CustomEvent): void {
    void this.service.setRegion((event.detail as { value: Region }).value);
  }

  /** Toggles one provider chip's membership in `myProviderIds` (spec 0060). */
  protected onProviderToggle(providerId: number): void {
    void this.service.toggleProvider(providerId);
  }

  /** Builds the full TMDB logo URL for a provider chip, or null when unknown. */
  protected providerLogoUrl(provider: CatalogProvider): string | null {
    return provider.logoPath ? `${TMDB_LOGO_BASE}${provider.logoPath}` : null;
  }

  private async presentPruneToast(dropped: number): Promise<void> {
    const region = this.service.region();
    const noun = dropped === 1 ? 'provider' : 'providers';
    const toast = await this.toastController.create({
      message: `${dropped} ${noun} aren't available in ${region} and were removed`,
      duration: 4000,
      position: 'bottom',
    });
    await toast.present();
  }

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
}
