import { Injectable, inject, signal, type Signal } from '@angular/core';
import { Auth, authState, signInAnonymously } from '@angular/fire/auth';

/**
 * Shell auth service (spec 0010, decision 3).
 *
 * Establishes the anonymous Firebase Auth SESSION on first launch and exposes
 * the resolved uid to slices via a signal. The `provideAppInitializer` in
 * app.config.ts calls `ensureSignedIn()` so render is gated on the resolved
 * session.
 *
 * GUARDRAIL: this service writes NO Firestore document. The `users/{uid}` doc
 * (region / notificationPrefs / fcmTokens — PLAN §4) is owned and created by
 * the settings slice (PLAN §6 item 16), NOT the shell. The shell only creates
 * the anon session and exposes the uid.
 */
@Injectable({ providedIn: 'root' })
export class ShellAuthService {
  private readonly auth = inject(Auth);

  private readonly _uid = signal<string | null>(null);

  /** Resolved anonymous (later: real) Firebase uid, or null before sign-in. */
  readonly uid: Signal<string | null> = this._uid.asReadonly();

  constructor() {
    // Keep the signal fresh across the session (e.g. token refresh / sign-out).
    authState(this.auth).subscribe((user) => this._uid.set(user?.uid ?? null));
  }

  /**
   * Ensures an anonymous session exists; resolves with the uid once known.
   * On rejection the error propagates (the caller decides how to degrade) and
   * no stale uid is exposed — the signal only advances on a resolved session.
   */
  async ensureSignedIn(): Promise<string> {
    const credential = await signInAnonymously(this.auth);
    const uid = credential.user.uid;
    this._uid.set(uid);
    return uid;
  }
}
