import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Firestore, Timestamp, doc, updateDoc } from '@angular/fire/firestore';
import { ToastController } from '@ionic/angular/standalone';
import { Capacitor } from '@capacitor/core';
import {
  PushNotifications,
  type ActionPerformed,
  type PushNotificationSchema,
} from '@capacitor/push-notifications';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import { notificationPath } from '@vultus/shared/firestore-schema';

/**
 * Data payload Cloud Functions attach to every FCM message (spec 0041). Only
 * `notificationId` (the `users/{uid}/notifications/{id}` doc to mark read) and
 * `tmdbId` (the title-detail route segment) are consumed here; the other keys
 * (`titleId`, `kind`, `region`) ride along for analytics/debugging.
 */
interface NotificationData {
  notificationId: string;
  tmdbId: string;
}

/**
 * Shell-level FCM push handler (spec 0041). Registers Capacitor
 * PushNotifications listeners so that:
 *  - a notification arriving while the app is FOREGROUND shows an Ionic toast
 *    with a "View" action (no auto-navigate, no mark-read), and
 *  - a notification TAP (app background/terminated) deep-links to the title
 *    detail page and marks the notification read in Firestore.
 *
 * Native-only — a no-op in the browser/dev-server (no FCM there). Idempotent:
 * a second `init()` returns immediately so a re-entrant ngOnInit cannot
 * double-register listeners. Lives in the shell (not a slice) because it owns
 * cross-cutting navigation; it deep-links by Router string segments rather than
 * importing the title-detail slice (Sheriff: scope:mobile must not import
 * slice:*).
 */
@Injectable({ providedIn: 'root' })
export class NotificationHandlerService {
  private readonly router = inject(Router);
  private readonly firestore = inject(Firestore);
  private readonly toastController = inject(ToastController);
  private readonly uid = inject(AUTH_UID);

  private initialized = false;

  /** Native-only; no-op in browser. Idempotent. Called from App.ngOnInit. */
  async init(): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    // Foreground arrival: surface a toast; the user decides whether to open it.
    // No navigate, no mark-read — the notification stays unread until tapped.
    await PushNotifications.addListener(
      'pushNotificationReceived',
      (notification: PushNotificationSchema) => {
        void this.presentForegroundToast(notification);
      },
    );

    // Tap on a delivered notification (app in background or cold-started). This
    // single event covers both the warm-tap and cold-start paths — Capacitor
    // re-fires it after bootstrap for a notification that launched the app.
    await PushNotifications.addListener(
      'pushNotificationActionPerformed',
      (action: ActionPerformed) => {
        void this.openTitle(action.notification.data as NotificationData);
      },
    );
  }

  private async presentForegroundToast(
    notification: PushNotificationSchema,
  ): Promise<void> {
    const toast = await this.toastController.create({
      message: notification.body ?? notification.title ?? 'New notification',
      duration: 4000,
      position: 'top',
      buttons: [
        {
          text: 'View',
          role: 'info',
          handler: () => {
            void this.openTitle(notification.data as NotificationData);
          },
        },
      ],
    });
    await toast.present();
  }

  /**
   * Shared deep-link path for both the foreground "View" tap and the
   * background/cold-start tap. Navigation always happens first; marking the
   * notification read is best-effort and must never block or fail the
   * navigation, so the Firestore write is wrapped and its rejection swallowed.
   */
  private async openTitle(data: NotificationData): Promise<void> {
    await this.router.navigate(['tabs', 'title-detail', data.tmdbId]);

    const uid = this.uid();
    if (!uid) {
      return;
    }
    try {
      await updateDoc(
        doc(this.firestore, notificationPath(uid, data.notificationId)),
        { readAt: Timestamp.now() },
      );
    } catch {
      // Mark-read is non-fatal: the user already reached the title. Swallow.
    }
  }
}
