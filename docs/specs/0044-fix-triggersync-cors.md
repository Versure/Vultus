---
number: 0044
slug: fix-triggersync-cors
title: Add explicit CORS origins to the triggerSync Gen2 callable so browser-origin invocations are not preflight-blocked
status: approved
slices: []
scopes: [scope:functions]
created: 2026-06-29
---

# Add explicit CORS origins to the triggerSync Gen2 callable so browser-origin invocations are not preflight-blocked

## 1. Context

The manual-sync feature (spec 0025, `done`) wired the watchlist toolbar refresh
button to a `scope:shared` `TRIGGER_SYNC` token that calls the Gen2 `triggerSync`
callable via AngularFire `httpsCallable` (`apps/mobile/src/app/app.config.ts`
line 105, on a `Functions` instance pinned to `europe-west1`). The `triggerSync`
`onCall` Cloud Function lives in `apps/functions/src/main.ts` (currently around
line 304) and self-authenticates from the verified Firebase Auth context
(`request.auth?.uid`).

When the app calls `triggerSync` from a **browser / WebView origin** —
`http://localhost:4200` in dev (the `mobile:serve-*` targets), the **production
Android app's Capacitor WebView origin `http://localhost`** (the Capacitor default —
no custom hostname/port is set in `capacitor.config.ts`), and the Firebase Hosting
domains (`https://vultus-cab62.web.app` / `https://vultus-cab62.firebaseapp.com`) in a
hosted web context — the browser/WebView first sends a **CORS preflight `OPTIONS`**
request. The current
`onCall` declaration passes only `{ secrets: [TMDB_READ_TOKEN] }` with **no `cors`
option**, so the function does **not** return an `Access-Control-Allow-Origin`
header on the preflight, and the browser blocks the fetch before the real call is
made:

```
Access to fetch at 'https://europe-west1-vultus-cab62.cloudfunctions.net/triggerSync'
from origin 'http://localhost:4200' has been blocked by CORS policy:
Response to preflight request doesn't pass access control check:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

**Root cause:** Gen2 `onCall` functions need an explicit `cors` option to emit the
CORS response headers for a browser-origin caller; without it the preflight has no
allowed origin and the request is rejected by the browser (the function is never
reached). This is **distinct from** spec 0021's Cloud-Run-IAM/GFE-403 (that was a
public-invokability problem on the `onRequest` `syncTitles` endpoint) and from spec
0033's `functions/not-found` (undeployed callable) — those are reachability/auth;
this is the **CORS preflight** of an otherwise-deployed, reachable callable.

The same CORS block is reported from the **installed production Android app** (the
Capacitor WebView), not only from `localhost:4200` — both fail identically because
neither origin is allowed by the function's (missing) CORS config. The fix must
unblock **both** the dev server **and** the installed Android app.

Intended outcome: the deployed `triggerSync` callable answers the preflight with the
correct `Access-Control-Allow-Origin` for the app's known origins, so the watchlist
refresh button's `httpsCallable` invocation completes (success → "Watchlist synced")
instead of being CORS-blocked — in the dev server **and** the installed Android app.
This is a **one-file, config-only `scope:functions` change** — the handler logic
(`runTriggerSync`) is untouched.

### Locked decisions (from the decision record — do NOT re-litigate)

1. **Add an explicit `cors` array** to the `triggerSync` `onCall` options object,
   listing the four known app origins:

   ```typescript
   export const triggerSync = onCall<unknown, Promise<TriggerSyncResponse>>(
     {
       secrets: [TMDB_READ_TOKEN],
       cors: [
         'https://vultus-cab62.web.app',
         'https://vultus-cab62.firebaseapp.com',
         'http://localhost', // Capacitor Android WebView (production native app)
         'http://localhost:4200', // Angular dev server (serve-prod-debug)
       ],
     },
     (request) => {
       /* unchanged */
     },
   );
   ```

   `http://localhost` (no port) is the **Capacitor Android WebView's default origin** —
   `capacitor.config.ts` sets no custom hostname/scheme, so the installed native app's
   WebView serves at `http://localhost`. It is **distinct** from the dev server's
   `http://localhost:4200` (CORS origins are matched including the port), so **both**
   must be listed for the dev server and the installed Android app to be unblocked.

   The handler body (`ensureAdmin`, the `createEngine` wiring, the
   `runTriggerSync({ db, createEngine }, request.auth?.uid)` call) is **unchanged** —
   only the options object gains a `cors` field.

2. **Only `apps/functions/src/main.ts` changes.** No mobile change, no shared library
   change, no Firestore schema/rules/index change. The mobile caller
   (`app.config.ts`) already targets `europe-west1` correctly and is left as-is.

3. **`syncTitles` is NOT touched.** It is an `onRequest` HTTP function invoked
   **only by the cron** (`daily-sync.yml`) and the CI smoke gate via `curl`/server —
   **never** from a browser `fetch`, so it has no CORS preflight to satisfy. Its
   public-invokability is governed by spec 0021's `allUsers` invoker grant, which is a
   separate concern. Do **not** add `cors` to `syncTitles`.

4. **Explicit origin allow-list, not a wildcard.** The four origins are the app's only
   legitimate browser/WebView origins (the two Firebase Hosting domains, the Capacitor
   Android WebView origin, and the dev serve origin). A `'*'`/`true` wildcard is
   rejected (over-broad for a callable that performs an authenticated user action) —
   pin the explicit list. If a future custom hosting domain or a changed Capacitor
   scheme/hostname is added, it is appended to this array (recorded in Risks).

## 2. Scope

In scope:

- **`scope:functions`:** add a `cors` array (the four pinned origins above) to the
  `triggerSync` `onCall` options object in `apps/functions/src/main.ts`. This is the
  **only** code edit.
- **Operational (a required task, not code):** run
  `pnpm nx run functions:deploy-preflight` (the CI deploy gate, CLAUDE.md) to validate
  the pruned functions bundle, then `/deploy-functions` to ship the CORS-enabled
  `triggerSync` to production; and a **functional verification on both surfaces** —
  the dev server (`mobile:serve-prod-debug`, browser origin `localhost:4200` against
  **real prod** Functions) **and** the installed Android app (`mobile:android-usb` /
  the production build on a device, WebView origin `http://localhost`) — confirming
  the refresh button no longer CORS-fails in either.

Out of scope (explicitly):

- **Any change to `runTriggerSync` / the handler logic, the gather flow, the engine
  wiring, the region, the secret binding, or the auth model.** Spec 0025's behaviour
  is the fixed input; only the `onCall` `cors` option is added.
- **Any change to `syncTitles`** (decision 3) — it is cron/server-invoked, not
  browser-called, and has no CORS preflight.
- **Any mobile / `scope:mobile` change.** The caller (`app.config.ts`) is correct and
  untouched. The emulator path (`mobile:serve-mock` / `mobile:serve-emulator`) routes
  through `connectFunctionsEmulator` (`app.config.ts` lines 65–69) and **bypasses
  CORS entirely** (same-origin to the local emulator), so it never exhibited the bug
  and needs no change.
- **Any shared library / `shared/domain` / `shared/firestore-schema` change** — no
  type, token, or converter changes.
- **`firestore.rules` / `firestore.indexes.json` / `firebase.json` /
  `sheriff.config.ts`** — none required; record "no change needed" in the PR.
- **Adding a wildcard CORS origin** (decision 4) — the explicit list is the contract.
- **Re-shaping the `TRIGGER_SYNC` token, `TriggerSyncResponse`, or the
  `httpsCallable` wiring** — unchanged.

## 3. Affected slices & Sheriff tags

| Project         | Path                         | Sheriff tags      | Change                                                              |
| --------------- | ---------------------------- | ----------------- | ------------------------------------------------------------------- |
| functions (app) | `apps/functions/src/main.ts` | `scope:functions` | **add** a `cors: [...]` array to the `triggerSync` `onCall` options |

- **`slices: []`** — this is a `scope:functions` config change touching only the
  functions entry file; it introduces no slice, library, or app-shell change.
- **No cross-scope / cross-slice import.** No new import is added (the `cors` array is
  a plain string-literal array on the existing options object; `onCall` is already
  imported from `firebase-functions/https`, `main.ts` line 17). `scope:functions`
  never imports `scope:mobile`, and this change adds no import edge at all.
- **No `sheriff.config.ts` change.** The `apps/functions` tag already exists
  (specs 0009/0025); verify by path glob — **do not edit `sheriff.config.ts`**.
- **Not a `shared/` extraction.** A per-function `cors` option is config, not
  extractable logic; the DRY/3+-slice rule is not engaged.

## 4. Data model touchpoints

**None.** This spec changes no Firestore collection, field, converter, security rule,
or index. The CORS option affects only the **preflight HTTP response headers** of the
`triggerSync` callable; the function's data access (read the caller's
`users/{uid}/watchlist`, write `title-cache/**` via the engine port — spec 0025) is
**unchanged**. Record "no `firestore.rules` / no `firestore.indexes.json` change" in
the PR.

## 5. Public types / APIs

**No new or changed public type, token, function signature, callable shape, or HTTP
contract.**

- `triggerSync` — still an `onCall<unknown, Promise<TriggerSyncResponse>>` returning
  `{ syncedAt: string }` on the verified-auth path and throwing
  `HttpsError('unauthenticated', 'Sign-in required')` when `request.auth?.uid` is
  absent. **Only the `onCall` options object gains `cors`.** The request/response
  payload, the auth model, and the region (`europe-west1` via `setGlobalOptions`,
  `main.ts` line 48) are unchanged.
- `TriggerSyncResponse`, `RunTriggerSyncDeps`, `runTriggerSync`, the `TRIGGER_SYNC`
  token, and the mobile `httpsCallable` wiring — all **unchanged**.

### The edit (the only code change)

In `apps/functions/src/main.ts`, on the `triggerSync` export (currently ~line 304),
add a `cors` field to the options object so it reads:

```typescript
export const triggerSync = onCall<unknown, Promise<TriggerSyncResponse>>(
  {
    secrets: [TMDB_READ_TOKEN],
    cors: [
      'https://vultus-cab62.web.app',
      'https://vultus-cab62.firebaseapp.com',
      'http://localhost', // Capacitor Android WebView (production native app)
      'http://localhost:4200', // Angular dev server (serve-prod-debug)
    ],
  },
  (request) => {
    const db = ensureAdmin();
    const createEngine = (firestore: Firestore): SyncEngine =>
      createSyncEngine({
        tmdb: createTmdbClient({ readAccessToken: TMDB_READ_TOKEN.value() }),
        trakt: createTraktClient({ clientId: TRAKT_CLIENT_ID.value() }),
        store: createFirestoreTitleCacheStore(firestore),
      });
    return runTriggerSync({ db, createEngine }, request.auth?.uid);
  },
);
```

- The four origins are the app's known browser/WebView origins: the two Firebase
  Hosting domains for `vultus-cab62`, the **Capacitor Android WebView origin
  `http://localhost`** (the installed production native app — Capacitor's default, no
  custom scheme/hostname in `capacitor.config.ts`), and the dev serve origin
  `http://localhost:4200` (the `mobile:serve-*` targets and the e2e web server).
  `http://localhost` and `http://localhost:4200` are **separate entries** — CORS
  matches the full origin including port, so both are required. `connectFunctionsEmulator`
  paths are same-origin to the local emulator and are unaffected.
- The handler arrow body is **byte-for-byte the same** as today (verified against
  `main.ts` lines 306–315) — do not refactor it while adding the option.
- **No new import** — `cors` is a plain option key supported by Gen2 `onCall`; do not
  add any `cors` package or middleware.

## 6. UI / Stitch screen refs

**Not applicable — backend/config change only.** This spec touches no markup, no
component template, no design token, and adds no on-screen element or copy. The
watchlist toolbar refresh button and its idle/syncing/cooldown states (spec 0025) are
unchanged; the only user-visible effect is that the existing button now **succeeds**
(success toast) instead of failing with a CORS-blocked error. **No Stitch screen needs
to be pulled** for this spec. (Stated explicitly so the absent UI section is not read
as an omission.)

## 7. Implementation task graph

Two tasks. The code edit is a single-file change; the deploy is the sequential
operational follow-on (and the real production fix).

### 1. [sequential] Add the `cors` array to the `triggerSync` `onCall` options

backend-engineer. `apps/functions`, `scope:functions`.

- Edit `apps/functions/src/main.ts`: add the four-origin `cors` array (decision 1 /
  §5) to the `triggerSync` `onCall` options object, alongside the existing
  `secrets: [TMDB_READ_TOKEN]`. **Do not touch the handler body** or any other export.
- Confirm the existing `apps/functions/src/trigger-sync.spec.ts` still passes
  unchanged — `runTriggerSync` (the injected handler) is not modified, and the
  **REGRESSION** test asserting `syncTitles`/`dispatchNotifications` remain exported is
  unaffected. **No new unit test** is added (the change is `onCall` wrapper config,
  which the handler-level tests do not — and cannot meaningfully — exercise; see §8).
- Run `pnpm nx run functions:deploy-preflight` (the pruned-bundle deploy gate, also a
  CI gate) so the deployable artifact is known-good before task 2 deploys it.
- **File manifest (modifies):** `apps/functions/src/main.ts` (single file).

> This task touches **one file**; there is no parallel fan-out (no disjoint-manifest
> question). It is intentionally `[sequential]` and alone.

### 2. [sequential] Deploy the CORS-enabled `triggerSync` + functionally verify. Depends on task 1 + the merged PR

infrastructure-engineer (operational).

- **Deploy:** run `pnpm nx run functions:deploy-preflight`, then `/deploy-functions`
  to ship `triggerSync` to production (the established pnpm/gen2 recipe — user memory
  `functions-deploy-pnpm-recipe`; project id `vultus-cab62`, region `europe-west1`).
  A **callable** uses Firebase Auth, not a public invoker, so the
  `syncTitles`-style `allUsers` invoker grant (user memory `syncTitles-public-invoker`)
  is **not** needed for `triggerSync` — but if a Google-Front-End HTML 403 (not the
  function's JSON / a CORS error) appears, revisit invoker/IAM as that memory describes
  (that would be spec 0021/0033 territory, not this CORS fix).
- **Functional verification (the real production check) — BOTH surfaces, required:** 1. **Dev server:** from a browser at `http://localhost:4200` via
  `pnpm nx run mobile:serve-prod-debug` (which hits **real prod** Functions from the
  dev origin — requires a populated `.env.local`, per CLAUDE.md), tap the watchlist
  refresh button and confirm (a) **no CORS preflight error** in the browser console
  and (b) the call completes (success toast "Watchlist synced", or a function-level
  JSON error such as `unauthenticated` — i.e. the function is **reached**, which it
  was not before). 2. **Installed Android app:** build/install the production app on a device
  (`pnpm nx run mobile:android-usb`, WebView origin `http://localhost`) with Chrome
  remote-debugging attached, tap the refresh button, and confirm the **same**: no
  CORS preflight error in the WebView console and the call reaches the function.
  This is the surface the user actually reported failing, so it is **not optional**.
  Optionally also confirm a deployed Hosting origin (`web.app`).
- **File manifest:** none (operational; no repo files change). This task is the
  **required production fix** and is recorded in the PR / follow-up notes, not as code.

> **Why task 2 is in the spec even though deploy is "out of band":** per
> `docs/specs/README.md` the skill workflow ends at a merged PR and does not deploy —
> but the reported bug is a **production** CORS failure whose fix only takes effect
> once the CORS-enabled function is deployed. Recording the deploy + browser-origin
> verification as an explicit, ordered task (and in the DoD) is how this spec makes the
> operational fix non-optional and traceable, rather than shipping a code-only change
> that does not actually unblock the user's app. Per user memory
> `emulator-tooling-limitation` and the device/console constraints, the deploy +
> browser verification run in the **user's own terminal/browser**, not under Claude
> Code tools — flag this rather than reporting the bug fixed off a green build.

## 8. Test plan

Per the PLAN §5 pyramid: the existing functions unit tests are the regression net;
**no new unit/component test** is added, and **no e2e** is required (rubric below). The
real validation is the **post-deploy browser-origin functional check** (task 2).

**Unit (Vitest) — existing `apps/functions/src/trigger-sync.spec.ts`, unchanged and
must stay green:**

- The `runTriggerSync` handler tests (no-auth → `HttpsError('unauthenticated')`;
  valid uid → engine called with deduped per-user titles + `{ syncedAt }`; the
  no-`users/**`/no-`system/sync` boundary; partial-error isolation) are **unaffected**
  — the handler is not modified; only the `onCall` wrapper options change.
- The **REGRESSION** test (`syncTitles` and `dispatchNotifications` remain exported)
  continues to pass unchanged.

**Why no new unit test:** the `cors` option is consumed by the Gen2 `onCall`
**framework wrapper**, not by `runTriggerSync` (which the suite drives directly with
fakes, bypassing the wrapper). A unit test cannot meaningfully assert the framework
emits the `Access-Control-Allow-Origin` header without standing up the function
runtime — that is exactly what the post-deploy browser verification (task 2) covers.
Adding a brittle assertion that inspects the options object literal would test the
literal we just wrote, not the behaviour; it is intentionally omitted. State this in
the PR so the omission is read as deliberate.

**Component — none.** No UI/template change; `scope:mobile` is untouched.

**e2e — Not required (per the rubric):** this is a **`scope:functions`-only config
change** — it introduces **no new route and no new user-facing action** (the watchlist
refresh action already exists, spec 0025). Per the rubric, `scope:functions`-only
changes do not require e2e, and a Playwright test cannot directly assert cloud CORS
response headers anyway (the e2e runs against the **emulator**, which bypasses CORS via
`connectFunctionsEmulator`). State explicitly: **"No e2e flows required — backend/config
change only; CORS headers are not exercisable from the emulator-backed e2e suite."**
The real validation is the manual **browser-origin functional verification** in task 2
(`mobile:serve-prod-debug` against prod Functions), which is an operational check, not
an automated gate.

## 9. Definition of done

Tailored from the PLAN §5 / CLAUDE.md checklist to a one-file `scope:functions` config
change. Gates that don't apply are marked N/A with the reason.

- [ ] `apps/functions/src/main.ts` has a `cors` array on the `triggerSync` `onCall`
      options listing exactly the four pinned origins
      (`https://vultus-cab62.web.app`, `https://vultus-cab62.firebaseapp.com`,
      `http://localhost`, `http://localhost:4200`), alongside the unchanged
      `secrets: [TMDB_READ_TOKEN]`; the **handler body is unchanged**. The fix must
      unblock **both** the dev server (`localhost:4200`) **and** the installed Android
      app (Capacitor WebView origin `http://localhost`).
- [ ] `syncTitles` is **NOT** given a `cors` option (decision 3) — verified, recorded.
- [ ] `pnpm nx typecheck functions` passes — the options object with `cors` compiles
      against the `onCall` signature.
- [ ] `pnpm nx lint functions` passes **with Sheriff active** — no new import edge is
      added; `scope:functions` imports nothing from `scope:mobile`.
- [ ] `pnpm nx test functions` passes — the existing `trigger-sync.spec.ts`
      (handler tests + the `syncTitles`/`dispatchNotifications` export regression) is
      green and unchanged; **no new unit test** added (deliberate — see §8).
- [ ] `pnpm nx build functions` passes.
- [ ] `pnpm nx run functions:deploy-preflight` passes (the pruned-bundle deploy gate)
      — the CORS-enabled `triggerSync` artifact is known-good for deployment.
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green (affected:
      `functions` only; no mobile/shared project is touched).
- [ ] **No `firestore.rules` / `firestore.indexes.json` / `firebase.json` /
      `sheriff.config.ts` / shared-type change** — verified, recorded in the PR.
- [ ] **No secret read/written, none logged** — the change adds a static origin
      allow-list only; no secret value is referenced.
- [ ] **Component / e2e: N/A** — no UI change; `scope:functions`-only config change,
      CORS not exercisable from the emulator-backed e2e (stated in the PR).
- [ ] **Operational (task 2) recorded in the PR / follow-up:** the `/deploy-functions`
      run, and the functional verification on **both** surfaces — the dev server
      (`mobile:serve-prod-debug`, `localhost:4200`) **and** the installed Android app
      (`mobile:android-usb`, WebView origin `http://localhost`) — confirming no CORS
      preflight error and that the refresh call reaches the function in each. If
      deployment cannot be performed within the PR window, this is recorded as a
      **required follow-up** with the named blocker — the code change alone does not fix
      the user's app until deployed.
- [ ] PR description records: the four allowed origins and why each is included
      (including `http://localhost` = Capacitor Android WebView); the deploy-preflight
      result; and the post-deploy verification outcome on **both** the dev server and
      the installed Android app (or the named blocker if deferred).

## 10. Risks

- **The fix only takes effect on deploy (operational, not just code).** The `cors`
  edit is inert until the CORS-enabled function is deployed (`/deploy-functions`). The
  code change does **not by itself** unblock the user's browser; task 2 (deploy +
  browser verification) is the required production fix, and the DoD is not fully met by
  a green build alone.
- **Cannot fully verify here.** Per user memory `emulator-tooling-limitation`, the
  emulator cannot run under Claude Code tools, and the deploy + browser-origin check
  require the user's own terminal + a populated `.env.local` (and ideally remote
  debugging / a real browser). The implementing agent makes the edit and runs the
  preflight; the **deploy + browser confirmation may need the user** — flag it rather
  than reporting the bug closed off a green build.
- **Origin allow-list completeness.** The four pinned origins cover the dev serve
  origin, the two default Firebase Hosting domains for `vultus-cab62`, and the
  Capacitor Android WebView origin (`http://localhost`). If the app is ever served from
  a **custom hosting domain**, a **different dev port**, or the Capacitor config is
  changed to a custom scheme/hostname (e.g. `capacitor://localhost`, `https://localhost`,
  or `androidScheme: 'https'`), that origin must be **appended** to the `cors` array or
  it will be preflight-blocked. Explicit list, no wildcard (decision 4) — the trade-off
  is that new origins need a one-line addition + redeploy. Noted so a future origin
  change is anticipated, not silent.
- **Capacitor WebView origin depends on the Capacitor config — VERIFIED
  `http://localhost`.** `http://localhost` is the **default** Android WebView origin,
  and `capacitor.config.ts` (verified) sets **no** `server.hostname`,
  `server.androidScheme`, or `server.url` — so the installed Android app's WebView
  serves at `http://localhost`, exactly the pinned origin. The implementer should
  **re-confirm `capacitor.config.ts` is unchanged** before relying on this — if it
  ever sets `androidScheme: 'https'` the origin becomes `https://localhost` and that
  value must be used instead. iOS (if ever built) defaults to `capacitor://localhost` —
  out of scope here (Android-only report), but recorded so an iOS build adds its origin
  deliberately. The on-device verification (task 2 step 2) is what ultimately proves
  the chosen origin string is right — a green build does not.
- **Distinct from spec 0021 / 0033 failure modes.** A GFE/Cloud-Run-IAM 403 (spec
  0021, on the `onRequest` `syncTitles`) and a `functions/not-found` (spec 0033,
  undeployed callable) are **not** CORS errors and are **not** addressed by this `cors`
  option. If after deploy the browser still fails with a non-CORS error, that is a
  different cause (auth / not-found / region) — investigate per those specs, do not
  widen `cors` to "fix" it.
- **`syncTitles` intentionally has no CORS** (decision 3). It is cron/server-invoked
  only; adding browser CORS to it would be misleading scope creep. If a future spec
  ever calls `syncTitles` from a browser, CORS is added **then**, deliberately.
- **No PLAN conflict.** The change is an additive, config-only `scope:functions` fix;
  it introduces no cross-slice/cross-scope import, no data-model change, and respects
  the vertical-slice and extract-at-3+ rules (a per-function `cors` option is not
  shared logic). TMDB/Trakt data accuracy is unaffected — the sync flow is unchanged;
  this only lets the existing browser invocation reach it.
  </content>
  </invoke>
