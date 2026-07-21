import {
  Component,
  type OnDestroy,
  type OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonTitle,
  IonToolbar,
  NavController,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  alertCircle,
  arrowBack,
  checkmarkCircle,
  copyOutline,
  shieldCheckmark,
} from 'ionicons/icons';
import { PlexBackgroundService } from './plex-background.service';
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
  ],
  templateUrl: './plex-connect.page.html',
  styleUrl: './plex-connect.page.scss',
})
export class PlexConnectPage implements OnInit, OnDestroy {
  protected readonly link = inject(PlexLinkService);
  private readonly sync = inject(PlexSyncService);
  private readonly background = inject(PlexBackgroundService);
  private readonly nav = inject(NavController);

  /** Transient "Copied" confirmation, auto-cleared ~2s after a successful copy. */
  protected readonly copied = signal(false);
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  /** Error-stage heading, chosen by `PlexLinkService.errorReason` so a
   *  post-authorization failure is NOT mislabeled as an expired code. */
  protected readonly errorHeading = computed(() => {
    switch (this.link.errorReason()) {
      case 'no-server':
        return 'No local server found';
      case 'network':
        return "Couldn't reach Plex";
      default:
        return 'Code expired';
    }
  });

  /** Error-stage detail line, paired with `errorHeading`. */
  protected readonly errorDetail = computed(() => {
    switch (this.link.errorReason()) {
      case 'no-server':
        return 'Your account is linked, but no Plex Media Server was found on this network. Make sure your server is running and signed in to the same Plex account, then try again.';
      case 'network':
        return 'Something went wrong reaching Plex. Make sure your Plex server is running and on the same network as this device, then try again.';
      default:
        return 'This link code timed out before it was entered. Get a new code and enter it at plex.tv/link.';
    }
  });

  constructor() {
    addIcons({
      alertCircle,
      arrowBack,
      checkmarkCircle,
      copyOutline,
      shieldCheckmark,
    });
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
    // Drop any pending "Copied" reset so no timer fires after teardown.
    if (this.copiedTimer !== null) {
      clearTimeout(this.copiedTimer);
      this.copiedTimer = null;
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

  /**
   * Copy the current 4-char link code to the clipboard via the WEB Clipboard
   * API (`navigator.clipboard`) — this works in the Capacitor Android WebView
   * (secure `https` scheme + the tap's user gesture) and in serve-mock/web, so
   * no `@capacitor/clipboard` plugin is needed. Feature-detected + guarded:
   * a missing API or a rejected write (permission denied) is swallowed so the
   * page never crashes; neither the code nor the error is logged.
   */
  protected async copyCode(): Promise<void> {
    if (!navigator.clipboard?.writeText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(this.link.code() ?? '');
    } catch {
      // writeText can reject when the gesture/permission is denied — no-op.
      return;
    }
    this.copied.set(true);
    if (this.copiedTimer !== null) {
      clearTimeout(this.copiedTimer);
    }
    this.copiedTimer = setTimeout(() => {
      this.copied.set(false);
      this.copiedTimer = null;
    }, 2000);
  }

  /**
   * "Done" — pop back to Settings, kick an initial sync, and initialize periodic
   * background sync (spec 0085) so a freshly-linked device schedules its task
   * immediately (default ON) without waiting for the next boot. Both are
   * fire-and-forget; `init()` is a native-guarded no-op off-device.
   */
  protected done(): void {
    void this.sync.sync();
    void this.background.init();
    void this.nav.navigateBack('/tabs/settings');
  }
}
