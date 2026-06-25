// Cross-scope DI tokens (PLAN §3). These let a `scope:mobile` slice obtain a
// value provided by the shell (`apps/mobile`) WITHOUT importing `apps/mobile`
// directly — a `slice:*` lib may import `scope:shared` (this file) but not the
// shell, so the shell provides the token and the slice injects it. No runtime
// logic, no Firebase import.

import { InjectionToken, type Signal } from '@angular/core';

/**
 * The resolved Firebase auth uid, or `null` before the anonymous session
 * resolves. Provided at the app root by `apps/mobile` (the shell's
 * `ShellAuthService.uid` signal); injected by slices that key Firestore reads
 * on the current user (e.g. `slice:settings`'s `users/{uid}` access).
 *
 * Slices MUST inject this token rather than importing `ShellAuthService` from
 * `apps/mobile` — that import would create a forbidden Sheriff edge
 * (`slice:settings` → `scope:mobile`).
 */
export const AUTH_UID = new InjectionToken<Signal<string | null>>('AUTH_UID');

/**
 * A thunk that triggers a manual sync of the current user's watchlist via the
 * `triggerSync` callable and resolves with the server's syncedAt ISO string.
 * Provided by the shell (`apps/mobile`) so slices can trigger a sync WITHOUT
 * importing `@angular/fire/functions` or `apps/mobile` directly — mirroring the
 * AUTH_UID pattern (spec 0025).
 */
export const TRIGGER_SYNC = new InjectionToken<
  () => Promise<{ syncedAt: string }>
>('TRIGGER_SYNC');
