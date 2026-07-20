import { Injectable, computed, inject, signal } from '@angular/core';
import { Firestore, doc, updateDoc } from '@angular/fire/firestore';
import { Preferences } from '@capacitor/preferences';
import { AUTH_UID, PLEX_CLIENT } from '@vultus/shared/domain/tokens';
import type { PlexServer } from '@vultus/shared/domain';
import { userPath } from '@vultus/shared/firestore-schema';
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

/** Why the flow is in the 'error' stage — the onboarding step picks its copy
 *  from this. A DISTINCT "no local server found" surface: a post-authorization
 *  failure must not masquerade as an expired code.
 *  - 'expired':   the PIN genuinely timed out (local deadline or plex.tv 404);
 *  - 'no-server': auth succeeded but discovery found no local server;
 *  - 'network':   a plex.tv/Firestore call failed (transport/HTTP error). */
export type PlexLinkErrorReason = 'expired' | 'no-server' | 'network';

/**
 * Onboarding-owned plex.tv PIN-link state machine (spec 0078, decision 5). A
 * DUPLICATE of the subset of `slice:settings`'s `PlexLinkService` that the
 * onboarding wizard's step 4 needs — reimplemented here, NOT imported, because
 * `slice:onboarding` may import only `scope:shared` + itself (never
 * `slice:settings`). At 2 slices this duplication is correct (below the
 * 3+-slice extraction threshold — CLAUDE.md / PLAN §3).
 *
 * Deliberately OMITS `unlink()`, `loadState()`, `isLinked()`, and the
 * settings-card `linked`/`serverName`/`lastSyncAt` projection — first-launch
 * onboarding has nothing to unlink or load; it only performs a fresh link.
 *
 * ORDERING INVARIANT: the token is persisted ONLY AFTER server discovery
 * succeeds, and rolled back if the Firestore metadata write then fails — so a
 * failed link can never leave the device half-linked (token present but no
 * `plexSync`).
 *
 * SECURITY (CLAUDE.md / spec 0068/0073): the X-Plex-Token is persisted ONLY to
 * `@capacitor/preferences` (key `plex_token`), NEVER written to any Firestore
 * path, and NEVER logged/echoed. The `plexSync` doc holds only the multi-device
 * cursor + display name.
 *
 * SHERIFF: uid via the `scope:shared` `AUTH_UID` token; the Plex client via the
 * `scope:shared` `PLEX_CLIENT` token; `Firestore` injected directly
 * (third-party). All writes null-uid guarded. No cross-slice import.
 */
@Injectable({ providedIn: 'root' })
export class OnboardingPlexLinkService {
  private readonly firestore = inject(Firestore);
  private readonly uid = inject(AUTH_UID);
  private readonly client = inject(PLEX_CLIENT);

  private readonly _stage = signal<PlexLinkStage>('idle');
  private readonly _errorReason = signal<PlexLinkErrorReason | null>(null);
  private readonly _code = signal<string | null>(null);
  private readonly _server = signal<PlexServer | null>(null);
  /** Whole-second countdown to PIN expiry; drives the step's mm:ss label. */
  private readonly _expiresInSeconds = signal<number>(0);

  /** Current PIN-link stage (the step renders ONE stage from it). */
  readonly stage = this._stage.asReadonly();
  /** Why the stage is 'error' (null in every other stage). */
  readonly errorReason = this._errorReason.asReadonly();
  /** The 4-char link code shown to the user; null before a code is issued. */
  readonly code = this._code.asReadonly();
  /** The discovered server once connected; null otherwise. */
  readonly server = this._server.asReadonly();
  /** Seconds until the current PIN expires (0 when none / expired). */
  readonly expiresInSeconds = this._expiresInSeconds.asReadonly();
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

  /**
   * Stop polling and return to `idle`. Backs both the connect-page "Cancel"
   * affordance and the wizard step-4 "Skip for now" (which advances the step
   * signal separately, then calls this to stop any live poll/countdown).
   */
  cancel(): void {
    this.stopTimers();
    this.currentPinId = null;
    this.pinDeadlineMs = null;
    this._stage.set('idle');
    this._errorReason.set(null);
    this._code.set(null);
    this._expiresInSeconds.set(0);
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
        // Preferences.remove failing is unrecoverable here; the Settings
        // slice's self-heal will drop the orphaned token on the next load.
      }
      this.fail('network');
      return;
    }
    this._server.set(server);
    this._stage.set('connected');
    this._errorReason.set(null);
    this._expiresInSeconds.set(0);
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
