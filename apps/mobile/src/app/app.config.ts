import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  signal,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { initializeApp, provideFirebaseApp } from '@angular/fire/app';
import { connectAuthEmulator, getAuth, provideAuth } from '@angular/fire/auth';
import {
  connectFirestoreEmulator,
  getFirestore,
  provideFirestore,
} from '@angular/fire/firestore';
import {
  Functions,
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable,
  provideFunctions,
} from '@angular/fire/functions';
import {
  AUTH_UID,
  GET_WATCH_PROVIDERS,
  TRIGGER_SYNC,
} from '@vultus/shared/domain/tokens';
import type { CatalogProvider, Region } from '@vultus/shared/domain';
import { TMDB_SEARCH_CONFIG } from '@vultus/mobile/search';
import { TMDB_DETAIL_CONFIG } from '@vultus/mobile/title-detail';
import { appRoutes } from './app.routes';
import { environment } from '../environments/environment';
import {
  connectAuthEmulatorIfEnabled,
  connectFirestoreEmulatorIfEnabled,
  connectFunctionsEmulatorIfEnabled,
} from './firebase/emulators';
import { ShellAuthService } from './auth/auth.service';

/**
 * AngularFire DI contract (spec 0010, decision 1) — the data-access pattern
 * every later mobile slice follows. Slices INJECT `Auth` / `Firestore`; they do
 * NOT call `initializeApp` again. Each provider factory gates its own emulator
 * connection through the unit-tested `connect*EmulatorIfEnabled` helpers.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideIonicAngular(),
    provideRouter(appRoutes),
    provideFirebaseApp(() => initializeApp(environment.firebase)),
    provideAuth(() => {
      const auth = getAuth();
      connectAuthEmulatorIfEnabled(environment, auth, connectAuthEmulator);
      return auth;
    }),
    provideFirestore(() => {
      const firestore = getFirestore();
      connectFirestoreEmulatorIfEnabled(
        environment,
        firestore,
        connectFirestoreEmulator,
      );
      return firestore;
    }),
    // Wire AngularFire Functions with the europe-west1 region to match
    // setGlobalOptions in apps/functions main.ts (region mismatch 404s silently).
    provideFunctions(() => {
      const fns = getFunctions(undefined, 'europe-west1');
      connectFunctionsEmulatorIfEnabled(
        environment,
        fns,
        connectFunctionsEmulator,
      );
      return fns;
    }),
    // Gate render on the resolved anonymous session (decision 3). CRITICAL:
    // degrade gracefully — under the no-emulator dev server (e2e smoke) there
    // is no Auth backend, so signInAnonymously rejects. Swallow the failure so
    // bootstrap completes and the tabs render even when sign-in cannot finish;
    // the full auth-gated boot is asserted later against the emulators
    // (PLAN §6 item 20).
    provideAppInitializer(async () => {
      try {
        await inject(ShellAuthService).ensureSignedIn();
      } catch {
        // Intentionally non-fatal — see comment above. Render proceeds.
      }
    }),
    // Expose the shell's uid signal to slices via a scope:shared token, so a
    // slice:* lib can read the current uid WITHOUT importing apps/mobile (which
    // Sheriff forbids). See @vultus/shared/domain AUTH_UID.
    // In mock mode, environment.mockAuthUid is a fixture uid that bypasses real
    // Firebase Auth so Firestore writes work without a running auth emulator.
    {
      provide: AUTH_UID,
      useFactory: () =>
        environment.mockAuthUid
          ? signal<string | null>(environment.mockAuthUid)
          : inject(ShellAuthService).uid,
    },
    // Provide the triggerSync thunk as a scope:shared token so the watchlist
    // slice can call it without importing @angular/fire/functions or apps/mobile
    // (mirrors the AUTH_UID pattern — spec 0025).
    {
      provide: TRIGGER_SYNC,
      useFactory: () => {
        const fns = inject(Functions);
        const callable = httpsCallable<unknown, { syncedAt: string }>(
          fns,
          'triggerSync',
        );
        return () => callable().then((r) => r.data);
      },
    },
    // Provide the getWatchProviders thunk as a scope:shared token so the
    // settings slice can fetch the region's provider catalog without importing
    // @angular/fire/functions or apps/mobile (mirrors TRIGGER_SYNC — spec 0060).
    // The callable's request/response are typed inline (structurally) rather
    // than importing GetWatchProvidersRequest/Response from apps/functions —
    // the shell is scope:mobile and cannot import a scope:functions project.
    {
      provide: GET_WATCH_PROVIDERS,
      useFactory: () => {
        const fns = inject(Functions);
        const callable = httpsCallable<
          { region: Region },
          { providers: CatalogProvider[] }
        >(fns, 'getWatchProviders');
        return (region: Region) =>
          callable({ region }).then((r) => r.data.providers);
      },
    },
    // TMDB search config (spec 0013) — provided at root from `environment.tmdb`
    // so the search slice can inject it without importing apps/mobile.
    { provide: TMDB_SEARCH_CONFIG, useValue: environment.tmdb },
    // TMDB detail config (spec 0016, 0036) — same `environment.tmdb` base but
    // with `imageBaseUrl` swapped to the larger detail base (w780) so the
    // 530px detail hero renders sharp instead of upscaling w185. Search stays
    // on w185 above. A separate token preserves slice isolation (the detail
    // slice never imports the search slice's token).
    {
      provide: TMDB_DETAIL_CONFIG,
      useValue: {
        ...environment.tmdb,
        imageBaseUrl: environment.tmdb.detailImageBaseUrl,
      },
    },
  ],
};
