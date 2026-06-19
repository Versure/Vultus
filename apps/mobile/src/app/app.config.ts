import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
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
import { appRoutes } from './app.routes';
import { environment } from '../environments/environment';
import {
  connectAuthEmulatorIfEnabled,
  connectFirestoreEmulatorIfEnabled,
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
  ],
};
