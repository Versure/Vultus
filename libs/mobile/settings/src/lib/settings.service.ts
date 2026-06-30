import { Injectable, effect, inject, signal } from '@angular/core';
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

  /** Selectable delivery hours 0..23 (UTC). `null` = "Any time". */
  readonly deliveryHours: readonly number[] = Array.from(
    { length: 24 },
    (_v, i) => i,
  );

  private readonly _region = signal<Region | null>(null);
  private readonly _notificationsEnabled = signal<boolean>(true);
  private readonly _deliveryHour = signal<number | null>(null);
  // Full per-type prefs tracked in state so both `setNotificationsEnabled` and
  // `setDeliveryHour` can rebuild and write all four `notificationPrefs` fields
  // together — neither setter clobbers the other's data.
  private readonly _prefs = signal<User['notificationPrefs']>({
    episodeAired: true,
    movieAvailable: true,
    cameToPlatform: true,
    deliveryHour: null,
  });
  private readonly _loaded = signal<boolean>(false);
  private readonly _loadFailed = signal<boolean>(false);

  /** Current persisted region; null until the user doc resolves. */
  readonly region = this._region.asReadonly();
  /** Global notifications projection (true when all notificationPrefs are true). */
  readonly notificationsEnabled = this._notificationsEnabled.asReadonly();
  /** Current persisted delivery hour (UTC), or null for "Any time". */
  readonly deliveryHour = this._deliveryHour.asReadonly();
  /** True once `load()` has resolved (render-gate for the page). */
  readonly loaded = this._loaded.asReadonly();
  /**
   * True when the last `load()` attempt threw (e.g. Firestore offline). The
   * page renders an error state with a retry instead of hanging on the
   * skeleton; checked BEFORE `loaded` in the template.
   */
  readonly loadFailed = this._loadFailed.asReadonly();

  constructor() {
    // Reactively load once a uid resolves. ngOnInit's load() is the fast path
    // when uid is already available; this effect handles the slow path where
    // anonymous auth resolves AFTER the page has mounted (uid was null at init).
    // The guard prevents a redundant re-load (effect re-running after a
    // successful fast-path load) and avoids fighting a user-driven retry.
    effect(() => {
      const uid = this.uid();
      if (uid !== null && !this._loaded() && !this._loadFailed()) {
        void this.load();
      }
    });
  }

  /** Reads `users/{uid}`; creates it with defaults if absent. */
  async load(): Promise<void> {
    const uid = this.uid();
    if (uid === null) {
      // Not-ready: no session yet. Do not touch Firestore on a null/undefined
      // path; the page stays render-gated until a uid resolves.
      return;
    }

    // Clear any prior failure so a re-attempt starts from the skeleton state.
    this._loadFailed.set(false);

    try {
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
            deliveryHour: null,
          },
          fcmTokens: [],
        };
        await setDoc(ref, userToData(user));
      }

      this._region.set(user.region);
      this._prefs.set(user.notificationPrefs);
      this._notificationsEnabled.set(
        projectNotifications(user.notificationPrefs),
      );
      this._deliveryHour.set(user.notificationPrefs.deliveryHour);
      this._loaded.set(true);
    } catch (error) {
      // Surface the failure as an error state. `_loaded` stays false; the
      // template checks `loadFailed` first, so the skeleton never hangs.
      console.error('[SettingsService] load() failed:', error);
      this._loadFailed.set(true);
    }
  }

  /** Re-attempts `load()` after a failure (clears the error flag first). */
  retryLoad(): void {
    this._loadFailed.set(false);
    void this.load();
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
   * Persists the global notifications toggle: sets ALL THREE per-type
   * notificationPrefs to `enabled` (decision 2), while PRESERVING the current
   * `deliveryHour` (spec 0051) — the whole `notificationPrefs` object is
   * rewritten from state so the delivery-hour setter is never clobbered.
   * `fcmTokens` is never touched here.
   */
  async setNotificationsEnabled(enabled: boolean): Promise<void> {
    const uid = this.uid();
    if (uid === null) {
      return;
    }
    const prefs: User['notificationPrefs'] = {
      episodeAired: enabled,
      movieAvailable: enabled,
      cameToPlatform: enabled,
      deliveryHour: this._deliveryHour(),
    };
    await updateDoc(doc(this.firestore, userPath(uid)), {
      notificationPrefs: prefs,
    });
    this._prefs.set(prefs);
    this._notificationsEnabled.set(enabled);
  }

  /**
   * Persists the quiet-hours delivery preference (spec 0051). Rewrites the
   * WHOLE `notificationPrefs` object, PRESERVING the three per-type booleans
   * from state and setting `deliveryHour` to `hour` (null = "Any time").
   * `fcmTokens` is never touched here.
   */
  async setDeliveryHour(hour: number | null): Promise<void> {
    const uid = this.uid();
    if (uid === null) {
      return;
    }
    const current = this._prefs();
    const prefs: User['notificationPrefs'] = {
      episodeAired: current.episodeAired,
      movieAvailable: current.movieAvailable,
      cameToPlatform: current.cameToPlatform,
      deliveryHour: hour,
    };
    await updateDoc(doc(this.firestore, userPath(uid)), {
      notificationPrefs: prefs,
    });
    this._prefs.set(prefs);
    this._deliveryHour.set(hour);
  }
}

/** Global toggle = all three per-type prefs ANDed (decision 2). */
function projectNotifications(prefs: User['notificationPrefs']): boolean {
  return prefs.episodeAired && prefs.movieAvailable && prefs.cameToPlatform;
}
