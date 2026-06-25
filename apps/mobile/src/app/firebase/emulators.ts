import type { Auth } from '@angular/fire/auth';
import type { Firestore } from '@angular/fire/firestore';
import type { Functions } from '@angular/fire/functions';

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
export type ConnectAuthFn = (
  auth: Auth,
  url: string,
  options?: { disableWarnings: boolean },
) => void;
export type ConnectFirestoreFn = (
  firestore: Firestore,
  host: string,
  port: number,
) => void;
export type ConnectFunctionsFn = (
  fns: Functions,
  host: string,
  port: number,
) => void;

/** Auth emulator endpoint (firebase.json: Auth on 9099). */
export const AUTH_EMULATOR_URL = 'http://localhost:9099';
/** Firestore emulator endpoint (firebase.json: Firestore on 8080). */
export const FIRESTORE_EMULATOR_HOST = 'localhost';
export const FIRESTORE_EMULATOR_PORT = 8080;
/** Functions emulator endpoint (firebase.json: Functions on 5001). */
export const FUNCTIONS_EMULATOR_HOST = 'localhost';
export const FUNCTIONS_EMULATOR_PORT = 5001;

/** Whether emulators should be wired (dev only): `!production && useEmulators`. */
function emulatorsEnabled(env: EmulatorEnv): boolean {
  return !env.production && env.useEmulators;
}

/**
 * Connect AngularFire `Auth` to the local emulator, but ONLY in dev
 * (`!production && useEmulators`); otherwise a no-op. The connector is passed
 * in (app.config.ts supplies the real AngularFire fn) so the spec asserts the
 * gating without a live Firebase (spec 0010 Test plan). Lives in the
 * `provideAuth` factory, next to the instance it gates.
 */
export function connectAuthEmulatorIfEnabled(
  env: EmulatorEnv,
  auth: Auth,
  connectAuth: ConnectAuthFn,
): void {
  if (!emulatorsEnabled(env)) {
    return;
  }
  connectAuth(auth, AUTH_EMULATOR_URL, { disableWarnings: true });
}

/**
 * Connect AngularFire `Firestore` to the local emulator, but ONLY in dev
 * (`!production && useEmulators`); otherwise a no-op. Lives in the
 * `provideFirestore` factory, next to the instance it gates — mirroring
 * `connectAuthEmulatorIfEnabled` (spec 0010 Test plan).
 */
export function connectFirestoreEmulatorIfEnabled(
  env: EmulatorEnv,
  firestore: Firestore,
  connectFirestore: ConnectFirestoreFn,
): void {
  if (!emulatorsEnabled(env)) {
    return;
  }
  connectFirestore(firestore, FIRESTORE_EMULATOR_HOST, FIRESTORE_EMULATOR_PORT);
}

/**
 * Connect AngularFire `Functions` to the local emulator, but ONLY in dev
 * (`!production && useEmulators`); otherwise a no-op. Lives in the
 * `provideFunctions` factory, next to the instance it gates — mirroring
 * `connectFirestoreEmulatorIfEnabled` (spec 0025 Test plan).
 */
export function connectFunctionsEmulatorIfEnabled(
  env: EmulatorEnv,
  fns: Functions,
  connectFunctions: ConnectFunctionsFn,
): void {
  if (!emulatorsEnabled(env)) {
    return;
  }
  connectFunctions(fns, FUNCTIONS_EMULATOR_HOST, FUNCTIONS_EMULATOR_PORT);
}
