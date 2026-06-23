import { Injectable, inject, signal } from '@angular/core';
import {
  Firestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
} from '@angular/fire/firestore';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import { REGIONS, type Region, type User } from '@vultus/shared/domain';
import {
  dataToUser,
  userPath,
  userToData,
  type UserReadData,
} from '@vultus/shared/firestore-schema';

/**
 * Settings data-access for the Vultus settings tab (spec 0011, PLAN §6 item 16).
 *
 * Reads-or-creates `users/{uid}` on `load()` and persists region /
 * notifications changes, using the shared `@vultus/shared/firestore-schema`
 * converters as the persistence contract. The single UI "notifications" toggle
 * is a projection over the three `notificationPrefs` booleans (decision 2): it
 * reads as on when ALL three are true, and writing sets ALL three at once.
 *
 * SHERIFF: this slice obtains the uid via the `scope:shared` `AUTH_UID` token
 * (provided by the shell), never by importing `apps/mobile`. It injects
 * AngularFire `Firestore` (third-party) directly — Sheriff does not police it.
 * It never writes outside `users/{uid}` and never mutates `fcmTokens` beyond
 * the `[]` default written on eager create (FCM is deferred to PLAN §6 item 21).
 */
@Injectable()
export class SettingsService {
  private readonly uid = inject(AUTH_UID);
  private readonly firestore = inject(Firestore);

  /** The selectable regions (the shared REGIONS const). */
  readonly regions: readonly Region[] = REGIONS;

  private readonly _region = signal<Region | null>(null);
  private readonly _notificationsEnabled = signal<boolean>(true);
  private readonly _loaded = signal<boolean>(false);

  /** Current persisted region; null until the user doc resolves. */
  readonly region = this._region.asReadonly();
  /** Global notifications projection (true when all notificationPrefs are true). */
  readonly notificationsEnabled = this._notificationsEnabled.asReadonly();
  /** True once `load()` has resolved (render-gate for the page). */
  readonly loaded = this._loaded.asReadonly();

  /** Reads `users/{uid}`; creates it with defaults if absent. */
  async load(): Promise<void> {
    const uid = this.uid();
    if (uid === null) {
      // Not-ready: no session yet. Do not touch Firestore on a null/undefined
      // path; the page stays render-gated until a uid resolves.
      return;
    }

    const ref = doc(this.firestore, userPath(uid));
    const snap = await getDoc(ref);

    let user: User;
    if (snap.exists()) {
      user = dataToUser(snap.data() as UserReadData);
    } else {
      user = {
        region: 'NL',
        notificationPrefs: {
          episodeAired: true,
          movieAvailable: true,
          cameToPlatform: true,
        },
        fcmTokens: [],
      };
      await setDoc(ref, userToData(user));
    }

    this._region.set(user.region);
    this._notificationsEnabled.set(
      projectNotifications(user.notificationPrefs),
    );
    this._loaded.set(true);
  }

  /** Persists the region only; leaves all other fields untouched. */
  async setRegion(region: Region): Promise<void> {
    const uid = this.uid();
    if (uid === null) {
      return;
    }
    await updateDoc(doc(this.firestore, userPath(uid)), { region });
    this._region.set(region);
  }

  /**
   * Persists the global notifications toggle: sets ALL THREE notificationPrefs
   * to `enabled` (decision 2). `fcmTokens` is never touched here.
   */
  async setNotificationsEnabled(enabled: boolean): Promise<void> {
    const uid = this.uid();
    if (uid === null) {
      return;
    }
    await updateDoc(doc(this.firestore, userPath(uid)), {
      notificationPrefs: {
        episodeAired: enabled,
        movieAvailable: enabled,
        cameToPlatform: enabled,
      },
    });
    this._notificationsEnabled.set(enabled);
  }
}

/** Global toggle = all three per-type prefs ANDed (decision 2). */
function projectNotifications(prefs: User['notificationPrefs']): boolean {
  return prefs.episodeAired && prefs.movieAvailable && prefs.cameToPlatform;
}
