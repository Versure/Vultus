import { Component, type OnInit, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  AlertController,
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
import { regionDisplayName } from '@vultus/shared/domain';
import type { CatalogProvider, Region } from '@vultus/shared/domain';
import { VultusErrorState } from '@vultus/shared/ui-kit';
import { addIcons } from 'ionicons';
import {
  albumsOutline,
  checkmarkCircle,
  chevronDownOutline,
  chevronForward,
  filmOutline,
  globeOutline,
  notificationsOutline,
  personCircleOutline,
  timeOutline,
} from 'ionicons/icons';
import { PlexLinkService } from './plex-link.service';
import { PlexSyncService } from './plex-sync.service';
import type { PlexSyncResult } from './plex-sync.service';
import { SETTINGS_PROVIDERS } from './settings.providers';
import { SettingsService } from './settings.service';
import { SyncStatusCardComponent } from './sync-status-card.component';
import { relativeTime } from './sync-status-card.component';

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
  // Root singletons (spec 0073) — SHARED with the shell's boot/resume trigger;
  // deliberately NOT listed in SETTINGS_PROVIDERS, so the page injects the same
  // instance the trigger drives (a page-scoped provide would fork the state).
  protected readonly plexLink = inject(PlexLinkService);
  protected readonly plexSync = inject(PlexSyncService);
  private readonly toastController = inject(ToastController);
  private readonly alertController = inject(AlertController);
  private readonly router = inject(Router);

  /**
   * #166: whether the "My Providers" chip grid is expanded. In-memory only
   * (ephemeral) — the card is COLLAPSED by default and resets to collapsed on
   * every visit; no persistence (spec 0075). Replicates the title-detail
   * season-collapse idiom in-slice (not imported from `slice:title-detail`).
   */
  protected readonly providersExpanded = signal(false);

  /**
   * Maps a raw ISO `Region` code to its human-readable native endonym for
   * DISPLAY only (spec 0079). The persisted `region` value stays the raw code —
   * this wrapper is applied at the option label, footer, and prune toast.
   */
  protected readonly regionDisplayName = regionDisplayName;

  constructor() {
    addIcons({
      globeOutline,
      notificationsOutline,
      filmOutline,
      personCircleOutline,
      timeOutline,
      albumsOutline,
      checkmarkCircle,
      chevronForward,
      chevronDownOutline,
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
    // #165: `load()` now chains the provider-catalog fetch itself once the region
    // resolves, so no eager (racy, null-region) `loadProviderCatalog()` here.
    void this.service.load();
    // Load the Plex link state so the card renders the correct (dis)connected
    // block (spec 0073). Fire-and-forget; the card defaults to disconnected.
    void this.plexLink.loadState();
  }

  /** Navigate to the Connect Plex sub-page (disconnected row tap, spec 0073). */
  protected openPlexConnect(): void {
    void this.router.navigate(['/tabs/settings/plex']);
  }

  /**
   * Run one Plex sync (connected "Sync now") and give the user feedback via a
   * toast — success (with counts), a benign no-op, or a failure. Without this the
   * sync was invisible: a silent skip and a hard failure looked identical.
   * Refreshes the card's "Last synced" label only when the pass actually ran.
   */
  protected async syncPlexNow(): Promise<void> {
    const result = await this.plexSync.sync();
    if (result.status === 'ok') {
      await this.plexLink.loadState();
    }
    await this.presentSyncToast(result);
  }

  /** Toast copy for each `PlexSyncResult`. A `busy` skip stays silent (another
   *  sync is already surfacing its own outcome). */
  private async presentSyncToast(result: PlexSyncResult): Promise<void> {
    let message: string;
    if (result.status === 'ok') {
      const { added, updated } = result.summary;
      message =
        added + updated > 0
          ? `Plex sync complete — ${added} added, ${updated} updated`
          : 'Plex sync complete — already up to date';
    } else if (result.status === 'error') {
      message = "Couldn't reach Plex — check your server and connection";
    } else if (result.reason === 'no-server') {
      message = "Couldn't find your Plex server on this network";
    } else if (result.reason === 'not-linked') {
      message = 'Connect Plex before syncing';
    } else {
      // 'busy' — a sync is already running; don't double-toast.
      return;
    }
    const toast = await this.toastController.create({
      message,
      duration: 4000,
      position: 'bottom',
    });
    await toast.present();
  }

  /**
   * "Last synced — {relative}" text (or "Not synced yet" when never synced).
   * Reuses the slice-local `relativeTime` helper (sync-status card).
   */
  protected plexLastSyncedLabel(): string {
    const iso = this.plexLink.lastSyncAt();
    return iso === null
      ? 'Not synced yet'
      : `Last synced — ${relativeTime(iso, Date.now())}`;
  }

  /**
   * "Disconnect" — confirm first (unlink drops the sync cursor), then unlink
   * (clears the device token + `plexSync`; keeps `hasPlex` + all synced data).
   */
  protected async disconnectPlex(): Promise<void> {
    const alert = await this.alertController.create({
      header: 'Disconnect Plex?',
      message:
        'This removes the link to your Plex server. Your synced titles and watch history are kept.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Disconnect',
          role: 'destructive',
          handler: () => {
            void this.plexLink.unlink();
          },
        },
      ],
    });
    await alert.present();
  }

  protected retry(): void {
    this.service.retryLoad();
  }

  protected onRegionChange(event: CustomEvent): void {
    void this.service.setRegion((event.detail as { value: Region }).value);
  }

  /** #166: expands/collapses the "My Providers" chip grid (in-memory only). */
  protected toggleProviders(): void {
    this.providersExpanded.update((v) => !v);
  }

  /** Toggles one provider chip's membership in `myProviderIds` (spec 0060). */
  protected onProviderToggle(providerId: number): void {
    void this.service.toggleProvider(providerId);
  }

  /** Builds the full TMDB logo URL for a provider chip, or null when unknown. */
  protected providerLogoUrl(provider: CatalogProvider): string | null {
    return provider.logoPath ? `${TMDB_LOGO_BASE}${provider.logoPath}` : null;
  }

  /**
   * Toggles the Plex chip (spec 0061). Separate handler from
   * `onProviderToggle` — Plex is its OWN boolean (`hasPlex`), not a
   * `myProviderIds` catalog entry.
   */
  protected onPlexToggle(): void {
    void this.service.toggleHasPlex();
  }

  private async presentPruneToast(dropped: number): Promise<void> {
    const region = this.service.region();
    // A prune only fires after a region change, so `region` is always resolved
    // here; the guard just narrows away the signal's `null` for the display-name
    // wrapper (spec 0079) — there is nothing to name if there is no region.
    if (region === null) return;
    const noun = dropped === 1 ? 'provider' : 'providers';
    const toast = await this.toastController.create({
      message: `${dropped} ${noun} aren't available in ${regionDisplayName(region)} and were removed`,
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
