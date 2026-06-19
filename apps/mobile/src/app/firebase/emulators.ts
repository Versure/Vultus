import type { Auth } from '@angular/fire/auth';
import type { Firestore } from '@angular/fire/firestore';

/** The subset of `environment` this helper inspects to decide on emulators. */
export interface EmulatorEnv {
  production: boolean;
  useEmulators: boolean;
}

/**
 * The AngularFire connector fns, injected so the spec can mock the gating
 * without pulling in the AngularFire runtime (rxfire ships ESM that the Vitest
 * CJS transform chokes on). Typed structurally to match
 * `connectAuthEmulator` / `connectFirestoreEmulator`.
 */
export interface EmulatorConnectors {
  connectAuth: (
    auth: Auth,
    url: string,
    options?: { disableWarnings: boolean },
  ) => void;
  connectFirestore: (firestore: Firestore, host: string, port: number) => void;
}

/** Auth emulator endpoint (firebase.json: Auth on 9099). */
export const AUTH_EMULATOR_URL = 'http://localhost:9099';
/** Firestore emulator endpoint (firebase.json: Firestore on 8080). */
export const FIRESTORE_EMULATOR_HOST = 'localhost';
export const FIRESTORE_EMULATOR_PORT = 8080;

/**
 * Connect AngularFire `Auth` / `Firestore` to the local emulators, but ONLY in
 * dev (`!production && useEmulators`). When disabled it touches neither
 * connector. The connectors are passed in (app.config.ts supplies the real
 * AngularFire fns) so the spec asserts the gating without a live Firebase
 * (spec 0010 Test plan).
 *
 * This is the single tested code path used by `provideAuth` in app.config.ts,
 * so the "connect only when useEmulators" branch is covered.
 */
export function connectEmulatorsIfEnabled(
  env: EmulatorEnv,
  auth: Auth,
  firestore: Firestore,
  connectors: EmulatorConnectors,
): void {
  if (env.production || !env.useEmulators) {
    return;
  }
  connectors.connectAuth(auth, AUTH_EMULATOR_URL, { disableWarnings: true });
  connectors.connectFirestore(
    firestore,
    FIRESTORE_EMULATOR_HOST,
    FIRESTORE_EMULATOR_PORT,
  );
}
