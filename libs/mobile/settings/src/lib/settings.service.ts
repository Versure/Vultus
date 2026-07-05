import { Injectable, effect, inject, signal } from '@angular/core';
import {
  Firestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
} from '@angular/fire/firestore';
import { AUTH_UID, GET_WATCH_PROVIDERS } from '@vultus/shared/domain/tokens';
import {
  REGIONS,
  type CatalogProvider,
  type Region,
  type User,
} from '@vultus/shared/domain';
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
 *
 * "My Providers" (spec 0060): the region's TMDB watch-provider catalog is
 * fetched via the `scope:shared` `GET_WATCH_PROVIDERS` token (a thunk the shell
 * provides over the `getWatchProviders` callable) — this slice never imports
 * `@angular/fire/functions` or `apps/functions`. The user's chosen provider ids
 * persist in `users/{uid}.myProviderIds` (an open `number[]`; default `[]`).
 *
 * Plex (spec 0061): `users/{uid}.hasPlex` is a SEPARATE boolean (default
 * `false`), NOT a member of `myProviderIds` (Plex has no TMDB id). It is toggled
 * from its own 7th "My Providers" chip via `toggleHasPlex`, never through
 * `toggleProvider`.
 */
@Injectable()
export class SettingsService {
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

  // "My Providers" (spec 0060) state.
  private readonly _providerCatalog = signal<CatalogProvider[]>([]);
  private readonly _myProviderIds = signal<number[]>([]);
  private readonly _catalogLoading = signal<boolean>(false);
  // Number of ids dropped by the most recent region-change prune. The page
  // reacts to this to raise a toast; reset to 0 on any prune that drops nothing
  // (and never surfaced when the prune is skipped on a catalog-load failure).
  private readonly _lastPrunedCount = signal<number>(0);
  // Plex (spec 0061): whether the user uses a self-hosted Plex server. A
  // separate boolean on `users/{uid}` — NOT a member of `myProviderIds`.
  private readonly _hasPlex = signal<boolean>(false);
  // The region whose catalog is currently loaded into `_providerCatalog`, so
  // `loadProviderCatalog()` can no-op when it's already loaded for this region.
  private loadedCatalogRegion: Region | null = null;

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

  /** The current region's TMDB watch-provider catalog (loaded lazily). */
  readonly providerCatalog = this._providerCatalog.asReadonly();
  /** The user's selected provider ids (persisted; default []). */
  readonly myProviderIds = this._myProviderIds.asReadonly();
  /** True while the catalog is being fetched (drives a skeleton/spinner). */
  readonly catalogLoading = this._catalogLoading.asReadonly();
  /**
   * Count of provider ids dropped by the last region-change prune (spec 0060).
   * The page reacts to a >0 value to raise a "removed" toast; 0 means nothing
   * was dropped (or the prune was skipped on a failed catalog load).
   */
  readonly lastPrunedCount = this._lastPrunedCount.asReadonly();
  /**
   * Whether the user uses a Plex server (persisted on `users/{uid}.hasPlex`;
   * default `false`). Backs the "My Providers" Plex chip (spec 0061).
   */
  readonly hasPlex = this._hasPlex.asReadonly();

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
          myProviderIds: [],
          hasPlex: false,
        };
        await setDoc(ref, userToData(user));
      }

      this._region.set(user.region);
      this._prefs.set(user.notificationPrefs);
      this._notificationsEnabled.set(
        projectNotifications(user.notificationPrefs),
      );
      this._deliveryHour.set(user.notificationPrefs.deliveryHour);
      this._myProviderIds.set(user.myProviderIds);
      this._hasPlex.set(user.hasPlex);
      this._loaded.set(true);
      // #165: now that the region has resolved, load the provider catalog so the
      // "My Providers" footer reads "N of M" (never "N of 0") on the FIRST visit,
      // without needing a region switch. Fire-and-forget — a catalog failure must
      // not fail `load()` (the page's core render-gate); the guard is claimed
      // synchronously so a later same-region caller can't double-fetch (spec 0075).
      void this.loadProviderCatalog();
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

  /**
   * Persists the region, then reconciles "My Providers" to the new region's
   * catalog (spec 0060). This is TWO sequential `users/{uid}` writes — first the
   * region, then (once the new catalog loads) the pruned `myProviderIds` — never
   * batched, so the "skip prune on load failure" guard can leave a valid,
   * already-persisted region with an untouched provider list.
   *
   * After the region write:
   * - load the NEW region's catalog (forces a refetch — the loaded region
   *   changed);
   * - drop any `myProviderIds` not present in that catalog and persist the
   *   pruned array;
   * - expose the dropped count via `lastPrunedCount` (>0 iff ≥1 id was dropped)
   *   so the page can toast it.
   *
   * GUARD: if the new catalog fails to load, SKIP the prune entirely — never
   * destroy the provider list on a failed read. `lastPrunedCount` stays 0.
   */
  async setRegion(region: Region): Promise<void> {
    const uid = this.uid();
    if (uid === null) {
      return;
    }
    await updateDoc(doc(this.firestore, userPath(uid)), { region });
    this._region.set(region);

    // Reconcile the provider selection against the new region's catalog. On any
    // failure to load, bail before pruning (data-preservation guard).
    try {
      await this.loadProviderCatalog();
    } catch (error) {
      console.error(
        '[SettingsService] region-change catalog load failed; skipping prune:',
        error,
      );
      this._lastPrunedCount.set(0);
      return;
    }

    const catalogIds = new Set(
      this._providerCatalog().map((p) => p.providerId),
    );
    const current = this._myProviderIds();
    const pruned = current.filter((id) => catalogIds.has(id));
    const droppedCount = current.length - pruned.length;

    if (droppedCount > 0) {
      await updateDoc(doc(this.firestore, userPath(uid)), {
        myProviderIds: pruned,
      });
      this._myProviderIds.set(pruned);
    }
    this._lastPrunedCount.set(droppedCount);
  }

  /**
   * Loads the current region's provider catalog via `GET_WATCH_PROVIDERS`
   * (spec 0060). No-op if the catalog is already loaded for the current region.
   * No-op (and does not touch `catalogLoading`) when there is no resolved region
   * yet. Propagates the thunk's rejection to the caller (so `setRegion` can skip
   * the prune) but always clears `catalogLoading`.
   *
   * IN-FLIGHT GUARD (spec 0075 B1): the region is claimed synchronously (into
   * `loadedCatalogRegion`) BEFORE the `await`, so a second same-region caller
   * that enters while the first fetch is still in flight short-circuits on the
   * already-claimed guard instead of double-fetching. This matters because
   * `load()` now chains an un-awaited `void this.loadProviderCatalog()` that can
   * race a later explicit / `setRegion()` call for the same region. On a fetch
   * FAILURE the claim is RESET to `null` (and the error re-thrown so `setRegion`
   * still skips its prune) so a failed catalog fetch stays retryable.
   */
  async loadProviderCatalog(): Promise<void> {
    const region = this._region();
    if (region === null) {
      return;
    }
    if (this.loadedCatalogRegion === region) {
      return;
    }

    // Claim the region synchronously BEFORE the await so a concurrent same-region
    // caller (the un-awaited load()-chained call racing a later setRegion()) short-
    // circuits on the guard instead of double-fetching (spec 0075 B1).
    this.loadedCatalogRegion = region;
    this._catalogLoading.set(true);
    try {
      const providers = await this.getWatchProviders(region);
      this._providerCatalog.set(providers);
    } catch (error) {
      // Reset the guard so a failed fetch stays retryable; re-throw so setRegion
      // still skips its prune.
      this.loadedCatalogRegion = null;
      throw error;
    } finally {
      this._catalogLoading.set(false);
    }
  }

  /**
   * Toggles one provider id in `myProviderIds` (add if absent, remove if
   * present) and persists the WHOLE resulting `number[]` via
   * `updateDoc(..., { myProviderIds })` (spec 0060). Null-uid guarded.
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

  /**
   * Toggles `hasPlex` and persists it via a scalar `updateDoc({ hasPlex })`
   * (spec 0061), like `setRegion`'s `{ region }` write. Null-uid guarded.
   * SEPARATE from `toggleProvider` — Plex is not a `myProviderIds` catalog
   * entry and this write never touches `myProviderIds`.
   */
  async toggleHasPlex(): Promise<void> {
    const uid = this.uid();
    if (uid === null) {
      return;
    }
    const next = !this._hasPlex();
    await updateDoc(doc(this.firestore, userPath(uid)), { hasPlex: next });
    this._hasPlex.set(next);
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
