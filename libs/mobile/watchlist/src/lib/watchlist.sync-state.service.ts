import { Injectable, inject, signal } from '@angular/core';
import { TRIGGER_SYNC } from '@vultus/shared/domain/tokens';

/** localStorage key holding the ISO timestamp of the last successful manual sync. */
export const LAST_SYNC_KEY = 'vultus_last_sync_at';

/** Client-side cooldown window for the manual sync trigger: 5 minutes. */
export const SYNC_COOLDOWN_MS = 300_000;

/**
 * Slice-local client-side cooldown state for the watchlist's manual "refresh
 * now" trigger (spec 0025). Mirrors PLAN §1's "manual refresh, rate-limited to
 * once per 5 minutes" — the limit is **client-side only** (a personal
 * single-user app; the `triggerSync` callable has no server gate).
 *
 * It owns:
 * - `canSync` — false while inside the cooldown window, re-enabled by a timer at
 *   the exact expiry (so a restart mid-cooldown re-enables precisely).
 * - `syncing` — true while a sync is in flight (drives the spinner / disabled).
 * - `triggerSync()` — guards both signals, calls the injected `TRIGGER_SYNC`
 *   thunk, and on success records the new timestamp + starts the re-enable timer.
 *
 * The thunk is the only path to the callable: this slice never imports
 * `@angular/fire/functions` or `apps/mobile` — the shell provides `TRIGGER_SYNC`
 * (a `scope:shared` token), mirroring the `AUTH_UID` pattern.
 *
 * `localStorage` access is guarded — in some test/SSR contexts it is unavailable
 * or throws; the service then degrades to "always allowed" rather than throwing.
 */
@Injectable({ providedIn: 'root' })
export class SyncStateService {
  private readonly trigger = inject(TRIGGER_SYNC);

  /** True when a manual sync is allowed (not inside the cooldown window). */
  readonly canSync = signal(true);

  /** True while a manual sync is in flight. */
  readonly syncing = signal(false);

  private reEnableTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.restoreCooldown();
  }

  /**
   * Trigger a manual sync. No-op (returns) if a sync is not currently allowed
   * (cooldown active) or one is already in flight (prevents double-calls).
   *
   * On success: records a fresh timestamp, ends the syncing state, and starts a
   * fresh 5-minute cooldown. On failure: ends the syncing state, does NOT
   * advance the timestamp (so the user may retry), and re-throws so the caller
   * can surface an error toast.
   */
  async triggerSync(): Promise<void> {
    if (!this.canSync() || this.syncing()) {
      return;
    }
    this.syncing.set(true);
    try {
      await this.trigger();
    } catch (err) {
      // Do NOT advance the timestamp — the cooldown should not start on failure
      // so the user can retry immediately.
      this.syncing.set(false);
      throw err;
    }
    const now = Date.now();
    this.writeTimestamp(new Date(now).toISOString());
    this.syncing.set(false);
    this.startCooldown(now + SYNC_COOLDOWN_MS);
  }

  /** Reads the stored timestamp on construction and resumes any active cooldown. */
  private restoreCooldown(): void {
    const stored = this.readTimestamp();
    if (stored === null) {
      return;
    }
    const last = Date.parse(stored);
    if (Number.isNaN(last)) {
      return;
    }
    const expiry = last + SYNC_COOLDOWN_MS;
    if (expiry > Date.now()) {
      this.startCooldown(expiry);
    }
  }

  /** Disables `canSync` and re-enables it at the exact `expiry` epoch ms. */
  private startCooldown(expiry: number): void {
    if (this.reEnableTimer !== undefined) {
      clearTimeout(this.reEnableTimer);
    }
    this.canSync.set(false);
    const delay = Math.max(0, expiry - Date.now());
    this.reEnableTimer = setTimeout(() => {
      this.canSync.set(true);
      this.reEnableTimer = undefined;
    }, delay);
  }

  private readTimestamp(): string | null {
    try {
      return globalThis.localStorage?.getItem(LAST_SYNC_KEY) ?? null;
    } catch {
      // localStorage unavailable / blocked → degrade to "always allowed".
      return null;
    }
  }

  private writeTimestamp(iso: string): void {
    try {
      globalThis.localStorage?.setItem(LAST_SYNC_KEY, iso);
    } catch {
      // Best-effort: a failed write just means no persisted cooldown.
    }
  }
}
