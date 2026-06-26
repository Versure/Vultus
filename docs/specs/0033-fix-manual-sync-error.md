---
number: 0033
slug: fix-manual-sync-error
title: Diagnose and fix manual sync always failing with "Sync failed — try again later"
status: done
slices: [slice:watchlist]
scopes: [scope:mobile, scope:functions]
created: 2026-06-26
---

# Diagnose and fix manual sync always failing with "Sync failed — try again later"

## Context

GitHub issue #69: _"When running the app on my phone and clicking on the manual
sync button in the header I always get an error: Sync failed - try again later."_

The manual sync trigger was built in **spec 0025 (`done`)**: the watchlist
toolbar refresh button calls `SyncStateService.triggerSync()`, which invokes the
`TRIGGER_SYNC` `scope:shared` token. In `apps/mobile/src/app/app.config.ts` that
token is wired to `httpsCallable<unknown, { syncedAt: string }>(fns,
'triggerSync')` on an AngularFire `Functions` instance pinned to region
`europe-west1`. The `triggerSync` `onCall` Cloud Function lives in
`apps/functions/src/main.ts` (verified present, exported, region-pinned via
`setGlobalOptions({ region: 'europe-west1' })`).

The user reports the error fires **every time** (not intermittently). That rules
out transient network failure and points at one of:

1. **The `triggerSync` callable is not deployed** (or the deployed copy predates
   spec 0025). Spec 0025 implementing the function does **not** imply it shipped —
   deployment is a manual `/deploy-functions` step (CLAUDE.md, `docs/specs/README.md`
   §"Scope & limitations": the workflow ends at a merged PR; deploy is separate).
   An undeployed callable rejects with `functions/not-found`. **Most likely.**
2. **Auth not established in production.** If anonymous auth is not enabled in the
   prod Firebase project, or the caller's ID token is missing/invalid, the callable
   rejects with `functions/unauthenticated` (the function throws
   `HttpsError('unauthenticated', 'Sign-in required')` when `request.auth?.uid` is
   falsy — `main.ts:285`).
3. **Region mismatch.** If the function were deployed to a region other than
   `europe-west1`, `getFunctions(undefined, 'europe-west1')` would resolve nothing
   and 404 (`functions/not-found`). (Code is currently consistent on `europe-west1`;
   this is a deploy-target sanity check, not a code bug.)
4. **Gather/Firestore read failure** inside the function (e.g. permissions or an
   empty watchlist edge). Less likely to be _always_, but visible only in the
   Functions logs.

**The core diagnostic problem:** the current `SyncStateService.triggerSync()`
catch block (`watchlist.sync-state.service.ts:62-67`) re-throws the error **without
logging it**, so neither the device console nor the Functions error code is
visible. The page's `onSync()` (`watchlist.page.ts:171`) catches with a bare
`catch {}` and shows a generic toast. There is **zero diagnostic visibility** into
which of the four causes is firing.

Intended outcome: (a) a small, defensive **code change** that logs the underlying
error (and distinguishes "not deployed" from other failures) so the actual cause
is visible via Chrome remote-debugging on the device; (b) an explicit
**operational fix** path — a deployment-verification + deploy task — because the
most likely root cause is "the function was never deployed", which is an ops step,
not a code bug.

> This is primarily a **diagnostic + deployment** spec. The code change is
> intentionally minimal (error logging + categorization). The real production fix
> is almost certainly **deploying `triggerSync`** and/or **enabling anonymous auth**
> — both operational, recorded here as required tasks, not code.

## Scope

In scope:

- **`scope:mobile`, `slice:watchlist`:** add error-context logging to
  `SyncStateService.triggerSync()`'s catch block before the re-throw, and
  categorize the failure — distinguish `functions/not-found` (deployment/region
  issue) from `functions/unauthenticated` (auth issue) from everything else, with
  a distinct `console.error` line each. **The re-throw is preserved** (the page's
  toast behaviour is unchanged) and the cooldown-not-advanced-on-failure behaviour
  is preserved.
- **`scope:functions` (informational / verification only):** confirm `triggerSync`
  is exported from `apps/functions/src/main.ts` and region-pinned to
  `europe-west1`. **No code change unless the verification finds a defect.**
- **Operational (a required task, not code):** run
  `pnpm nx run functions:deploy-preflight` (the CI deploy gate, CLAUDE.md) to
  validate the pruned functions bundle, then `/deploy-functions` to deploy
  `triggerSync` to production; and an investigation checklist (Functions deployed?
  anonymous auth enabled? Functions logs show which error?).

Out of scope (explicitly):

- **Changing the user-facing toast copy** ("Sync failed — try again later" stays).
  The fix is diagnostic logging + deployment, not new UI strings. (The toast
  `duration: 3000` on the error path is already adequate; not changed.)
- **Changing the `triggerSync` function behaviour, gather logic, region, or auth
  model.** Spec 0025's contract is correct; this spec does not re-shape it.
- **Server-side rate limiting / `system/sync` for the manual path** — out of scope
  per spec 0025 (client-side cooldown only).
- **Adding a server-side health/ping endpoint, retry logic, or offline queue** —
  not needed to diagnose an always-failing call.
- **Any `firestore.rules` / `firestore.indexes.json` / `sheriff.config.ts` change**
  — none required.
- **Re-running the daily cron `syncTitles`** — untouched.

## Affected slices & Sheriff tags

| Project          | Path                                                                 | Sheriff tags                      | Change                                                                                          |
| ---------------- | -------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| mobile-watchlist | `libs/mobile/watchlist/src/lib/watchlist.sync-state.service.ts`      | `scope:mobile`, `slice:watchlist` | **add** error logging + `FirebaseError` categorization in the catch block (re-throw preserved)  |
| mobile-watchlist | `libs/mobile/watchlist/src/lib/watchlist.sync-state.service.spec.ts` | `scope:mobile`, `slice:watchlist` | **extend** tests: error still re-thrown + still no timestamp advance; logging asserted          |
| functions (app)  | `apps/functions/src/main.ts`                                         | `scope:functions`                 | **verify only** — `triggerSync` exported + `europe-west1`; no code change unless a defect found |

- **Tags exist already** (specs 0009/0014/0025) — verify by path glob in
  `sheriff.config.ts`; **do not edit `sheriff.config.ts`**.
- **No cross-slice / cross-scope import.** The watchlist slice imports only
  `@vultus/shared/domain/tokens` (`TRIGGER_SYNC`) and third-party packages. The
  new `FirebaseError` import is **third-party** (`firebase/app`, see Public types) —
  Sheriff permits third-party imports; this is **not** an `@angular/fire/functions`
  import (the slice still never imports AngularFire's functions wiring; it only
  imports the error _type_ from `firebase/app`). The `apps/functions` step is
  read-only verification.
- **Not a `shared/` extraction.** One-slice diagnostic logging stays in the slice.

## Data model touchpoints

**None.** This spec adds/changes no Firestore collection, field, converter,
security rule, or index. The diagnostic logging is client-only; the deployment
task ships the existing `triggerSync` whose data access (read caller's
`users/{uid}/watchlist`, write `title-cache/**` via the engine port) is exactly as
spec 0025 defined — unchanged. Record "no `firestore.rules` / no
`firestore.indexes.json` change" in the PR.

## Public types / APIs

**No new or changed public type, token, function signature, or callable shape.**

- `SyncStateService.triggerSync(): Promise<void>` — signature **unchanged**
  (returns `void`; note the issue-context snippet showing `Promise<{ syncedAt }>`
  is outdated — the real service returns `Promise<void>`, see
  `watchlist.sync-state.service.ts:55`). Only the catch-block body changes.
- `TRIGGER_SYNC` token, `triggerSync` callable, `TriggerSyncResponse` — all
  **unchanged**.

### `FirebaseError` import — pin the correct module

AngularFire's callables reject with a `FirebaseError` (the Firebase JS SDK error
class) carrying a string `code` like `functions/not-found` or
`functions/unauthenticated`. **The implementer MUST import the type from the SDK,
not invent a path.** `FirebaseError` is **not currently imported anywhere** in the
repo (verified). The canonical module is **`firebase/app`**:

```ts
import { FirebaseError } from 'firebase/app';
```

> **Implementer note — verify the import before writing it.** The issue context
> suggested `@angular/fire/app`; AngularFire **does** re-export `FirebaseError`
> from `@angular/fire/app` (it is the same class re-exported from `firebase/app`),
> but the **authoritative, dependency-stable** module is `firebase/app` (a direct
> dependency of `@angular/fire`). Prefer `firebase/app`. If for any reason the
> typecheck cannot resolve `firebase/app` in this slice's tsconfig, fall back to
> `@angular/fire/app` (both yield the identical class) and record which was used in
> the PR. Do **not** import from `@angular/fire/functions` (that would pull
> AngularFire's functions wiring into the slice — avoid).

### The catch-block change (the only code edit)

In `libs/mobile/watchlist/src/lib/watchlist.sync-state.service.ts`, replace the
current catch block (lines 62-67) so it logs the error — categorizing
`functions/not-found` (deployment/region) and `functions/unauthenticated` (auth)
distinctly — **before** re-throwing. The state changes (`syncing.set(false)`, no
timestamp advance, no cooldown start) and the `throw err` MUST be preserved
exactly. Shape (illustrative — wording may be tuned, the behaviour is the
contract):

```ts
} catch (err) {
  // Do NOT advance the timestamp — the cooldown should not start on failure
  // so the user can retry immediately.
  this.syncing.set(false);
  if (err instanceof FirebaseError && err.code === 'functions/not-found') {
    // The callable is not deployed (or deployed to a different region).
    console.error('[SyncState] triggerSync not deployed / not found:', err.code, err.message);
  } else if (err instanceof FirebaseError && err.code === 'functions/unauthenticated') {
    console.error('[SyncState] triggerSync unauthenticated (auth not established):', err.code, err.message);
  } else {
    console.error('[SyncState] triggerSync failed:', err);
  }
  throw err;
}
```

- `console.error` (not `console.log`) so it surfaces at error level in Chrome
  remote-debugging / `adb logcat` via the WebView console.
- **Never log a token, uid, or secret** (CLAUDE.md hard rule) — `FirebaseError`'s
  `code`/`message` carry none; do not add the uid or any auth payload to the log.

## UI / Stitch screen refs

**No UI change.** This feature touches no markup, no component template, no design
token, and adds no on-screen element or copy. The existing watchlist toolbar
refresh button and its idle/syncing/cooldown states (spec 0025) are unchanged, and
the error toast copy is deliberately preserved ("Sync failed — try again later",
`color: 'danger'`, `duration: 3000`). **No Stitch screen needs to be pulled for
this spec** — the change is non-visual diagnostic logging plus a deployment step.
(Stated explicitly so the implementer does not treat the absent UI section as an
omission.)

## Implementation task graph

Three tasks. The two code/verification tasks write disjoint files and can run in
parallel; the deployment task is sequential (it must follow a green build of the
functions bundle and the merge, and is an operational step).

### Parallel tasks (disjoint manifests)

1. **[parallel] Add diagnostic logging + error categorization to
   `SyncStateService` (`libs/mobile/watchlist`, `scope:mobile`/`slice:watchlist`).**
   frontend-engineer.
   - Import `FirebaseError` from `firebase/app` (verify resolution; fall back to
     `@angular/fire/app` only if needed — see Public types).
   - Rewrite the catch block in `triggerSync()` to log the error (distinguishing
     `functions/not-found` and `functions/unauthenticated` from other errors) at
     `console.error` level **before** the existing `throw err`. Preserve
     `this.syncing.set(false)`, the no-timestamp-advance behaviour, and the
     re-throw exactly.
   - Extend `watchlist.sync-state.service.spec.ts`: keep the existing
     "thunk rejection re-throws + no timestamp advance + canSync stays true" test
     green; add an assertion that `console.error` is called on rejection (spy on
     `console.error`); add a case where the rejected error is a
     `FirebaseError`-shaped object with `code: 'functions/not-found'` and assert the
     error is still re-thrown (categorization does not swallow it). Use a fake
     `FirebaseError` (or import the real class) per the test's existing fake-thunk
     pattern; no network/emulator.
   - Update `libs/mobile/watchlist/README.md` **only if** it documents
     `SyncStateService`'s error behaviour — add a one-line note that
     `triggerSync()` logs `functions/not-found` / `functions/unauthenticated`
     distinctly for on-device diagnostics. (No public-surface change.)
   - **File manifest (creates/modifies):**
     - `libs/mobile/watchlist/src/lib/watchlist.sync-state.service.ts`
     - `libs/mobile/watchlist/src/lib/watchlist.sync-state.service.spec.ts`
     - `libs/mobile/watchlist/README.md`

2. **[parallel] Verify the `triggerSync` callable export + region
   (`apps/functions`, `scope:functions`).** backend-engineer.
   - **Read-only verification** of `apps/functions/src/main.ts`: confirm
     `triggerSync` is exported as an `onCall`, that `setGlobalOptions({ region:
'europe-west1', ... })` is in effect, and that it binds `{ secrets:
[TMDB_READ_TOKEN] }`. **No code change unless a defect is found.** If a defect
     is found (e.g. wrong region, missing export), record it and treat it as a
     code fix within this task — but the expectation is "no change".
   - Confirm `pnpm nx run functions:deploy-preflight` passes (the pruned-bundle
     gate) so the deployable artifact is known-good before task 3 deploys it.
   - **File manifest:** none expected (verification only). If a defect fix is
     genuinely needed it is confined to `apps/functions/src/main.ts` — flag this to
     the orchestrator so it is NOT run concurrently with any other functions edit.

### Sequential operational task

3. **[sequential] Deploy `triggerSync` to production + investigate. Depends on
   tasks 1 + 2 and on the PR being merged.** infrastructure-engineer (operational).
   - Run the investigation checklist **first** (it determines the actual cause): 1. **Is the function deployed?** Check the Firebase console / `firebase
functions:list` (or `gcloud functions list --regions=europe-west1`) for
     `triggerSync` in `europe-west1`. (Project id `vultus-cab62` — user memory.) 2. **Is anonymous auth enabled** in the prod Firebase project's Authentication
     → Sign-in providers? (The app signs in anonymously; if disabled, the
     callable gets `unauthenticated`.) 3. **What do the Functions logs say?** `firebase functions:log --only
triggerSync` (or the console) for the actual rejection reason on a real
     invocation.
   - **Deploy:** run `pnpm nx run functions:deploy-preflight` (CI deploy gate), then
     `/deploy-functions` to ship `triggerSync` to production (the established
     pnpm/gen2 recipe — user memory `functions-deploy-pnpm-recipe`). Note
     `syncTitles` already required `allUsers` run.invoker (user memory
     `syncTitles-public-invoker`); a **callable** uses Firebase Auth, not a public
     invoker, so no invoker grant is needed for `triggerSync` — but if the console
     shows a Google-Front-End 403 HTML (not the function's JSON), revisit the
     invoker/IAM as that memory describes.
   - **Verify on device:** after deploy, tap the watchlist refresh button on the
     phone with Chrome remote-debugging attached; confirm the success toast
     ("Watchlist synced") and that no `[SyncState] triggerSync …` error logs.
   - **File manifest:** none (operational; no repo files change). This task is the
     **required production fix** and is recorded in the PR / follow-up notes, not as
     code.

> **Why task 3 is in the spec even though deploy is "out of band":** per
> `docs/specs/README.md` the skill workflow ends at a merged PR and does not
> deploy — but issue #69 is a **production** bug whose most likely cause is "not
> deployed". Recording the deploy + investigation as an explicit, ordered task (and
> in the DoD) is how this spec makes the operational fix non-optional and
> traceable, rather than shipping a code-only change that does not actually fix the
> user's phone.

## Test plan

Per the PLAN §5 pyramid: **unit** for the new logging/categorization branch;
**no new component test** (no UI change); **no new e2e** (see rubric below).

**Unit — `scope:mobile` (`watchlist.sync-state.service.spec.ts`, fake
`localStorage` + fake timers + `console.error` spy):**

- **Regression (existing, must stay green):** thunk rejects → `syncing` returns to
  false, the timestamp is **not** advanced, `canSync` stays true, and the error is
  **re-thrown** (`await expect(...).rejects.toThrow(...)`).
- **New:** on rejection, `console.error` is invoked (spy asserts at least one
  `console.error` call). Restore/clean the spy in `afterEach`.
- **New (categorization):** when the rejected value is a `FirebaseError`-shaped
  error with `code: 'functions/not-found'`, the error is still re-thrown (the
  branch logs but does not swallow); `syncing` is false and the timestamp is not
  advanced. (Optionally assert the log line distinguishes the not-found case.)
- All other existing `SyncStateService` tests (cooldown restore, exact-expiry
  re-enable, guards, localStorage degradation) remain unchanged and green.

**Component — none.** No UI/template change → the existing
`watchlist.page.spec.ts` is untouched and must still pass (the toast behaviour is
unchanged).

**Functions — verification, not a new test.** `apps/functions` is verified
read-only; its existing spec-0025 `triggerSync` tests must still pass. No new
functions test is added (no behaviour change).

**e2e — Not required (per the rubric):** this change introduces **no new route and
no new user-facing action** — it adds diagnostic logging to an existing action and
ships an existing function. The existing spec-0025 `manual-sync-trigger` e2e flow
(if present/un-skipped) already covers the happy path and is **not modified**.
State explicitly: **"No new e2e flow required — diagnostic logging + deployment of
an already-specced action; no new route/action."** The real production validation
is the **manual on-device verification** in task 3 (Chrome remote-debugging after
deploy), which is an operational check, not an automated e2e gate.

## Definition of done

Tailored from PLAN §5 / CLAUDE.md to this diagnostic + deploy change.

- [ ] `pnpm nx typecheck mobile-watchlist` passes — the `FirebaseError` import
      resolves and the categorized catch block compiles.
- [ ] `pnpm nx lint mobile-watchlist` passes **with Sheriff active** — the slice
      imports `@vultus/shared/domain/tokens` + third-party (`firebase/app` for the
      `FirebaseError` _type_, Ionic, ionicons) only; **no `@angular/fire/functions`
      import, no `apps/mobile` import, no other-slice import.**
- [ ] `pnpm nx test mobile-watchlist` passes — the extended `SyncStateService`
      tests (re-throw + no-timestamp-advance regression green; `console.error`
      asserted on rejection; `functions/not-found` still re-thrown) green; the
      existing `watchlist.page.spec.ts` still passes.
- [ ] `pnpm nx build mobile` passes — the slice bundles cleanly within budgets.
- [ ] `apps/functions` verification recorded: `triggerSync` is exported as an
      `onCall`, region `europe-west1`, binds `TMDB_READ_TOKEN` — **no code change**
      (or, if a defect was found, the minimal fix + why, in the PR).
- [ ] `pnpm nx run functions:deploy-preflight` passes (the pruned-bundle deploy
      gate) — the `triggerSync` artifact is known-good for deployment.
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green
      (affected: `mobile-watchlist`, `mobile`; `functions` if verification touched
      it).
- [ ] **Operational (task 3) recorded in the PR / follow-up:** the investigation
      checklist results (function deployed? anonymous auth enabled? Functions log
      cause), the `/deploy-functions` run, and the **on-device verification** that
      the refresh button now succeeds (success toast, no `[SyncState]` error logs).
      If deployment cannot be performed within the PR window, this is recorded as a
      **required follow-up** with the named blocker — the code change alone does not
      close issue #69.
- [ ] **No secret read/written, none logged** — the new `console.error` lines log
      only `FirebaseError.code`/`message`/the raw error, never a uid/token/secret.
- [ ] **`sheriff.config.ts`, `firestore.rules`, `firestore.indexes.json`,
      `firebase.json` are NOT modified** (no data/rule/emulator change) — verified,
      recorded in the PR.
- [ ] **README updated in the same change** if it documents `SyncStateService`
      error behaviour (`libs/mobile/watchlist/README.md`).
- [ ] PR description records: the chosen `FirebaseError` import path
      (`firebase/app` vs `@angular/fire/app` fallback) and why; the
      `apps/functions` verification result; the deploy + investigation outcome
      (which of the four causes was confirmed); and the on-device verification
      status.

## Risks

- **The primary root cause is operational, not a code bug.** The most likely fix is
  **deploying `triggerSync`** (it may never have been deployed since spec 0025) —
  and possibly **enabling anonymous auth** in the prod project. The code change
  (diagnostic logging) is a defensive improvement that makes the cause _visible_;
  it does **not by itself** fix the user's phone. This spec is explicit that task 3
  (deploy + investigate) is the required production fix, and the DoD will not be
  fully met by a green build alone.
- **Cannot fully verify here.** Per user memory (`emulator-tooling-limitation`),
  the Firestore/Functions emulator cannot run under Claude Code tools here, and the
  deploy + on-device check require the user's own terminal/device + Firebase
  console access. The implementing agent makes the code change and runs the
  preflight; the **deploy + on-device confirmation may need the user** — flag it
  rather than reporting issue #69 closed off a green build.
- **`functions/not-found` vs `unauthenticated` ambiguity.** Until the device logs
  (or Functions logs) are read, we are inferring the cause. The categorized logging
  exists precisely to disambiguate; the investigation checklist (task 3) must run
  before concluding which fix applied. Do not assume "not deployed" without
  checking the console.
- **Region is a silent failure mode.** `httpsCallable` resolves by name in the
  region passed to `getFunctions` (`europe-west1`); a function deployed elsewhere
  404s as `functions/not-found` with no auth/boundary error. The verification (task 2) and the deploy (task 3) must confirm the deployed region is `europe-west1`.
- **`FirebaseError` import-path drift.** If `firebase/app` does not resolve in the
  slice tsconfig, the `@angular/fire/app` re-export is the documented fallback
  (identical class). Importing from `@angular/fire/functions` is **wrong** here
  (pulls functions wiring into the slice) — do not.
- **TMDB/Trakt data accuracy (PLAN §9)** is unaffected — this spec changes neither
  the engine nor the gather; a successful manual refresh reflects whatever the
  data sources return, exactly as before.
- **No PLAN conflict.** The change is additive diagnostics + a deploy step; it
  introduces no cross-slice/cross-scope import and no data-model change. The deploy
  step is consistent with `docs/specs/README.md` (deployment is a separate manual
  step) — recorded as an explicit task because issue #69 is a production bug.
