/**
 * Playwright globalSetup (spec 0019).
 *
 * Runs ONCE before the suite, in the Node process. Clears Auth + Firestore on
 * the emulators so the run starts from a known-empty state. Per-test seeding (the
 * `empty` / `seeded` fixtures under the resolved anon uid) happens in each spec's
 * `beforeEach` via `resetAndSeed` / `seedFor`, because the uid is only known
 * AFTER the app boots (R3).
 *
 * The emulator endpoints come from `FIRESTORE_EMULATOR_HOST` /
 * `FIREBASE_AUTH_EMULATOR_HOST` (exported by `firebase emulators:exec`), falling
 * back to the default 8080/9099 for a local run against already-running
 * emulators (Emulator-port invariant). NO secret, NO live network.
 */
import { clearAll } from './src/support/seed';
import { authHost, firestoreHost } from './src/support/emulator';

export default async function globalSetup(): Promise<void> {
  // Surfacing the resolved endpoints helps diagnose a port mismatch (the browser
  // app hardcodes 8080/9099 and would silently miss a non-default emulator).
  console.log(
    `[e2e globalSetup] Firestore=${firestoreHost()} Auth=${authHost()} — clearing emulator state`,
  );
  try {
    await clearAll();
  } catch (err) {
    throw new Error(
      `[e2e globalSetup] Could not reach the Firebase emulators. Ensure the run ` +
        `is wrapped in \`firebase emulators:exec --only firestore,auth\` (CI) or ` +
        `that emulators are running on the default ports 8080/9099 locally.\n` +
        `Underlying error: ${(err as Error).message}`,
    );
  }
}
