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

/** Preferences key for the on-device X-Plex-Token (NEVER in Firestore). */
export const PLEX_TOKEN_KEY = 'plex_token';

/** plex.tv PINs live ~15 minutes; seed the countdown to this at code issue.
 *  The merged `PlexPin` shared type carries no `expiresIn`, so the slice owns
 *  the link-window countdown locally (see README / spec note). */
const PIN_TTL_SECONDS = 15 * 60;

/** Poll interval for the PIN authorization check (ms). */
const POLL_INTERVAL_MS = 2000;

export type PlexLinkStage = 'idle' | 'code' | 'waiting' | 'connected' | 'error';

/**
 * Owns the plex.tv PIN-link state machine + on-device token persistence +
 * server discovery + the `hasPlex` / `plexSync` Firestore link metadata
 * (spec 0073, decision 2/10). A `providedIn: 'root'` singleton so the shell's
 * `PLEX_SYNC_TRIGGER` factory and both `SettingsPage` + `PlexConnectPage` share
 * ONE instance (the settings page must NOT re-provide it — that would fork the
 * link state).
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
   */
  async loadState(): Promise<void> {
    this._linked.set(await this.isLinked());
    const uid = this.uid();
    if (uid === null) {
      return;
    }
    const snap = await getDoc(doc(this.firestore, userPath(uid)));
    if (!snap.exists()) {
      return;
    }
    const meta = dataToUser(snap.data() as UserReadData).plexSync;
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
      this._stage.set('error');
    }
  }

  /** Request a brand-new PIN (on expiry or the "Get a new code" affordance). */
  regenerateCode(): Promise<void> {
    return this.requestCode();
  }

  /** Stop polling and return to `idle` (the "Cancel" affordance). */
  cancel(): void {
    this.stopTimers();
    this.currentPinId = null;
    this._stage.set('idle');
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
    await Preferences.remove({ key: PLEX_TOKEN_KEY });
    const uid = this.uid();
    if (uid !== null) {
      await updateDoc(doc(this.firestore, userPath(uid)), {
        plexSync: deleteField(),
      });
    }
    this._stage.set('idle');
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
    const tick = async (): Promise<void> => {
      if (this.currentPinId === null) {
        return;
      }
      try {
        const pin = await this.client.checkPin(this.currentPinId);
        if (pin.authToken !== null && pin.authToken.length > 0) {
          await this.completeLink(pin.authToken);
          return;
        }
      } catch {
        this.stopTimers();
        this._stage.set('error');
        return;
      }
      // Not yet authorized — schedule the next poll unless the code expired.
      if (this._expiresInSeconds() > 0 && this.currentPinId !== null) {
        this.pollTimer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
      }
    };
    // Kick the first check immediately.
    this.pollTimer = setTimeout(() => void tick(), 0);
  }

  /** Persist the token, discover the server, write link metadata, go connected. */
  private async completeLink(authToken: string): Promise<void> {
    this.stopTimers();
    this.currentPinId = null;
    // Persist the token ON-DEVICE only — never Firestore, never logged.
    await Preferences.set({ key: PLEX_TOKEN_KEY, value: authToken });
    const server = await this.client.discoverServer(authToken);
    if (server === null) {
      // No LOCAL/owned server found — surface the error stage (decision / Risks).
      this._stage.set('error');
      return;
    }
    this._server.set(server);
    const now = new Date().toISOString();
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
    this._stage.set('connected');
    this._expiresInSeconds.set(0);
    // Reflect the linked state on the settings card.
    this._linked.set(true);
    this._serverName.set(server.name);
    this._lastSyncAt.set(now);
  }

  private startCountdown(): void {
    this._expiresInSeconds.set(PIN_TTL_SECONDS);
    this.countdownTimer = setInterval(() => {
      const next = this._expiresInSeconds() - 1;
      if (next <= 0) {
        this._expiresInSeconds.set(0);
        this.stopTimers();
        this.currentPinId = null;
        // Expired with no authorization → error stage with "Get a new code".
        if (this._stage() !== 'connected') {
          this._stage.set('error');
        }
        return;
      }
      this._expiresInSeconds.set(next);
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
