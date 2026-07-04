import { Injectable, computed, inject, signal } from '@angular/core';
import {
  Firestore,
  deleteField,
  doc,
  getDoc,
  updateDoc,
} from '@angular/fire/firestore';
import { Preferences } from '@capacitor/preferences';
import { AUTH_UID, PLEX_CLIENT } from '@vultus/shared/domain/tokens';
import type { PlexServer } from '@vultus/shared/domain';
import { dataToUser, userPath } from '@vultus/shared/firestore-schema';
import type { UserReadData } from '@vultus/shared/firestore-schema';
import { PlexPinGoneError } from './plex-errors';

/** Preferences key for the on-device X-Plex-Token (NEVER in Firestore). */
export const PLEX_TOKEN_KEY = 'plex_token';

/** plex.tv PINs live ~15 minutes (`expiresIn: 900` at issue). The countdown is
 *  WALL-CLOCK anchored (a deadline timestamp, not tick-counting): Android
 *  throttles WebView timers while the user is off at plex.tv/link, so a
 *  decrement-per-tick counter silently falls behind real time. */
const PIN_TTL_SECONDS = 15 * 60;

/** Poll interval for the PIN authorization check (ms). */
const POLL_INTERVAL_MS = 2000;

/** Consecutive checkPin transport failures tolerated before giving up. A single
 *  rejected poll must NOT kill the link: Android can terminate an in-flight
 *  request's socket when the app is backgrounded/frozen mid-flow. */
const MAX_POLL_FAILURES = 5;

export type PlexLinkStage = 'idle' | 'code' | 'waiting' | 'connected' | 'error';

/** Why the flow is in the 'error' stage — the connect page picks its copy from
 *  this. Spec 0073 (Risks) pins a DISTINCT "no local server found" surface: a
 *  post-authorization failure must not masquerade as an expired code.
 *  - 'expired':   the PIN genuinely timed out (local deadline or plex.tv 404);
 *  - 'no-server': auth succeeded but discovery found no local server;
 *  - 'network':   a plex.tv/Firestore call failed (transport/HTTP error). */
export type PlexLinkErrorReason = 'expired' | 'no-server' | 'network';

/**
 * Owns the plex.tv PIN-link state machine + on-device token persistence +
 * server discovery + the `hasPlex` / `plexSync` Firestore link metadata
 * (spec 0073, decision 2/10). A `providedIn: 'root'` singleton so the shell's
 * `PLEX_SYNC_TRIGGER` factory and both `SettingsPage` + `PlexConnectPage` share
 * ONE instance (the settings page must NOT re-provide it — that would fork the
 * link state).
 *
 * ORDERING INVARIANT: the token is persisted ONLY AFTER server discovery
 * succeeds, and rolled back if the Firestore metadata write then fails — so a
 * failed link can never leave the device half-linked (token present but no
 * `plexSync`), a state that made the Settings card claim "Connected" while the
 * connect page reported an error. `loadState` self-heals any half-linked state
 * left behind by older builds.
 *
 * SECURITY (CLAUDE.md / spec 0073): the X-Plex-Token is persisted ONLY to
 * `@capacitor/preferences` (key `plex_token`), NEVER written to any Firestore
 * path, and NEVER logged/echoed. The `plexSync` doc holds only the multi-device
 * cursor + display name. Unlink clears the Preferences token + `plexSync`
 * (`deleteField()`), KEEPS `hasPlex` + all synced watchlist/episode data.
 *
 * SHERIFF: uid via the `scope:shared` `AUTH_UID` token; the Plex client via the
 * `scope:shared` `PLEX_CLIENT` token; `Firestore` injected directly (third-party).
 * All writes null-uid guarded. No cross-slice import.
 */
@Injectable({ providedIn: 'root' })
export class PlexLinkService {
  private readonly firestore = inject(Firestore);
  private readonly uid = inject(AUTH_UID);
  private readonly client = inject(PLEX_CLIENT);

  private readonly _stage = signal<PlexLinkStage>('idle');
  private readonly _errorReason = signal<PlexLinkErrorReason | null>(null);
  private readonly _code = signal<string | null>(null);
  private readonly _server = signal<PlexServer | null>(null);
  /** Whole-second countdown to PIN expiry; drives the connect page's mm:ss. */
  private readonly _expiresInSeconds = signal<number>(0);
  // Settings-card link state (the connected block reads these). `linked` tracks
  // the on-device token; serverName / lastSyncAt come from the `plexSync` doc.
  private readonly _linked = signal<boolean>(false);
  private readonly _serverName = signal<string | null>(null);
  private readonly _lastSyncAt = signal<string | null>(null);

  /** Current PIN-link stage (the connect page renders ONE stage from it). */
  readonly stage = this._stage.asReadonly();
  /** Why the stage is 'error' (null in every other stage). */
  readonly errorReason = this._errorReason.asReadonly();
  /** The 4-char link code shown to the user; null before a code is issued. */
  readonly code = this._code.asReadonly();
  /** The discovered server once connected; null otherwise. */
  readonly server = this._server.asReadonly();
  /** Seconds until the current PIN expires (0 when none / expired). */
  readonly expiresInSeconds = this._expiresInSeconds.asReadonly();
  /** True when linked on this device (token present) — gates the settings card. */
  readonly linked = this._linked.asReadonly();
  /** Connected server display name (from `plexSync.serverName`); null if unknown. */
  readonly serverName = this._serverName.asReadonly();
  /** Last successful sync ISO (from `plexSync.lastSyncAt`); null until first sync. */
  readonly lastSyncAt = this._lastSyncAt.asReadonly();
  /** `mm:ss` string derived from `expiresInSeconds` for the countdown label. */
  readonly countdown = computed(() => {
    const total = this._expiresInSeconds();
    const mm = Math.floor(total / 60);
    const ss = total % 60;
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  });

  private currentPinId: number | null = null;
  /** Wall-clock PIN deadline (epoch ms); null when no PIN is live. */
  private pinDeadlineMs: number | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  /** True when a token is present in Preferences (linked on THIS device). */
  async isLinked(): Promise<boolean> {
    const { value } = await Preferences.get({ key: PLEX_TOKEN_KEY });
    return value !== null && value.length > 0;
  }

  /**
   * Load the settings-card link state: the on-device token presence (→ `linked`)
   * and the `plexSync` display metadata (→ `serverName` / `lastSyncAt`) from
   * `users/{uid}`. Called by `SettingsPage` on init so the connected block shows
   * the right server + last-synced text. Null-uid guarded for the doc read.
   *
   * SELF-HEAL: a token with NO `plexSync` metadata is a half-linked device —
   * either a failed link from an older build (which persisted the token before
   * discovery) or an unlink performed on another device (which deletes the
   * account-level `plexSync`). The stale token is dropped so the card reflects
   * reality instead of claiming "Connected" to nothing.
   */
  async loadState(): Promise<void> {
    this._linked.set(await this.isLinked());
    const uid = this.uid();
    if (uid === null) {
      return;
    }
    const snap = await getDoc(doc(this.firestore, userPath(uid)));
    const meta = snap.exists()
      ? dataToUser(snap.data() as UserReadData).plexSync
      : undefined;
    if (this._linked() && !meta) {
      await Preferences.remove({ key: PLEX_TOKEN_KEY });
      this._linked.set(false);
      this._serverName.set(null);
      this._lastSyncAt.set(null);
      return;
    }
    this._serverName.set(meta?.serverName ?? null);
    this._lastSyncAt.set(meta?.lastSyncAt ?? null);
  }

  /**
   * Request a fresh PIN, expose its 4-char code, start the expiry countdown,
   * and begin polling for authorization. Moves to `code` immediately, then
   * `waiting` while polling, `connected` on success, `error` on expiry/failure.
   */
  async requestCode(): Promise<void> {
    this.stopTimers();
    this.currentPinId = null;
    this._errorReason.set(null);
    try {
      const pin = await this.client.requestPin();
      this.currentPinId = pin.id;
      this._code.set(pin.code);
      this._server.set(null);
      this._stage.set('code');
      this.startCountdown();
      this._stage.set('waiting');
      this.startPolling();
    } catch {
      // Never log the error object (may echo secrets); surface the error stage.
      this.fail('network');
    }
  }

  /** Request a brand-new PIN (on expiry/failure or "Get a new code"). */
  regenerateCode(): Promise<void> {
    return this.requestCode();
  }

  /** Stop polling and return to `idle` (the "Cancel" affordance). */
  cancel(): void {
    this.stopTimers();
    this.currentPinId = null;
    this.pinDeadlineMs = null;
    this._stage.set('idle');
    this._errorReason.set(null);
    this._code.set(null);
    this._expiresInSeconds.set(0);
  }

  /**
   * Clear the on-device token + the Firestore `plexSync` metadata (decision 10).
   * Does NOT touch `hasPlex` and touches NO watchlist/episode doc. Null-uid
   * guarded for the Firestore write; the Preferences clear always runs.
   */
  async unlink(): Promise<void> {
    this.stopTimers();
    this.currentPinId = null;
    this.pinDeadlineMs = null;
    await Preferences.remove({ key: PLEX_TOKEN_KEY });
    const uid = this.uid();
    if (uid !== null) {
      await updateDoc(doc(this.firestore, userPath(uid)), {
        plexSync: deleteField(),
      });
    }
    this._stage.set('idle');
    this._errorReason.set(null);
    this._code.set(null);
    this._server.set(null);
    this._expiresInSeconds.set(0);
    // Reflect the unlinked state on the settings card.
    this._linked.set(false);
    this._serverName.set(null);
    this._lastSyncAt.set(null);
  }

  /** One poll tick: check the PIN, and on an authToken complete the link. */
  private startPolling(): void {
    // Bind the chain to THIS pin: regenerate/cancel change `currentPinId`, and
    // a stale in-flight tick must neither touch the stage nor reschedule itself
    // (stopTimers cannot cancel an await that is already in flight).
    const pinId = this.currentPinId;
    let failures = 0;
    const tick = async (): Promise<void> => {
      if (pinId === null || this.currentPinId !== pinId) {
        return;
      }
      try {
        const pin = await this.client.checkPin(pinId);
        if (this.currentPinId !== pinId) {
          return; // superseded while the check was in flight
        }
        failures = 0;
        if (pin.authToken !== null && pin.authToken.length > 0) {
          await this.completeLink(pin.authToken);
          return;
        }
      } catch (err) {
        if (this.currentPinId !== pinId) {
          return;
        }
        // plex.tv says the pin itself is gone (404) → a REAL expiry.
        if (err instanceof PlexPinGoneError) {
          this.fail('expired');
          return;
        }
        // Transient transport failure (e.g. a socket killed while the app was
        // backgrounded at plex.tv/link): tolerate a few before giving up.
        // Never log the error object (may echo secrets).
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) {
          this.fail('network');
          return;
        }
      }
      // Not yet authorized — schedule the next poll unless the code expired
      // (the countdown interval raises the 'expired' error itself).
      if (this.remainingSeconds() > 0 && this.currentPinId === pinId) {
        this.pollTimer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
      }
    };
    // Kick the first check immediately.
    this.pollTimer = setTimeout(() => void tick(), 0);
  }

  /**
   * Discover the server, persist the token, write link metadata, go connected.
   * Never rejects — every failure is mapped to a specific error reason here.
   * ORDERING: discovery FIRST, token persistence after (see class doc).
   */
  private async completeLink(authToken: string): Promise<void> {
    this.stopTimers();
    this.currentPinId = null;
    this.pinDeadlineMs = null;
    let server: PlexServer | null;
    try {
      server = await this.client.discoverServer(authToken);
    } catch {
      // Never log the error object (may echo secrets).
      this.fail('network');
      return;
    }
    if (server === null) {
      // No LOCAL/owned server found — the spec-pinned distinct error surface.
      this.fail('no-server');
      return;
    }
    const now = new Date().toISOString();
    try {
      // Persist the token ON-DEVICE only — never Firestore, never logged.
      await Preferences.set({ key: PLEX_TOKEN_KEY, value: authToken });
      const uid = this.uid();
      if (uid !== null) {
        await updateDoc(doc(this.firestore, userPath(uid)), {
          hasPlex: true,
          plexSync: {
            linkedAt: now,
            lastSyncAt: now,
            serverName: server.name,
          },
        });
      }
    } catch {
      // Roll the token back so the device is not left half-linked.
      try {
        await Preferences.remove({ key: PLEX_TOKEN_KEY });
      } catch {
        // Preferences.remove failing is unrecoverable here; loadState's
        // self-heal will drop the orphaned token on the next settings load.
      }
      this.fail('network');
      return;
    }
    this._server.set(server);
    this._stage.set('connected');
    this._errorReason.set(null);
    this._expiresInSeconds.set(0);
    // Reflect the linked state on the settings card.
    this._linked.set(true);
    this._serverName.set(server.name);
    this._lastSyncAt.set(now);
  }

  /** Stop the flow and surface the error stage with a specific reason. */
  private fail(reason: PlexLinkErrorReason): void {
    this.stopTimers();
    this.currentPinId = null;
    this.pinDeadlineMs = null;
    this._expiresInSeconds.set(0);
    this._stage.set('error');
    this._errorReason.set(reason);
  }

  /** Wall-clock seconds until the PIN deadline (0 when none / expired). */
  private remainingSeconds(): number {
    if (this.pinDeadlineMs === null) {
      return 0;
    }
    return Math.max(0, Math.ceil((this.pinDeadlineMs - Date.now()) / 1000));
  }

  private startCountdown(): void {
    this.pinDeadlineMs = Date.now() + PIN_TTL_SECONDS * 1000;
    this._expiresInSeconds.set(PIN_TTL_SECONDS);
    this.countdownTimer = setInterval(() => {
      const remaining = this.remainingSeconds();
      this._expiresInSeconds.set(remaining);
      if (remaining <= 0) {
        // Expired with no authorization → error stage with "Get a new code".
        if (this._stage() !== 'connected') {
          this.fail('expired');
        } else {
          this.stopTimers();
        }
      }
    }, 1000);
  }

  private stopTimers(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.countdownTimer !== null) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }
}
