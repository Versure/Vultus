# mobile-e2e

Playwright end-to-end suite for `apps/mobile` (spec 0019). It boots the
web-served app against the **Firebase Auth + Firestore emulators**, drives the
critical user flows, and is wired into CI as `nx affected -t e2e`.

- **chromium-only** — the only ship target is Android WebView (Capacitor), so
  chromium is the closest single proxy; firefox/webkit add CI time, not fidelity
  (R6).
- **No secret, no live network.** Every TMDB call is intercepted with committed
  fixtures (`page.route`); the emulators need no credentials. The suite needs no
  `TMDB_API_KEY` and no Firebase service account (€0 / no-secret invariant).

## Running locally

Prerequisites:

- **Java** (the Firestore/Auth emulators are Java processes).
- **Firebase CLI** (`pnpm exec firebase`), already a dev dependency.

Run the suite (this wraps the run in the emulators automatically via the same
command CI uses):

```sh
pnpm exec firebase emulators:exec --only firestore,auth --project vultus-cab62 "pnpm nx e2e mobile-e2e"
```

Or, if you already have the emulators running on the default ports, just:

```sh
pnpm nx e2e mobile-e2e
```

Interactive (Playwright UI):

```sh
pnpm nx open mobile-e2e
```

### Emulator-port invariant

The run **must** use the default Firebase emulator ports — **Firestore 8080,
Auth 9099**. The browser app (`apps/mobile/src/app/firebase/emulators.ts`)
**hardcodes** those endpoints and cannot read env vars, so a non-default port
would make the app silently miss the emulator with no error. Keep `firebase.json`
on 8080/9099 and do not pass per-run port overrides. (`firebase.json` already
has Auth 9099 + Firestore 8080 — no change was needed for this spec.)

The Node-side `globalSetup` / support helpers read `FIRESTORE_EMULATOR_HOST` /
`FIREBASE_AUTH_EMULATOR_HOST` (exported by `emulators:exec`) and fall back to
`localhost:8080` / `localhost:9099`.

## Layout

- `playwright.config.ts` — chromium-only, `baseURL` `http://localhost:4200`,
  `nx run mobile:serve` web server, `globalSetup`, CI retries + trace.
- `global-setup.ts` — clears the emulators once before the run.
- `src/support/` — the test toolkit (see below); imports **no workspace
  source** (black-box: DOM + emulator REST only).
- `emulator-data/{empty,seeded}/docs.json` — committed **plain domain JSON**
  describing the docs to seed. `{uid}` in a doc path is substituted at seed time
  with the resolved anon uid. The encoder (`src/support/encode.ts`) converts
  these to the Firestore REST typed-value format on write — we do **not** commit
  pre-encoded REST payloads.
  - `empty/` — the `users/{uid}` profile doc, no watchlist entries (F1–F3).
  - `seeded/` — same profile doc + one **TV** watchlist entry (Breaking Bad,
    tmdbId 2, status `planned`) (F4–F8).
- `fixtures/tmdb-search-*.json` — committed TMDB `search/multi` responses for
  `page.route('**/api.themoviedb.org/**')` (one movie + one tv result).

## Seed mechanism & test uid

Between tests the suite does a **REST clear + load**: clear Auth + Firestore via
the emulator clear endpoints, then write the chosen fixture's docs via the
Firestore REST `documents` API. (`--import` only re-seeds at emulator _start_;
restarting per test is too slow — so REST clear+load is the runtime path.)

**uid resolution (R3): IndexedDB read (the prescribed default, option (a)).**
The app boots a fresh anonymous session whose uid is non-deterministic and is
**not** in the DOM (it lives behind the `AUTH_UID` DI token). `resolveAnonUid`
reads the uid the Firebase Auth SDK persists to IndexedDB
(`firebaseLocalStorageDb` → `firebaseLocalStorage`, the
`firebase:authUser:*` record's `.uid`) after sign-in settles. The seed helpers
take that uid as a parameter, so seeding happens **after** boot under the real
uid — a seeded doc under a mismatched uid would silently render an empty
watchlist (owner mismatch). The documented fallback (importing a fixed anon Auth
account) is **not** used here.

### Support API (consumed by the flow specs)

```ts
import {
  resolveAnonUid, // (page, timeoutMs?) => Promise<string>
  resetAndSeed, // (uid, 'empty' | 'seeded') => Promise<void>  (clears Auth+Firestore, then seeds)
  seedFor, // (uid, 'empty' | 'seeded') => Promise<void>  (seeds WITHOUT clearing Auth — use post-boot)
  clearAll, // () => Promise<void>
  routeTmdb, // (page, fixtureName?='tmdb-search-multi.json') => Promise<unknown>
  // plus low-level: clearFirestore, clearAuth, writeDocument, encodeFields, firestoreHost, authHost, PROJECT_ID
} from '../support';
```

(`src/support.ts` is a plain re-export **file**, not a barrel `index.ts` — under
Sheriff's barrel-less mode an index would make `src/support/` its own module and
trip a dependency rule against the prefix-matched `apps/mobile` tag.)

Typical spec setup: `goto('/')` → `resolveAnonUid(page)` → `seedFor(uid,
'seeded')` (Auth not cleared, to preserve the live session) → reload/navigate →
assert. For `empty` flows, seed the profile doc the same way (or run with no
watchlist docs at all).

## Emulator-loopback caveat (project memory)

Per project memory, the **Firestore/Auth emulators cannot run via Claude Code's
tools** here (loopback blocked). The implementing agent therefore **cannot**
execute the full emulator-backed e2e in-session — config/lint/typecheck and the
spec authoring are verified, and the **emulator-backed run is validated in CI and
in the user's own terminal** (same posture as specs 0004/0009). A green
typecheck/lint does **not** prove the flows pass against the emulators.
