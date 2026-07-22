import { Injectable, computed, inject, signal } from '@angular/core';
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
import {
  REGIONS,
  type CatalogProvider,
  type FcmToken,
  type Region,
  type User,
} from '@vultus/shared/domain';
import { AUTH_UID, GET_WATCH_PROVIDERS } from '@vultus/shared/domain/tokens';
import {
  type FcmTokenWriteData,
  userPath,
  userToData,
} from '@vultus/shared/firestore-schema';
import { ONBOARDING_DONE_KEY } from './onboarding.guard';

/** All-true per-type prefs with no quiet-hour — the create-with-defaults value
 *  (unchanged from spec 0022) and the notification-step starting point. */
function defaultPrefs(): User['notificationPrefs'] {
  return {
    episodeAired: true,
    movieAvailable: true,
    cameToPlatform: true,
    movieLeavingPlatform: true,
    showLeavingPlatform: true,
    deliveryHour: null,
  };
}

/**
 * First-launch onboarding data-access — the 5-step wizard's single source of
 * truth (spec 0078; extends spec 0022).
 *
 * The wizard renders one of five ordered steps from `currentStep`
 * (1 Region → 2 My Providers → 3 Notifications → 4 Plex link → 5 Finish) and
 * persists each choice WRITE-AS-YOU-GO to `users/{uid}` rather than batching at
 * the end (decision 2):
 *
 * - **Step 1 (region):** the FIRST `setRegion` CREATES `users/{uid}` with the
 *   same defaults as spec 0022's create (region + all-true `notificationPrefs`,
 *   `deliveryHour: null`, `fcmTokens: []`, `myProviderIds: []`, `hasPlex: false`)
 *   via `setDoc(..., { merge: true })`. A LATER `setRegion` (back-nav / region
 *   change) just updates `region` AND re-triggers the SAME catalog-reload-and-
 *   prune coupling `SettingsService.setRegion` has: reload the new region's
 *   catalog, drop any selected `myProviderIds` absent from it, persist the pruned
 *   array — but SKIP the prune (preserve the list) if the catalog reload fails.
 * - **Step 2 (my providers):** `loadProviderCatalog` fetches via the
 *   `scope:shared` `GET_WATCH_PROVIDERS` token; `toggleProvider` persists the
 *   WHOLE `myProviderIds` `number[]` via `updateDoc` (spec-0060 shape).
 * - **Step 3 (notifications):** `setNotificationsEnabled` sets all three per-type
 *   booleans at once (preserving `deliveryHour`); `setDeliveryHour` preserves the
 *   three booleans (spec-0011/0051 shape). `notificationsEnabled` is the
 *   projection (true iff all three are true).
 * - **Step 5 (finish):** `complete()` (region already persisted in step 1, so no
 *   region arg) requests native push permission and, on grant, registers + unions
 *   one FCM token, then sets `onboarding_done = 'true'` LAST. A denied/failed push
 *   never blocks completion (unchanged from spec 0022, decisions 5/6). The
 *   completion flag remains the LAST write of the whole wizard.
 *
 * SHERIFF: scope:mobile / slice:onboarding. The uid comes from the
 * `scope:shared` `AUTH_UID` token and the catalog from the `scope:shared`
 * `GET_WATCH_PROVIDERS` token (both provided by the shell) — never by importing
 * `apps/mobile` or `slice:settings` (the settings orchestration classes are
 * reimplemented here, not imported — 2 slices < the 3+-slice extraction
 * threshold). Every write targets ONLY `users/{uid}`; each is null-uid guarded.
 */
@Injectable()
export class OnboardingService {
  private readonly uid = inject(AUTH_UID);
  private readonly firestore = inject(Firestore);
  private readonly getWatchProviders = inject(GET_WATCH_PROVIDERS);

  /** The selectable regions (the shared REGIONS const). */
  readonly regions: readonly Region[] = REGIONS;

  /** Selectable delivery hours 0..23 (UTC). `null` = "Any time". */
  readonly deliveryHours: readonly number[] = Array.from(
    { length: 24 },
    (_v, i) => i,
  );

  // --- Step state -----------------------------------------------------------
  private readonly _currentStep = signal<1 | 2 | 3 | 4 | 5>(1);
  /** The wizard's current step (1..5); the page renders one step from it. */
  readonly currentStep = this._currentStep.asReadonly();

  // --- Region (step 1) ------------------------------------------------------
  private readonly _region = signal<Region | null>(null);
  /** Current persisted region; null until step 1's first write. */
  readonly region = this._region.asReadonly();
  /** Whether `users/{uid}` has been created this session (drives create-vs-update
   *  in `setRegion`). Onboarding is the doc's normal creator (spec 0022). */
  private docCreated = false;

  // --- My Providers (step 2) ------------------------------------------------
  private readonly _providerCatalog = signal<CatalogProvider[]>([]);
  private readonly _myProviderIds = signal<number[]>([]);
  private readonly _catalogLoading = signal<boolean>(false);
  /** The region whose catalog is loaded into `_providerCatalog`, so
   *  `loadProviderCatalog()` no-ops when already loaded for the current region. */
  private loadedCatalogRegion: Region | null = null;

  /** The current region's TMDB watch-provider catalog (loaded lazily). */
  readonly providerCatalog = this._providerCatalog.asReadonly();
  /** The user's selected provider ids (persisted; default []). */
  readonly myProviderIds = this._myProviderIds.asReadonly();
  /** True while the catalog is being fetched (drives a skeleton/spinner). */
  readonly catalogLoading = this._catalogLoading.asReadonly();

  // --- Notifications (step 3) -----------------------------------------------
  // Full per-type prefs tracked in state so both `setNotificationsEnabled` and
  // `setDeliveryHour` rebuild and write all four `notificationPrefs` fields
  // together — neither setter clobbers the other's data.
  private readonly _prefs = signal<User['notificationPrefs']>(defaultPrefs());
  /** Global notifications projection (true iff all three per-type prefs true). */
  readonly notificationsEnabled = computed(() => {
    const p = this._prefs();
    return p.episodeAired && p.movieAvailable && p.cameToPlatform;
  });
  /** Current delivery hour (UTC), or null for "Any time". */
  readonly deliveryHour = computed(() => this._prefs().deliveryHour);

  // --- Step navigation ------------------------------------------------------
  /** Advance one step; no-op past step 5. */
  next(): void {
    const step = this._currentStep();
    if (step < 5) {
      this._currentStep.set((step + 1) as 1 | 2 | 3 | 4 | 5);
    }
  }

  /** Retreat one step; no-op before step 1. */
  back(): void {
    const step = this._currentStep();
    if (step > 1) {
      this._currentStep.set((step - 1) as 1 | 2 | 3 | 4 | 5);
    }
  }

  // --- Step 1: region -------------------------------------------------------
  /**
   * Persist the region write-as-you-go. On the FIRST call this CREATES
   * `users/{uid}` with defaults (`setDoc(..., { merge: true })`, identical to
   * spec 0022's create). On a LATER call it updates `region` and re-triggers the
   * catalog-reload-and-prune coupling (see class doc / Risks): reload the new
   * region's catalog and drop any selected `myProviderIds` absent from it,
   * persisting the pruned array — SKIPPING the prune (preserving the list) if the
   * catalog reload itself fails. Null-uid guarded.
   */
  async setRegion(region: Region): Promise<void> {
    const uid = this.uid();
    if (uid === null) {
      return;
    }
    const ref = doc(this.firestore, userPath(uid));

    if (!this.docCreated) {
      await setDoc(
        ref,
        userToData({
          region,
          notificationPrefs: defaultPrefs(),
          fcmTokens: [],
          myProviderIds: [],
          hasPlex: false,
        }),
        { merge: true },
      );
      this.docCreated = true;
      this._region.set(region);
      this._prefs.set(defaultPrefs());
      this._myProviderIds.set([]);
      return;
    }

    // Later write (back-nav / region change): update the region scalar, then
    // reconcile the provider selection against the new region's catalog.
    await updateDoc(ref, { region });
    this._region.set(region);

    // Reload the NEW region's catalog. On any load failure, bail BEFORE pruning
    // (data-preservation guard) — never destroy the list on a failed read.
    try {
      await this.loadProviderCatalog();
    } catch {
      return;
    }

    const catalogIds = new Set(
      this._providerCatalog().map((p) => p.providerId),
    );
    const current = this._myProviderIds();
    const pruned = current.filter((id) => catalogIds.has(id));
    if (pruned.length !== current.length) {
      await updateDoc(ref, { myProviderIds: pruned });
      this._myProviderIds.set(pruned);
    }
  }

  // --- Step 2: my providers -------------------------------------------------
  /**
   * Loads the current region's provider catalog via `GET_WATCH_PROVIDERS`
   * (spec 0060). No-op if already loaded for the current region, and a no-op
   * (without touching `catalogLoading`) when no region has resolved yet. The
   * region is claimed synchronously BEFORE the await so a concurrent same-region
   * caller short-circuits instead of double-fetching; on a fetch FAILURE the
   * claim is reset (so a retry re-fetches) and the error re-thrown so `setRegion`
   * still skips its prune.
   */
  async loadProviderCatalog(): Promise<void> {
    const region = this._region();
    if (region === null || this.loadedCatalogRegion === region) {
      return;
    }
    this.loadedCatalogRegion = region;
    this._catalogLoading.set(true);
    try {
      const providers = await this.getWatchProviders(region);
      this._providerCatalog.set(providers);
    } catch (error) {
      this.loadedCatalogRegion = null;
      throw error;
    } finally {
      this._catalogLoading.set(false);
    }
  }

  /**
   * Toggles one provider id in `myProviderIds` (add if absent, remove if
   * present) and persists the WHOLE resulting `number[]` via
   * `updateDoc(..., { myProviderIds })` (spec-0060 shape). Null-uid guarded.
   */
  async toggleProvider(providerId: number): Promise<void> {
    const uid = this.uid();
    if (uid === null) {
      return;
    }
    const current = this._myProviderIds();
    const next = current.includes(providerId)
      ? current.filter((id) => id !== providerId)
      : [...current, providerId];
    await updateDoc(doc(this.firestore, userPath(uid)), {
      myProviderIds: next,
    });
    this._myProviderIds.set(next);
  }

  // --- Step 3: notifications ------------------------------------------------
  /**
   * Persists the global notifications toggle: sets ALL THREE per-type
   * `notificationPrefs` to `enabled` while PRESERVING the current `deliveryHour`
   * (spec-0011/0051 shape). The whole `notificationPrefs` object is rewritten
   * from state so `setDeliveryHour` is never clobbered. `fcmTokens` untouched.
   * Null-uid guarded.
   */
  async setNotificationsEnabled(enabled: boolean): Promise<void> {
    const uid = this.uid();
    if (uid === null) {
      return;
    }
    const current = this._prefs();
    const prefs: User['notificationPrefs'] = {
      episodeAired: enabled,
      movieAvailable: enabled,
      cameToPlatform: enabled,
      // Independent per-kind toggles (spec 0057) — NOT folded into the global
      // enable/disable projection; preserve their current values.
      movieLeavingPlatform: current.movieLeavingPlatform,
      showLeavingPlatform: current.showLeavingPlatform,
      deliveryHour: current.deliveryHour,
    };
    await updateDoc(doc(this.firestore, userPath(uid)), {
      notificationPrefs: prefs,
    });
    this._prefs.set(prefs);
  }

  /**
   * Persists the quiet-hours delivery preference (spec 0051). Rewrites the WHOLE
   * `notificationPrefs` object, PRESERVING the three per-type booleans from state
   * and setting `deliveryHour` to `hour` (null = "Any time"). `fcmTokens`
   * untouched. Null-uid guarded.
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
      movieLeavingPlatform: current.movieLeavingPlatform,
      showLeavingPlatform: current.showLeavingPlatform,
      deliveryHour: hour,
    };
    await updateDoc(doc(this.firestore, userPath(uid)), {
      notificationPrefs: prefs,
    });
    this._prefs.set(prefs);
  }

  // --- Step 5: finish -------------------------------------------------------
  /**
   * Complete onboarding: attempt native push registration, then record
   * completion (unchanged from spec 0022 — region is already persisted by step
   * 1, so this takes no region arg). Resolves once the `onboarding_done` flag is
   * set; never rejects from the push branch.
   */
  async complete(): Promise<void> {
    const uid = this.uid();

    if (uid !== null && Capacitor.isNativePlatform()) {
      // Best-effort push registration — it must never block the completion flag.
      await this.registerForPush(uid);
    }

    // Always set LAST — regardless of uid availability or push outcome — so the
    // user is never permanently stuck on onboarding by a transient failure. This
    // remains the LAST write of the whole wizard.
    await Preferences.set({ key: ONBOARDING_DONE_KEY, value: 'true' });
  }

  /**
   * Best-effort native push registration. Requests permission, and on grant
   * registers + awaits the one-shot `registration` event, then appends the token
   * to `fcmTokens`. Any failure is swallowed — push never blocks completion.
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
