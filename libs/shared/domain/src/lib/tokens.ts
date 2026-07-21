// Cross-scope DI tokens (PLAN §3). These let a `scope:mobile` slice obtain a
// value provided by the shell (`apps/mobile`) WITHOUT importing `apps/mobile`
// directly — a `slice:*` lib may import `scope:shared` (this file) but not the
// shell, so the shell provides the token and the slice injects it. No runtime
// logic, no Firebase import.

import { InjectionToken, type Signal } from '@angular/core';

import type { Region } from './enums';
import type { CatalogProvider } from './entities';
import type { PlexClient } from './plex';

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

/** A thunk that fetches the region's TMDB watch-provider catalog via the
 *  `getWatchProviders` callable. Provided by the shell (apps/mobile) so the
 *  settings slice can call it WITHOUT importing @angular/fire/functions or
 *  apps/mobile — mirrors TRIGGER_SYNC (spec 0025 / 0060). */
export const GET_WATCH_PROVIDERS = new InjectionToken<
  (region: Region) => Promise<CatalogProvider[]>
>('GET_WATCH_PROVIDERS');

/** The Plex client, provided by the shell (real CapacitorHttp on native; a
 *  deterministic mock on web/dev/e2e). scope:shared so the settings slice
 *  injects it without importing apps/mobile. (spec 0073) */
export const PLEX_CLIENT = new InjectionToken<PlexClient>('PLEX_CLIENT');

/** A thunk the shell calls on boot + resume to run one Plex sync (no-op when
 *  not linked / not native / already running). scope:shared so the shell wires
 *  it over the settings slice's PlexSyncService without importing the slice
 *  the wrong way. (spec 0073) */
export const PLEX_SYNC_TRIGGER = new InjectionToken<() => Promise<void>>(
  'PLEX_SYNC_TRIGGER',
);

/** A thunk the shell calls once on boot to initialize periodic on-device
 *  background Plex sync (Android WorkManager via
 *  @transistorsoft/capacitor-background-fetch). No-op when not native / not
 *  linked. scope:shared so the shell wires it over the settings slice's
 *  PlexBackgroundService without importing the slice the wrong way — mirrors
 *  PLEX_SYNC_TRIGGER (spec 0073 / 0085). */
export const PLEX_BACKGROUND_INIT = new InjectionToken<() => Promise<void>>(
  'PLEX_BACKGROUND_INIT',
);
