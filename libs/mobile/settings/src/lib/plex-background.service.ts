import { Injectable, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { BackgroundFetch } from '@transistorsoft/capacitor-background-fetch';
import { PLEX_TOKEN_KEY } from './plex-link.service';
import { PlexSyncService } from './plex-sync.service';

/** Preferences key for the device-local "background sync enabled" flag. */
export const PLEX_BG_ENABLED_KEY = 'plex_bg_enabled';
/** Preferences key for the device-local background sync interval (minutes). */
export const PLEX_BG_INTERVAL_KEY = 'plex_bg_interval_min';

/** Interval options offered in the Settings UI (minutes). All ≥ Android's
 *  ~15-minute WorkManager floor; `60` is the default. */
export const PLEX_BG_INTERVAL_OPTIONS = [15, 30, 60, 180, 360] as const;

const DEFAULT_ENABLED = true;
const DEFAULT_INTERVAL_MIN = 60;
/** Android WorkManager's minimum periodic interval; any lower value is clamped. */
const MIN_INTERVAL_MIN = 15;

/**
 * Periodic on-device background Plex sync (spec 0085). A `providedIn: 'root'`
 * singleton that owns the device-local background config (enabled + interval, in
 * `@capacitor/preferences`) and wires the community
 * `@transistorsoft/capacitor-background-fetch` plugin so the OS wakes the app's
 * JS on the user's chosen interval and reruns the EXISTING 0073
 * `PlexSyncService.sync()`. NO sync logic is reimplemented here — this is purely
 * a new trigger.
 *
 * ANDROID-ONLY / native-guarded: on iOS/web/e2e/serve-mock every plugin call is
 * skipped. `init()` guards BEFORE loading Preferences, so off-native the
 * `enabled()` / `intervalMinutes()` signals stay at their defaults
 * (`true` / `60`) and the serve-mock screenshot shows the default control values.
 *
 * CIRCULAR-DI NOTE (spec §5): this service MUST NOT inject `PlexLinkService`.
 * `PlexLinkService.unlink()` calls `stop()` here, so a mutual `inject()` would
 * cycle (`NG0200`, both being `providedIn: 'root'`). The "linked on this device"
 * check in `onFetch` therefore reads the `plex_token` Preferences key DIRECTLY
 * (importing the exported `PLEX_TOKEN_KEY` constant), keeping the dependency
 * one-directional (`PlexLinkService → PlexBackgroundService` only).
 *
 * SECURITY (CLAUDE.md secrets): only the X-Plex-Token's PRESENCE is tested — the
 * token VALUE is never logged, echoed, or exposed. The bg config in Preferences
 * is a boolean + a number only.
 *
 * RELIABILITY (spec decision 2 — do NOT over-promise): reliable while the app is
 * alive/backgrounded and when Android relaunches the app in the background for a
 * task (`stopOnTerminate:false`, `startOnBoot:true`, `enableHeadless:true`). The
 * fully-terminated / swiped-away path is best-effort only (the headless stub in
 * `main.ts` just finishes the task); meaningful terminated-state sync is
 * on-device-verify-only.
 */
@Injectable({ providedIn: 'root' })
export class PlexBackgroundService {
  private readonly plexSync = inject(PlexSyncService);

  private readonly _enabled = signal<boolean>(DEFAULT_ENABLED);
  private readonly _intervalMinutes = signal<number>(DEFAULT_INTERVAL_MIN);

  /** Whether periodic background sync is scheduled (default `true`). */
  readonly enabled = this._enabled.asReadonly();
  /** The `minimumFetchInterval` in minutes (default `60`, always ≥ 15). */
  readonly intervalMinutes = this._intervalMinutes.asReadonly();

  /**
   * Boot init (via `PLEX_BACKGROUND_INIT`) and on-link init. Native-guard FIRST
   * (off-native → return, signals stay at defaults). Then load the persisted
   * config, configure + start the plugin, and — if disabled — stop it so no task
   * is scheduled.
   */
  async init(): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    await this.loadConfig();
    await this.configureFetch();
  }

  /**
   * Persist `plex_bg_enabled` UNCONDITIONALLY; then, ONLY when native,
   * reconfigure — enabled → configure/start, disabled → `BackgroundFetch.stop()`.
   * Off-native the plugin call is skipped (the Preferences write still happens),
   * so a serve-mock tick updates the signal without throwing against the web stub.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    this._enabled.set(enabled);
    await Preferences.set({ key: PLEX_BG_ENABLED_KEY, value: String(enabled) });
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    if (enabled) {
      await this.configureFetch();
    } else {
      await BackgroundFetch.stop();
    }
  }

  /**
   * Persist `plex_bg_interval_min` UNCONDITIONALLY (a value < 15 is clamped to
   * 15); then, ONLY when native, reconfigure with the new `minimumFetchInterval`.
   */
  async setIntervalMinutes(min: number): Promise<void> {
    const clamped = this.clampInterval(min);
    this._intervalMinutes.set(clamped);
    await Preferences.set({
      key: PLEX_BG_INTERVAL_KEY,
      value: String(clamped),
    });
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    await this.configureFetch();
  }

  /**
   * Clear the bg Preferences keys UNCONDITIONALLY; then, ONLY when native, call
   * `BackgroundFetch.stop()`. Called from `PlexLinkService.unlink()` — so unlink
   * on web/serve-mock still clears the bg config and stays a safe no-op against
   * the plugin.
   */
  async stop(): Promise<void> {
    await Preferences.remove({ key: PLEX_BG_ENABLED_KEY });
    await Preferences.remove({ key: PLEX_BG_INTERVAL_KEY });
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    await BackgroundFetch.stop();
  }

  /** Load the persisted config into the signals (defaults on absent keys). */
  private async loadConfig(): Promise<void> {
    const [{ value: enabledRaw }, { value: intervalRaw }] = await Promise.all([
      Preferences.get({ key: PLEX_BG_ENABLED_KEY }),
      Preferences.get({ key: PLEX_BG_INTERVAL_KEY }),
    ]);
    this._enabled.set(
      enabledRaw === null ? DEFAULT_ENABLED : enabledRaw === 'true',
    );
    const parsed =
      intervalRaw === null ? DEFAULT_INTERVAL_MIN : Number(intervalRaw);
    this._intervalMinutes.set(
      this.clampInterval(
        Number.isFinite(parsed) ? parsed : DEFAULT_INTERVAL_MIN,
      ),
    );
  }

  /**
   * Configure the plugin with the current interval + the pinned constraints
   * (UNMETERED / battery-not-low / no charging requirement; survives terminate +
   * boot + headless) and register `onFetch`/`onTimeout`. `configure()`
   * auto-starts the plugin; if the user disabled background sync, stop it so no
   * task schedules. Native-only (callers guard).
   */
  private async configureFetch(): Promise<void> {
    await BackgroundFetch.configure(
      {
        minimumFetchInterval: this._intervalMinutes(),
        requiredNetworkType: BackgroundFetch.NETWORK_TYPE_UNMETERED,
        requiresBatteryNotLow: true,
        requiresCharging: false,
        stopOnTerminate: false,
        startOnBoot: true,
        enableHeadless: true,
      },
      (taskId) => void this.onFetch(taskId),
      (taskId) => void this.onTimeout(taskId),
    );
    if (!this._enabled()) {
      await BackgroundFetch.stop();
    }
  }

  /**
   * The OS-scheduled fetch callback. Runs the EXISTING 0073 sync ONLY when
   * background sync is enabled AND the device is linked (a non-empty `plex_token`
   * in Preferences, read DIRECTLY — never via `PlexLinkService`, to avoid the
   * circular DI). `sync()` failures are swallowed (fail quietly, reusing 0073's
   * no-server/error/timeout handling — no new error UI). ALWAYS `finish` the task
   * in a `finally` (an unfinished task is penalised by the OS).
   */
  private async onFetch(taskId: string): Promise<void> {
    try {
      if (this._enabled() && (await this.isLinked())) {
        try {
          await this.plexSync.sync();
        } catch {
          // Swallow — reuse 0073's quiet failure handling; no new error UI.
        }
      }
    } finally {
      await BackgroundFetch.finish(taskId);
    }
  }

  /** The OS timeout callback — immediately finish the task. */
  private async onTimeout(taskId: string): Promise<void> {
    await BackgroundFetch.finish(taskId);
  }

  /**
   * "Linked on this device" ⇔ a non-empty `plex_token` value in Preferences.
   * Read directly (the service does NOT inject `PlexLinkService`); only the
   * token's PRESENCE is tested — the VALUE is never logged or exposed.
   */
  private async isLinked(): Promise<boolean> {
    const { value } = await Preferences.get({ key: PLEX_TOKEN_KEY });
    return value !== null && value.length > 0;
  }

  private clampInterval(min: number): number {
    return min < MIN_INTERVAL_MIN ? MIN_INTERVAL_MIN : min;
  }
}
