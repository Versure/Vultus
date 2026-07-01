import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  arrayUnion,
  doc,
  setDoc,
  updateDoc,
} from '@angular/fire/firestore';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { PushNotifications } from '@capacitor/push-notifications';
import { REGIONS, type FcmToken, type Region } from '@vultus/shared/domain';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import {
  type FcmTokenWriteData,
  userPath,
  userToData,
} from '@vultus/shared/firestore-schema';
import { ONBOARDING_DONE_KEY } from './onboarding.guard';

/**
 * First-launch onboarding data-access (spec 0022).
 *
 * `complete()` creates/merges `users/{uid}` with the chosen region and default
 * notificationPrefs, then — on a native platform only — requests push
 * permission and, on grant, registers for FCM and appends the device token to
 * `fcmTokens` via `arrayUnion`. The push flow is best-effort: any error there
 * is swallowed so it never blocks onboarding. The `onboarding_done` Preferences
 * flag is always set LAST, regardless of the push outcome, so a user is never
 * trapped in onboarding by a push failure.
 *
 * SHERIFF: scope:mobile / slice:onboarding. The uid comes from the
 * `scope:shared` `AUTH_UID` token (provided by the shell), never by importing
 * `apps/mobile`. Writes only ever target `users/{uid}` and only mutate
 * `fcmTokens` by union (never clobbering existing tokens, hence `{ merge: true }`
 * on the create).
 */
@Injectable()
export class OnboardingService {
  private readonly uid = inject(AUTH_UID);
  private readonly firestore = inject(Firestore);

  /** The selectable regions (the shared REGIONS const). */
  readonly regions: readonly Region[] = REGIONS;

  /**
   * Persist onboarding: write the user doc, attempt push registration on
   * native, then record completion. Resolves once the `onboarding_done` flag is
   * set; never rejects from the push branch.
   */
  async complete(region: Region): Promise<void> {
    const uid = this.uid();

    if (uid !== null) {
      // Best-effort Firestore write + push registration — neither must block the
      // completion flag below. A failure here (network down, rules, token not yet
      // propagated) is recoverable: the user doc can be written on next launch.
      try {
        const ref = doc(this.firestore, userPath(uid));
        await setDoc(
          ref,
          userToData({
            region,
            notificationPrefs: {
              episodeAired: true,
              movieAvailable: true,
              cameToPlatform: true,
              deliveryHour: null,
            },
            fcmTokens: [],
            myProviderIds: [],
          }),
          { merge: true },
        );

        if (Capacitor.isNativePlatform()) {
          await this.registerForPush(uid);
        }
      } catch {
        // Swallow: Firestore/push errors must never block onboarding completion.
      }
    }

    // Always set last — regardless of uid availability, Firestore outcome, or
    // push outcome. This ensures the user is never permanently stuck on the
    // onboarding screen due to a transient auth or network failure.
    await Preferences.set({ key: ONBOARDING_DONE_KEY, value: 'true' });
  }

  /**
   * Best-effort native push registration. Requests permission, and on grant
   * registers + awaits the one-shot `registration` event, then appends the
   * token to `fcmTokens`. Any failure is swallowed — push is never allowed to
   * block onboarding completion.
   */
  private async registerForPush(uid: string): Promise<void> {
    try {
      const permission = await PushNotifications.requestPermissions();
      if (permission.receive !== 'granted') {
        return;
      }

      await PushNotifications.register();
      const value = await waitForRegistration();

      const fcmToken: FcmToken = {
        token: value,
        deviceId: 'android',
        createdAt: new Date().toISOString(),
      };
      const wireToken: FcmTokenWriteData = {
        token: fcmToken.token,
        deviceId: fcmToken.deviceId,
        createdAt: new Date(),
      };

      await updateDoc(doc(this.firestore, userPath(uid)), {
        fcmTokens: arrayUnion(wireToken),
      });
    } catch {
      // Swallow: push registration must never block onboarding completion.
    }
  }
}

/**
 * Resolve with the FCM token from the one-shot `registration` event, rejecting
 * on `registrationError`. Both listeners are removed once either fires so no
 * handler leaks past the single registration.
 */
function waitForRegistration(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let registrationHandle: PluginListenerHandle | undefined;
    let errorHandle: PluginListenerHandle | undefined;

    const cleanup = (): void => {
      void registrationHandle?.remove();
      void errorHandle?.remove();
    };

    void PushNotifications.addListener('registration', (registration) => {
      cleanup();
      resolve(registration.value);
    }).then((handle) => {
      registrationHandle = handle;
    });

    void PushNotifications.addListener('registrationError', (error) => {
      cleanup();
      reject(new Error(error.error));
    }).then((handle) => {
      errorHandle = handle;
    });
  });
}
