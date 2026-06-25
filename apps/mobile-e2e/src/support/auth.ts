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
 * Two-step implementation to avoid a JSHandle serialization race:
 *
 *  1. `waitForFunction` polls until a uid IS present (returns boolean — polling
 *     only, no value retrieval). Using a plain boolean avoids the window where
 *     `handle.jsonValue()` can return null after `waitForFunction` resolves with
 *     a truthy string value (observed in Playwright timing races).
 *
 *  2. `page.evaluate` reads the uid atomically once the wait has settled. A
 *     direct evaluate call is serialized in a single browser tick and cannot race
 *     against the `waitForFunction` → `jsonValue()` gap.
 *
 * Throws if no uid appears within `timeoutMs` (a real failure: emulator
 * unreachable or the app never signed in — surfacing it beats seeding under a
 * wrong/empty uid).
 */
export async function resolveAnonUid(
  page: Page,
  timeoutMs = 15000,
): Promise<string> {
  const idbArgs = { dbName: AUTH_DB, storeName: AUTH_STORE };

  // Step 1 — poll until an auth record with a uid appears; return boolean only.
  await page
    .waitForFunction(
      ({ dbName, storeName }) =>
        new Promise<boolean>((resolve) => {
          let openReq: IDBOpenDBRequest;
          try {
            openReq = indexedDB.open(dbName);
          } catch {
            resolve(false);
            return;
          }
          openReq.onerror = () => resolve(false);
          openReq.onsuccess = () => {
            const db = openReq.result;
            if (!db.objectStoreNames.contains(storeName)) {
              db.close();
              resolve(false);
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
              resolve(false);
              return;
            }
            getAllReq.onerror = () => {
              db.close();
              resolve(false);
            };
            getAllReq.onsuccess = () => {
              const records = (getAllReq.result ?? []) as {
                fbase_key?: string;
                value?: { uid?: string };
              }[];
              db.close();
              const found = records.some(
                (r) =>
                  typeof r?.fbase_key === 'string' &&
                  r.fbase_key.startsWith('firebase:authUser:') &&
                  typeof r?.value?.uid === 'string' &&
                  r.value.uid.length > 0,
              );
              resolve(found);
            };
          };
        }),
      idbArgs,
      { timeout: timeoutMs, polling: 250 },
    )
    .catch(() => {
      throw new Error(
        'resolveAnonUid: no anonymous auth record in Firebase Auth IndexedDB within ' +
          `${timeoutMs}ms. Are the Auth (9099) / Firestore (8080) emulators running ` +
          'on the default ports (Emulator-port invariant)?',
      );
    });

  // Step 2 — read the uid via a fresh page.evaluate (avoids the JSHandle
  // serialization window between waitForFunction resolving and jsonValue() being
  // called — the evaluate runs atomically in a single browser tick).
  const uid = await page.evaluate(
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
                typeof r?.value?.uid === 'string' &&
                r.value.uid.length > 0,
            );
            resolve(authRecord?.value?.uid ?? null);
          };
        };
      }),
    idbArgs,
  );

  if (!uid)
    throw new Error(
      'resolveAnonUid: uid absent immediately after wait settled — auth record ' +
        'cleared between waitForFunction and evaluate. Verify the Auth emulator ' +
        '(9099) is still running and not clearing accounts mid-test.',
    );
  return uid;
}
