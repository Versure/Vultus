import { Component, OnInit, inject } from '@angular/core';
import { IonApp, IonRouterOutlet } from '@ionic/angular/standalone';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';
import {
  PLEX_BACKGROUND_INIT,
  PLEX_SYNC_TRIGGER,
} from '@vultus/shared/domain/tokens';
import { NotificationHandlerService } from './notification-handler.service';
import { SplashComponent } from './splash/splash.component';

@Component({
  imports: [IonApp, IonRouterOutlet, SplashComponent],
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  protected title = 'mobile';

  private readonly notificationHandler = inject(NotificationHandlerService);
  // Plex sync trigger (spec 0073) — a scope:shared thunk the shell provides over
  // the settings slice's PlexSyncService. Native-guarded internally (a no-op
  // off-native), so the boot/resume calls below are safe on web.
  private readonly plexSyncTrigger = inject(PLEX_SYNC_TRIGGER);
  // Background Plex sync init (spec 0085) — a scope:shared thunk the shell
  // provides over the settings slice's PlexBackgroundService. Native-guarded in
  // the factory (a no-op off-native), so the boot call below is safe on web.
  private readonly plexBackgroundInit = inject(PLEX_BACKGROUND_INIT);

  ngOnInit(): void {
    // Fire-and-forget: ngOnInit must return void (OnInit contract). The
    // edge-to-edge StatusBar setup is native-only and guarded below.
    void this.initStatusBar();
    // Register FCM push handlers (native-only, idempotent — see the service).
    void this.notificationHandler.init();
    // Kick a Plex sync on app open (boot). The thunk is native-guarded, so this
    // is a safe no-op on web; the sync service's own concurrent guard covers any
    // overlap with the resume listener below.
    void this.plexSyncTrigger();
    // Initialize periodic on-device background Plex sync (Android only; a
    // native-guarded no-op on web). Registers the WorkManager task that reruns
    // PlexSyncService.sync() on the user's chosen interval (spec 0085).
    void this.plexBackgroundInit();
    // Register a foreground-resume listener that re-runs the Plex sync
    // (native-only, idempotent — mirrors initStatusBar's guard style).
    void this.registerPlexResumeSync();
  }

  private async initStatusBar(): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    await StatusBar.setOverlaysWebView({ overlay: true });
    await StatusBar.setStyle({ style: Style.Dark });
  }

  private async registerPlexResumeSync(): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    // appStateChange fires on foreground/background transitions; re-sync when
    // the app becomes active again. The concurrent-sync guard in PlexSyncService
    // makes a resume-during-sync a safe no-op.
    await CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        void this.plexSyncTrigger();
      }
    });
  }
}
