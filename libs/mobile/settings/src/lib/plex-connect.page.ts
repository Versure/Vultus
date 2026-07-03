import { Component, type OnDestroy, type OnInit, inject } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonSpinner,
  IonTitle,
  IonToolbar,
  NavController,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, checkmarkCircle, shieldCheckmark } from 'ionicons/icons';
import { PlexLinkService } from './plex-link.service';
import { PlexSyncService } from './plex-sync.service';

/**
 * Connect Plex page — a settings-owned pushed sub-route (`/tabs/settings/plex`,
 * registered by the shell in T4), spec 0073 §6B, Stitch screen
 * `398cde766832491e92e1c0c5cc09ab4e`. Fixed header (back arrow + centered
 * "Connect Plex"), NO bottom nav. Renders ONE of three stages driven by
 * `PlexLinkService.stage` ('idle'|'code'|'waiting'|'connected'|'error'):
 * - code/waiting: the 4-char link code, an expiry countdown (mm:ss), and a
 *   waiting spinner while polling; "Get a new code" regenerates on expiry;
 * - connected: a check icon, "Connected to Plex", the server row, and "Done"
 *   which pops back to Settings and kicks an initial sync.
 *
 * Injects the ROOT `PlexLinkService` / `PlexSyncService` singletons (shared with
 * the shell trigger + `SettingsPage`) — it does NOT re-provide them.
 */
@Component({
  selector: 'lib-plex-connect',
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonIcon,
    IonSpinner,
  ],
  templateUrl: './plex-connect.page.html',
  styleUrl: './plex-connect.page.scss',
})
export class PlexConnectPage implements OnInit, OnDestroy {
  protected readonly link = inject(PlexLinkService);
  private readonly sync = inject(PlexSyncService);
  private readonly nav = inject(NavController);

  constructor() {
    addIcons({ arrowBack, checkmarkCircle, shieldCheckmark });
  }

  ngOnInit(): void {
    // Kick off the link flow when entering the page fresh (idle). If we arrive
    // mid-flow (e.g. re-entered), leave the existing stage untouched.
    if (this.link.stage() === 'idle') {
      void this.link.requestCode();
    }
  }

  ngOnDestroy(): void {
    // Leaving the page without finishing → stop polling / the countdown.
    if (this.link.stage() !== 'connected') {
      this.link.cancel();
    }
  }

  /** Back arrow / Cancel — stop polling and pop the route. */
  protected goBack(): void {
    this.link.cancel();
    void this.nav.navigateBack('/tabs/settings');
  }

  /** "Get a new code" — request a fresh PIN. */
  protected regenerate(): void {
    void this.link.regenerateCode();
  }

  /** "Done" — pop back to Settings and kick an initial sync (fire-and-forget). */
  protected done(): void {
    void this.sync.sync();
    void this.nav.navigateBack('/tabs/settings');
  }
}
