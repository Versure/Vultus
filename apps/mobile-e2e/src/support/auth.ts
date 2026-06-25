/**
 * Anon uid resolution (spec 0019 — R3, prescribed default (a)).
 *
 * The app boots a FRESH anonymous Firebase session, so its uid is
 * non-deterministic and must be read from the running page before seeding the
 * matching `users/{uid}/...` docs. The uid is NOT in the DOM (it lives behind the
 * `AUTH_UID` DI token as an Angular signal), so we read it from the Firebase Auth
 * SDK's own IndexedDB persistence.
 *
 * The Firebase JS SDK (`browserLocalPersistence` / its IndexedDB variant)
 * persists the current user under the IndexedDB database `firebaseLocalStorageDb`,
 * object store `firebaseLocalStorage`, in a record whose `fbase_key` matches
 * `firebase:authUser:<apiKey>:<appName>` and whose `value` is the serialized
 * user (containing `.uid`). We read that record via `page.evaluate`.
 *
 * Chosen over the fixed-account-import fallback because it is deterministic
 * without Auth-import fragility (spec 0019 Fixed test uid, default (a)).
 */
import type { Page } from '@playwright/test';

/** IndexedDB database/store the Firebase Auth SDK writes its current user to. */
const AUTH_DB = 'firebaseLocalStorageDb';
const AUTH_STORE = 'firebaseLocalStorage';

/**
 * Wait for the app's anonymous sign-in to settle and return the resolved uid.
 *
 * Uses `page.waitForFunction` to poll the Firebase Auth IndexedDB persistence
 * (browser-side) until a uid is present — the SDK writes it once
 * `signInAnonymously` resolves against the emulator. `waitForFunction` keeps
 * re-running the predicate while it returns a falsy value (no record yet) and
 * resolves once it returns the uid string. This is the Playwright-blessed poll
 * (no `waitForTimeout`): there is no DOM element to await on, since the uid is
 * never surfaced to the DOM. Throws if no uid appears within `timeoutMs` (a real
 * failure: emulator unreachable or the app never signed in — surfacing it beats
 * seeding under a wrong/empty uid).
 */
export async function resolveAnonUid(
  page: Page,
  timeoutMs = 15000,
): Promise<string> {
  const uid = await page
    .waitForFunction(
      ({ dbName, storeName }) =>
        new Promise<string | null>((resolve) => {
          let openReq: IDBOpenDBRequest;
          try {
            openReq = indexedDB.open(dbName);
          } catch {
            resolve(null);
            return;
          }
          openReq.onerror = () => resolve(null);
          openReq.onsuccess = () => {
            const db = openReq.result;
            if (!db.objectStoreNames.contains(storeName)) {
              db.close();
              resolve(null);
              return;
            }
            let getAllReq: IDBRequest;
            try {
              getAllReq = db
                .transaction(storeName, 'readonly')
                .objectStore(storeName)
                .getAll();
            } catch {
              db.close();
              resolve(null);
              return;
            }
            getAllReq.onerror = () => {
              db.close();
              resolve(null);
            };
            getAllReq.onsuccess = () => {
              const records = (getAllReq.result ?? []) as {
                fbase_key?: string;
                value?: { uid?: string };
              }[];
              db.close();
              const authRecord = records.find(
                (r) =>
                  typeof r?.fbase_key === 'string' &&
                  r.fbase_key.startsWith('firebase:authUser:') &&
                  typeof r?.value?.uid === 'string',
              );
              resolve(authRecord?.value?.uid ?? null);
            };
          };
        }),
      { dbName: AUTH_DB, storeName: AUTH_STORE },
      { timeout: timeoutMs, polling: 250 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => {
      throw new Error(
        'resolveAnonUid: no anonymous uid found in Firebase Auth IndexedDB within ' +
          `${timeoutMs}ms. Are the Auth (9099) / Firestore (8080) emulators running ` +
          'on the default ports (Emulator-port invariant)?',
      );
    });
  if (!uid)
    throw new Error('resolveAnonUid: waitForFunction resolved with falsy uid');
  return uid;
}
