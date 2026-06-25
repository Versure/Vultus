/**
 * Emulator endpoint resolution + REST clear/seed primitives (spec 0019).
 *
 * NODE-SIDE ONLY. These helpers run in the Playwright Node process
 * (`globalSetup` / `beforeEach`), never in the browser. They read
 * `FIRESTORE_EMULATOR_HOST` / `FIREBASE_AUTH_EMULATOR_HOST` (exported by
 * `firebase emulators:exec`) and fall back to the Firebase default ports for a
 * local run against already-running emulators.
 *
 * The browser app does NOT read these env vars — it connects to the HARDCODED
 * `localhost:9099` / `localhost:8080` endpoints in
 * `apps/mobile/src/app/firebase/emulators.ts`. The suite only works because
 * `emulators:exec` binds those same default ports (Emulator-port invariant,
 * spec 0019).
 */

/** Firebase project id the emulators serve (firebase.json / environment.ts). */
export const PROJECT_ID = 'vultus-cab62';

/** Firestore emulator host:port (env from emulators:exec, default 8080). */
export function firestoreHost(): string {
  return process.env.FIRESTORE_EMULATOR_HOST ?? 'localhost:8080';
}

/** Auth emulator host:port (env from emulators:exec, default 9099). */
export function authHost(): string {
  return process.env.FIREBASE_AUTH_EMULATOR_HOST ?? 'localhost:9099';
}

/** Base path for the Firestore REST `documents` API on the emulator. */
function firestoreDocumentsBase(): string {
  return `http://${firestoreHost()}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
}

/**
 * Clear ALL Firestore documents for the project via the emulator clear
 * endpoint. No restart — fast, deterministic reset between tests.
 */
export async function clearFirestore(): Promise<void> {
  const url = `http://${firestoreHost()}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(
      `Firestore clear failed: ${res.status} ${await res.text()} (${url})`,
    );
  }
}

/** Clear ALL Auth accounts for the project via the emulator clear endpoint. */
export async function clearAuth(): Promise<void> {
  const url = `http://${authHost()}/emulator/v1/projects/${PROJECT_ID}/accounts`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(
      `Auth clear failed: ${res.status} ${await res.text()} (${url})`,
    );
  }
}

/**
 * Read a single document from Firestore via the emulator REST `documents` API.
 *
 * Returns the raw Firestore REST response `fields` map (Firestore typed-value
 * objects), or `null` if the document doesn't exist (404). Use `encodeFields` /
 * `encodeValue` from `encode.ts` for writes; for reads, pick the scalar values
 * from the typed-value wrappers directly, e.g.
 * `fields.region.stringValue as string`.
 */
export async function readDocument(
  path: string,
): Promise<Record<string, unknown> | null> {
  const url = `${firestoreDocumentsBase()}/${path}`;
  const res = await fetch(url, {
    headers: { Authorization: 'Bearer owner' },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      `Firestore read failed for ${path}: ${res.status} ${await res.text()}`,
    );
  }
  const body = (await res.json()) as { fields?: Record<string, unknown> };
  return body.fields ?? null;
}

/**
 * Write a single document to Firestore via the emulator REST `documents` API.
 *
 * `path` is the document path RELATIVE to the documents root, e.g.
 * `users/abc123` or `users/abc123/watchlist/2`. `fields` is the already-encoded
 * Firestore typed-value map (see `encode.ts`). Uses a PATCH so an explicit
 * document id (the final path segment) is honoured (REST `createDocument` would
 * otherwise require splitting collection + id).
 */
export async function writeDocument(
  path: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const url = `${firestoreDocumentsBase()}/${path}`;
  const res = await fetch(url, {
    method: 'PATCH',
    // 'Bearer owner' is the Firestore emulator's admin bypass token — identical to
    // the mechanism used by @firebase/rules-unit-testing. The emulator grants admin
    // access and skips security rules when this token is present, allowing seed
    // writes to owner-locked collections (users/{uid}/watchlist) without a real JWT.
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer owner',
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    throw new Error(
      `Firestore write failed for ${path}: ${res.status} ${await res.text()}`,
    );
  }
}
