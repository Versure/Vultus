---
number: 0025
slug: manual-sync-trigger
title: Add a manual "refresh now" sync trigger to the watchlist toolbar via a triggerSync callable
status: done
slices: [slice:watchlist, slice:sync-titles]
scopes: [scope:mobile, scope:functions]
created: 2026-06-25
---

# Add a manual "refresh now" sync trigger to the watchlist toolbar via a triggerSync callable

## Context

PLAN §1 lists, explicitly in scope for v1: **"Manual 'refresh now' from the app,
rate-limited to once per 5 minutes."** This spec delivers it.

Today the pieces exist but are not wired together:

- **Spec 0014 (watchlist slice, `done`)** built the watchlist page. Its
  pull-to-refresh **only re-subscribes the Firestore stream** — it deliberately
  deferred the actual HTTP sync call (0014 Out of scope / Risks: "Pull-to-refresh
  is stream re-subscribe only, not an HTTP sync call … wiring the manual
  rate-limited sync callable is a later spec"). **This is that later spec.**
- **Spec 0008 (`done`)** built the Firebase-free `SyncEngine`
  (`createSyncEngine`) in `libs/functions/sync-titles`; **spec 0009 (`done`)**
  wrapped it in the `syncTitles` **`onRequest`** HTTPS function in
  `apps/functions`, with **dual auth** (a cron shared secret **or** a Firebase
  ID token). **Spec 0021** granted the deployed function a public invoker.

Intended outcome: on the Watchlist tab, a **toolbar refresh button** lets the
user trigger an immediate sync of their tracked titles. While the sync runs the
button shows a spinner and is disabled; on success a "Watchlist synced" toast
appears and the list updates itself (the existing realtime Firestore
subscription reflects the sync's `title-cache`/watchlist writes — no manual list
reload). A **client-side 5-minute cooldown** prevents hammering the function;
within the cooldown the button is disabled with an aria-label of "Synced just
now".

### The trigger is a NEW `triggerSync` callable — the existing `syncTitles` is untouched (locked decision)

The mobile app **must not** call the existing `syncTitles` `onRequest` function
and that function **must not** be modified. Rationale:

- `syncTitles` carries the **cron shared-secret** auth path (spec 0009) and is
  invoked by the GitHub Actions daily cron (PLAN §6 item 13). Re-shaping it to
  serve a Firebase-Auth callable risks the cron contract, and a raw `onRequest`
  call from the app would require the app to construct an `Authorization: Bearer`
  header from the AngularFire ID token by hand.
- Instead, add a **new Firebase callable** `triggerSync` in
  `libs/functions/sync-titles` (the **same slice** as the engine). Firebase
  **callable** functions verify the caller's Firebase Auth context automatically
  (AngularFire `httpsCallable` attaches the ID token transparently), so no
  shared secret and no hand-built header are needed on the client.

`triggerSync` **reuses the existing `createSyncEngine` + `createFirestoreTitleCacheStore`**
(no duplication of the sync logic — PLAN §3, "extract only at 3+ slices"; here
the logic is simply re-consumed in-slice). It validates `request.auth`, gathers
**the calling user's own watchlist** titles, runs one engine pass over them, and
returns `{ syncedAt: string }`.

> **Scoping note vs `syncTitles`.** `syncTitles` (cron) syncs the **global union
> of all users' tracked titles** with a staleness filter and a server-side
> 5-minute rate-limit doc (`system/sync`). `triggerSync` (manual) syncs **only
> the calling user's** titles, **always force-fresh** (no staleness filter — a
> manual refresh means "refresh my titles now"), and relies on the **client-side**
> cooldown for rate limiting (this is a personal single-user app; locked
> decision). The two functions are deliberately separate code paths sharing only
> the underlying engine + store factories.

## Scope

In scope:

- **`scope:functions`, `slice:sync-titles`:** a new `triggerSync` Firebase
  **callable** function, exported from `apps/functions/src/main.ts` (the
  deployable barrel). It validates `request.auth`, reads the **calling user's**
  `users/{uid}/watchlist` titles, dedupes to `{ tmdbId, type }`, runs
  `engine.sync(...)`, and returns `{ syncedAt: string }`. The Firestore/Auth glue
  is thin; any non-trivial pure logic (e.g. mapping the per-user gather, building
  the response) is unit-tested.
- **`scope:mobile`, `slice:watchlist`:** a new slice-local **`SyncStateService`**
  (client-side cooldown via `localStorage`) and a **toolbar refresh button** on
  `WatchlistPage` with idle / syncing / cooldown states, success/error toasts,
  and the `httpsCallable('triggerSync')` invocation. The slice obtains the
  callable handle via an **injected `scope:shared` token** (so it does not import
  `apps/mobile`); see Public types / APIs.
- **`scope:mobile`, shell (`apps/mobile`):** wire AngularFire **`provideFunctions`**
  into `app.config.ts` (it is not yet provided), provide the new callable token,
  and add the **Functions emulator** connect-helper + `firebase.json` emulator
  entry so the e2e/dev paths can reach it. This is shell/config plumbing the
  slice depends on (the slice cannot self-provide app-level Firebase providers).

Out of scope (explicitly):

- **Modifying `syncTitles`** (the cron `onRequest`) in any way — it stays exactly
  as spec 0009/0021 left it.
- **Server-side rate limiting for the manual path.** The cooldown is **client-side
  only** (`localStorage`); a personal single-user app does not need a server gate
  for the manual trigger (locked decision). `triggerSync` does **not** read or
  write `system/sync`.
- **Replacing `syncTitles` for the GitHub Actions cron** — the cron keeps calling
  `syncTitles` with its shared secret.
- **Making pull-to-refresh call the sync** — the `ion-refresher` keeps its
  spec-0014 behaviour (re-subscribe the Firestore stream only), so there is one
  obvious "sync" affordance (the toolbar button) and the pull gesture stays a
  cheap local refresh. (Stated so the implementer does not also wire the
  refresher to `triggerSync`.)
- **Background / scheduled sync from mobile**, **per-title sync progress**, and
  the **Watchmode fallback** (PLAN §9) — all later / not this spec.

## Affected slices & Sheriff tags

| Project               | Path                         | Sheriff tags                           | Change                                                                             |
| --------------------- | ---------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| functions-sync-titles | `libs/functions/sync-titles` | `scope:functions`, `slice:sync-titles` | **add** the per-user gather helper (pure) + its unit test; barrel may stay as-is   |
| functions (app)       | `apps/functions`             | `scope:functions`                      | **add** the `triggerSync` callable export (alongside the untouched `syncTitles`)   |
| mobile-watchlist      | `libs/mobile/watchlist`      | `scope:mobile`, `slice:watchlist`      | **add** `SyncStateService` + the toolbar refresh button/state on `WatchlistPage`   |
| mobile (shell)        | `apps/mobile`                | `scope:mobile`                         | **add** `provideFunctions` + the callable token provider + Functions emulator glue |

- **Tags are by path glob in `sheriff.config.ts` — this spec does NOT edit
  `sheriff.config.ts`.** All four paths already carry the tags above (per spec
  0009/0014). Verify, do not add.
- **No cross-slice import; no cross-scope import.**
  - The mobile watchlist slice **must never** import `@vultus/functions/sync-titles`
    or any `scope:functions` symbol (Sheriff forbids `scope:mobile → scope:functions`).
    It calls the callable purely over the wire via AngularFire's
    `httpsCallable` — a **runtime, network** boundary, not a code import. The
    request/response **shapes** the mobile side needs (`TriggerSyncResponse`) are
    **duplicated as a tiny slice-local interface** in the watchlist slice — they
    are **not** imported from the functions slice. (Two trivial mirror interfaces
    in different scopes is correct here; a `shared/` extraction for two 1-field
    response types would be a premature DRY against the 3+-slice rule.)
  - The watchlist slice obtains the AngularFire `Functions` callable via an
    **`AUTH_UID`-style `scope:shared` injection token** provided by the shell
    (`apps/mobile`) — it **must not** import a service from `apps/mobile` (that
    would be a forbidden `slice:watchlist → scope:mobile` edge, mirroring the
    0014 `AUTH_UID` rule). See Public types / APIs for the token.
  - `apps/functions` importing `@vultus/functions/sync-titles` + `@vultus/shared/*`
    is allowed (an app may import its own scope's slices — Rule 3, per spec 0009).
- **Not a premature `shared/` extraction.** The per-user gather helper stays in
  `libs/functions/sync-titles`; the `SyncStateService` + response mirror type stay
  in `libs/mobile/watchlist`; the callable token lives in `shared/domain`
  alongside `AUTH_UID` (it is the established pattern for "the shell hands a
  capability to a slice without a cross-scope import"). One consumer each — the
  3+-slice rule is respected.

## Data model touchpoints

`triggerSync` is a **reader of one user's watchlist** and a **writer of the
global `title-cache` only** (via the engine's `TitleCacheStore` port + the
spec-0009 adapter). It writes **no** `users/**` document and **does not** touch
`system/sync`.

| PLAN §4 path                                 | Access   | By                                                                          |
| -------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| `users/{uid}/watchlist/{titleId}`            | **read** | `triggerSync` reads the **caller's own** subcollection → `{ tmdbId, type }` |
| `title-cache/{tmdbId}`                       | r/w      | engine via `createFirestoreTitleCacheStore` (`titleCacheDocPath`)           |
| `title-cache/{tmdbId}/availability/{region}` | r/w      | engine via the adapter (`availabilityDocPath`)                              |

- **Per-user gather (not collection-group).** Unlike `syncTitles`' global
  `collectionGroup('watchlist')`, `triggerSync` reads **only the calling user's**
  `users/{uid}/watchlist` collection (`db.collection(watchlistPath(uid))` using
  the `watchlistPath` builder from `@vultus/shared/firestore-schema`). Project
  each doc to its raw `{ tmdbId, type }` fields (the two non-Timestamp primitives —
  same approach `firestore-io.ts` uses for the cron, avoiding the `addedAt`
  Timestamp). Dedupe by `tmdbId` (a single user is unlikely to dupe, but keep it
  defensive and consistent with the cron path).
- **No new Firestore index.** The per-user read is a single-collection `.get()`
  with no `where`/`orderBy` → no composite index. `firestore.indexes.json` is
  **unchanged** (state this; do not add one).
- **No new collection / no `system/sync` touch.** The manual path uses the
  client-side cooldown; `triggerSync` neither reads nor writes `system/sync`.
- **Firestore rules — NO change.** The existing rules (verified in spec
  0014: owner-only `users/{userId}/{document=**}`, authenticated-read +
  client-write-denied `title-cache`) already cover this: the **client** never
  reads/writes `title-cache` directly (the Admin SDK in the function does, and
  the Admin SDK bypasses rules); the function reads the caller's own watchlist via
  the Admin SDK. Record "no `firestore.rules` change needed" in the PR; do **not**
  edit `firestore.rules`.
- **`title-cache` write shapes are unchanged** (spec 0005/0008). This spec adds
  no field to any document.

## Public types / APIs

### The `triggerSync` callable (in `apps/functions/src/main.ts`)

A Firebase **callable** (gen2 `onCall` from `firebase-functions/https`), exported
**alongside** the untouched `syncTitles` and `dispatchNotifications`. Keep
`setGlobalOptions({ region: 'europe-west1', maxInstances: 1 })`.

```ts
import { onCall, HttpsError } from 'firebase-functions/https';

export interface TriggerSyncResponse {
  /** ISO 8601 timestamp of when the manual sync pass completed. */
  syncedAt: string;
}
```

Behaviour:

- **Auth:** if `request.auth?.uid` is falsy → throw
  `new HttpsError('unauthenticated', 'Sign-in required')`. The callable framework
  has already verified the ID token; the function only asserts an identity is
  present. **Never** log the uid's token. The uid is read from
  `request.auth.uid` (the trusted, verified identity) — **not** from any
  client-supplied payload.
- **Secrets/config:** binds `TMDB_READ_TOKEN` (`defineSecret`) and reads
  `TRAKT_CLIENT_ID` (`defineString`) exactly as `syncTitles` does — **reuse the
  same param declarations already in `main.ts`** (declare once at module scope,
  read via `.value()` inside the handler). The callable's `onCall` options must
  include `{ secrets: [TMDB_READ_TOKEN] }` so the runtime injects it. **Never read
  `.env.local`; never log a secret/token** (CLAUDE.md hard rule).
- **Gather:** read the caller's watchlist (`gatherUserWatchlistTitles(db, uid)` —
  see below), dedupe to distinct `{ tmdbId, type }`.
- **Run:** build the engine exactly as `syncTitles` does
  (`createSyncEngine({ tmdb: createTmdbClient(...), trakt: createTraktClient(...),
store: createFirestoreTitleCacheStore(db) })`) and `await engine.sync(inputs)`.
  **No staleness filter** (manual = always refresh the user's titles).
- **Return:** `{ syncedAt: new Date().toISOString() }`. The engine's per-title
  errors are isolated (spec 0008) and do **not** fail the callable — a manual
  refresh that synced most titles still resolves; only an outright failure
  (e.g. gather throws) rejects. (If the implementer wishes to surface counts, that
  is allowed as **additional** optional fields, but `syncedAt` is the binding
  contract and the mobile side reads only `syncedAt`.)
- **Boundary:** writes **only** `title-cache/**` via the engine port; writes **no**
  `users/**` doc and **no** `system/sync` doc.

### Per-user gather helper (in `libs/functions/sync-titles`)

A small pure-ish helper so the gather is unit-testable without the full handler.
Place it next to the existing slice code (e.g.
`libs/functions/sync-titles/src/lib/store/` or a new `gather/` folder — the
implementer's choice, kept slice-internal unless `apps/functions` needs it):

```ts
import type { Firestore } from 'firebase-admin/firestore';
import { watchlistPath } from '@vultus/shared/firestore-schema';
import type { TitleType } from '@vultus/shared/domain';

export interface GatheredUserTitle {
  tmdbId: number;
  type: TitleType;
}

/** Read one user's watchlist and project to distinct {tmdbId,type}. No converter
 *  (reads two raw primitive fields; avoids the addedAt Timestamp). */
export async function gatherUserWatchlistTitles(
  db: Firestore,
  uid: string,
): Promise<GatheredUserTitle[]>;
```

- If this helper is consumed by `apps/functions` (it is — the callable lives
  there), **export it from the slice barrel** `libs/functions/sync-titles/src/index.ts`
  **in addition to** all existing 0006/0007/0008/0009 exports (none dropped).
  Document it in the slice README.
- The dedupe (distinct `{ tmdbId, type }`) may live inside this helper or as a
  separate tiny pure function — either is fine; keep the pure dedupe unit-tested.
- **Reuse, do not re-implement, the engine wiring.** The callable constructs the
  engine the same way `syncTitles` does. Do **not** copy the gather/staleness/
  rate-limit machinery — the manual path needs only per-user gather + engine run.

### Mobile: the callable injection token (in `shared/domain`)

Mirror the `AUTH_UID` pattern (`libs/shared/domain/src/lib/tokens.ts`): add a
`scope:shared` `InjectionToken` the shell provides and the slice injects, so the
watchlist slice never imports `apps/mobile` and never imports `@angular/fire`'s
app wiring.

```ts
// libs/shared/domain/src/lib/tokens.ts
import { InjectionToken } from '@angular/core';

/** A function that triggers a manual sync of the current user's watchlist via
 *  the `triggerSync` callable and resolves with the server's syncedAt ISO
 *  string. Provided by the shell (apps/mobile) so slices can trigger a sync
 *  WITHOUT importing @angular/fire/functions or apps/mobile. */
export const TRIGGER_SYNC = new InjectionToken<
  () => Promise<{ syncedAt: string }>
>('TRIGGER_SYNC');
```

- **Binding:** the watchlist slice injects `TRIGGER_SYNC` and calls it; it does
  **not** import `@angular/fire/functions` (the shell owns the AngularFire wiring,
  exactly as it owns `AUTH_UID`). Exporting `TRIGGER_SYNC` keeps the slice free of
  any `@angular/fire/functions` dependency and of any `apps/mobile` import.
- Export `TRIGGER_SYNC` from `@vultus/shared/domain/tokens` (the same secondary
  entry point `AUTH_UID` uses — verify the existing import path
  `@vultus/shared/domain/tokens` in `watchlist.page.ts` and match it). Update
  `libs/shared/domain/README.md` if it enumerates the tokens.

### Mobile shell wiring (in `apps/mobile`)

`app.config.ts` does **not** currently `provideFunctions` (verified). Add:

- `provideFunctions(() => { const fns = getFunctions(undefined, 'europe-west1');
connectFunctionsEmulatorIfEnabled(environment, fns, connectFunctionsEmulator);
return fns; })` — note the **region must be `europe-west1`** to match the
  deployed callable's region (`setGlobalOptions` in `main.ts`). A region mismatch
  silently 404s the callable.
- A `connectFunctionsEmulatorIfEnabled(env, fns, connectFn)` helper added to
  `apps/mobile/src/app/firebase/emulators.ts`, mirroring the existing
  `connect{Auth,Firestore}EmulatorIfEnabled` (gated on `!production && useEmulators`,
  connector injected for testability). Functions emulator host/port: **`localhost`
  : `5001`** (the firebase.json default for the Functions emulator).
- A `{ provide: TRIGGER_SYNC, useFactory: () => { const fns = inject(Functions);
const callable = httpsCallable<unknown, { syncedAt: string }>(fns, 'triggerSync');
return () => callable().then((r) => r.data); } }` provider (factory injects the
  AngularFire `Functions` and returns the thunk the token describes).
- A **Functions emulator entry in `firebase.json`** (`"functions": { "port": 5001 }`
  under `emulators`) so the e2e/dev path can reach the callable. (firebase.json
  currently configures only firestore/auth/ui emulators.)

## UI / Stitch screen refs

This is a `scope:mobile` change to the existing **Watchlist** page. The
implementer **must pull the live screen** via the `stitch` MCP from project
**`projects/13590348714018893783`** ("Vultus Android App Design"): run
`list_screens`, find the **"Watchlist - Vultus"** screen, `get_screen` on it,
take `htmlCode.downloadUrl` and **fetch the raw HTML** (plain GET /
`Invoke-WebRequest` — **not** WebFetch, which summarizes away the CSS) to read the
toolbar/icon-button markup + Tailwind config, and grab `screenshot.downloadUrl`
for a visual compare. **Reference the screen ID in the PR.** **Retry on MCP
failure** (project memory: the Stitch MCP is reachable — an in-session "MCP
unreachable" is a retry, not a reason to ship token-only UI). If the screen HTML
is genuinely unreadable after retries, record **"Stitch screen NOT captured"** as
a **blocking open item** rather than shipping prose-only.

**Authoritative tokens live in `docs/design/vultus-design-system.md`** and are
wired into `shared/ui-kit` `theme.scss` as `--vultus-*` / `--ion-*` vars —
**consume those vars; do not hand-transcribe hex values.** (Reminder: primary is
`#4edea3`, **not** `#10B981` which is `primary-container`.)

**Where it goes.** `WatchlistPage`'s toolbar (`watchlist.page.html`) already has
`<ion-buttons slot="end">` containing the **Account** placeholder button. Add the
**refresh button** as a **sibling inside the same `slot="end"` `ion-buttons`**,
ordered **before** the account button (refresh left of account), so both end
buttons share the same toolbar inset.

This is a **checkable contract**, not prose — pin these per-state values
(reconcile exact dimensions against the fetched Stitch screen; where the screen
specifies a value it wins, but these are the floor the implementer must hit):

- **Control:** an `ion-button` (`fill="clear"`, icon-only) inside the toolbar
  `ion-buttons slot="end"`. Touch target **≥ 44×44px** (the Ionic toolbar-button
  default `min-height`/`min-width`; do not shrink below 44px — accessibility
  floor). The icon uses `slot="icon-only"`, matching the sibling account button's
  sizing so the two end-buttons are vertically centred and equally inset.
- **Icon:** `refresh-outline` (ionicons) in the **idle** and **cooldown** states;
  an **`ion-spinner`** (name `crescent`) in the **syncing** state. Icon/spinner
  color = the toolbar button color the theme already applies to the sibling
  account button (the `--ion-toolbar` on-color / `on-surface` `#dae2fd` via the
  `--vultus-*` var — do **not** hardcode). The active-accent (primary `#4edea3`)
  may be used for the spinner if the screen shows an accent spinner; otherwise
  match the icon color. Pin whichever the fetched screen shows.
- **Type roles:** the toast text uses **`body-md`** (14/400/20) per the design
  scale; no other text is added by this feature.
- **Interactive states (per-state acceptance list — the reviewer/human ticks each):**
  - **idle / enabled:** `refresh-outline` icon, full opacity, `disabled=false`,
    `aria-label="Refresh watchlist"`, tappable.
  - **focus:** the Ionic default focus ring/`.ion-focused` styling on the button
    (keyboard focus visible); do not remove the default focus outline.
  - **hover (pointer):** the Ionic default clear-button hover background
    (`--background-hover`); no custom hover added.
  - **active / pressed:** the Ionic default `.ion-activated` ripple/feedback.
  - **syncing:** icon swapped for `<ion-spinner name="crescent">`, `disabled=true`,
    `aria-label="Syncing…"`. The button stays in the same slot/size (no layout
    shift between icon and spinner — spinner sized to the icon box).
  - **cooldown (within 5 min of last sync):** `refresh-outline` icon at the
    Ionic **disabled** opacity (`--ion-color-step` / the default `disabled`
    `opacity: 0.5` the theme applies — do not invent a value), `disabled=true`,
    `aria-label="Synced just now"`. Re-enables **automatically** at the exact
    cooldown expiry (a timer in `SyncStateService` flips a signal; no tap needed).
  - **transition:** icon↔spinner swap is immediate (no animation needed beyond the
    spinner's own rotation); the disabled→enabled flip at cooldown expiry is a
    plain state change.
- **Toasts (Ionic `ToastController`):**
  - **success:** message **"Watchlist synced"**, `duration: 2000`, `position:
'bottom'`. Color/`cssClass` should read from the theme's success/`primary`
    token (consume the `--vultus-*`/`--ion-color-success` var — do not hardcode).
  - **error:** message **"Sync failed — try again later"**, `duration: 3000`,
    `position: 'bottom'`, `color: 'danger'` (the `--ion-color-danger` / `error`
    `#ffb4ab` token via theme — not hardcoded).
- **Token wiring reminder:** Inter must already be loaded as a web-font (spec
  0010 wired the Google Fonts link in `index.html`) — this feature adds no new
  font; verify it is loaded, do not merely name it.

**Spacing/inset agreement:** the refresh button and the account button are
siblings in the same `ion-buttons slot="end"` and therefore inherit identical
toolbar end-inset and button spacing — assert they align (no bespoke margin on
the refresh button that would break the alignment).

## Implementation task graph

Two **sequential** shared/config prerequisites land first (the `TRIGGER_SYNC`
token in `shared/domain`, and the shell `provideFunctions`/token-provider/emulator
wiring in `apps/mobile`), then two **parallel** slice tasks fan out (the
`scope:functions` callable and the `scope:mobile` watchlist UI write **disjoint**
file sets). The mobile slice depends on the `TRIGGER_SYNC` token (task 1) and the
shell provider (task 2); the functions task depends on neither, but is listed in
the parallel batch since its files are disjoint from the mobile slice's.

### Sequential prerequisites

1. **[sequential] Add the `TRIGGER_SYNC` token to `shared/domain`.**
   frontend-engineer / domain.
   - Add `TRIGGER_SYNC` `InjectionToken<() => Promise<{ syncedAt: string }>>` to
     `libs/shared/domain/src/lib/tokens.ts`, exported via the same
     `@vultus/shared/domain/tokens` entry point as `AUTH_UID`.
   - Update `libs/shared/domain/README.md` **only if** it enumerates the tokens
     (it lists `AUTH_UID` → add `TRIGGER_SYNC`).
   - Files: `libs/shared/domain/src/lib/tokens.ts`,
     `libs/shared/domain/README.md` (if it lists tokens).

2. **[sequential] Shell: provide Functions + the `TRIGGER_SYNC` callable + the
   Functions emulator glue (`apps/mobile`). Depends on task 1.**
   infrastructure-engineer / frontend-engineer.
   - `apps/mobile/src/app/firebase/emulators.ts`: add
     `connectFunctionsEmulatorIfEnabled(env, fns, connectFn)` +
     `FUNCTIONS_EMULATOR_HOST`/`FUNCTIONS_EMULATOR_PORT` (`localhost`/`5001`),
     mirroring the Auth/Firestore helpers (connector injected for the spec).
   - `apps/mobile/src/app/firebase/emulators.spec.ts`: extend with the Functions
     gating test (enabled in dev, no-op in prod) mirroring the existing cases.
   - `apps/mobile/src/app/app.config.ts`: add `provideFunctions(() => …)` with
     **region `europe-west1`** + the emulator connect; add the
     `{ provide: TRIGGER_SYNC, useFactory: … }` provider building
     `httpsCallable(fns, 'triggerSync')` and returning the `() => Promise<{syncedAt}>`
     thunk.
   - `firebase.json`: add `"functions": { "port": 5001 }` under `emulators`.
   - Files: `apps/mobile/src/app/firebase/emulators.ts`,
     `apps/mobile/src/app/firebase/emulators.spec.ts`,
     `apps/mobile/src/app/app.config.ts`,
     `firebase.json`.

### Parallel slice tasks (disjoint manifests — orchestrator asserts pairwise-disjoint before fan-out)

3. **[parallel] `triggerSync` callable + per-user gather (`apps/functions` +
   `libs/functions/sync-titles`, `scope:functions`/`slice:sync-titles`).**
   backend-engineer. Depends on no other task in this spec (it reuses the
   already-merged spec-0008/0009 engine + adapter). **Does NOT modify `syncTitles`.**
   - Add `gatherUserWatchlistTitles(db, uid)` (+ a pure dedupe if separated) in
     `libs/functions/sync-titles/src/lib/gather/user-gather.ts` (or chosen path),
     reading `watchlistPath(uid)` and projecting raw `{ tmdbId, type }`. Export it
     from the slice barrel `libs/functions/sync-titles/src/index.ts` (keep all
     existing exports). Unit-test it with a mocked `firebase-admin` Firestore.
   - Add the `triggerSync` `onCall` to `apps/functions/src/main.ts`: validate
     `request.auth?.uid` (`HttpsError('unauthenticated')` when absent), bind
     `{ secrets: [TMDB_READ_TOKEN] }`, gather the user's titles, dedupe, build the
     engine (reuse the existing `createSyncEngine`/client/store wiring — extract a
     small shared `buildEngine(db)` local if it reduces duplication, but **do not
     change `syncTitles`'** existing behaviour), `engine.sync(...)`, return
     `{ syncedAt }`. **Keep the existing `syncTitles` and `dispatchNotifications`
     exports unchanged.**
   - Add handler unit tests (`main.spec.ts` additions or a sibling spec): assert
     no-auth → `unauthenticated`; a valid `request.auth.uid` → engine called with
     the deduped per-user titles and the response is `{ syncedAt }`; **no
     `users/**`write and no`system/sync`write** (boundary); a partial engine
error still resolves. Fake engine + fake/mocked`db`; no network, no
     emulator, no secrets.
   - Update `libs/functions/sync-titles/README.md`: add `gatherUserWatchlistTitles`
     to the public surface and note the `triggerSync` callable consumes it.
     Update `apps/functions` README **only if one exists**.
   - **File manifest (creates/modifies):**
     - `apps/functions/src/main.ts`
     - `apps/functions/src/main.spec.ts` (or a new `apps/functions/src/trigger-sync.spec.ts`)
     - `libs/functions/sync-titles/src/lib/gather/user-gather.ts`
     - `libs/functions/sync-titles/src/lib/gather/user-gather.spec.ts`
     - `libs/functions/sync-titles/src/index.ts`
     - `libs/functions/sync-titles/README.md`

4. **[parallel] `SyncStateService` + toolbar refresh button (`libs/mobile/watchlist`,
   `scope:mobile`/`slice:watchlist`). Depends on tasks 1 + 2** (injects
   `TRIGGER_SYNC`). frontend-engineer.
   - Add `SyncStateService` (`providedIn: 'root'`, slice-local, **not** barrel-
     exported unless the README opts to) managing the client-side cooldown:
     reads/writes `localStorage` key **`vultus_last_sync_at`** (ISO string);
     exposes a `canSync` signal (false during the cooldown window), a `syncing`
     signal, and a `triggerSync()` method that: guards `canSync`/`syncing`, calls
     the injected `TRIGGER_SYNC` thunk, on resolve writes the new timestamp +
     starts the re-enable timer, and surfaces success/failure to the caller (or
     drives the toasts itself — implementer's choice, but the page owns
     `ToastController`). Cooldown = **300000 ms** (5 min). On construction, read
     the stored timestamp and, if within the window, start `canSync=false` + a
     `setTimeout` that flips it to `true` at the **exact** expiry
     (`expiry - now` ms), so a restart mid-cooldown re-enables precisely.
     **Guard `localStorage`** access (it may be unavailable / throw in some test
     contexts) — degrade to "always allowed" rather than throwing.
   - Wire the toolbar button in `WatchlistPage` (`watchlist.page.ts` /
     `.html` / `.scss`): inject `SyncStateService` (and `ToastController`); add the
     refresh `ion-button` to the existing `ion-buttons slot="end"` (before the
     account button) with the idle/syncing/cooldown states from UI/Stitch refs;
     bind `disabled` to `!canSync() || syncing()`; on click call the service's
     `triggerSync()` and show the success/error toast per the outcome.
   - Add `watchlist.sync-state.service.spec.ts` (cooldown logic with a fake
     `localStorage` + fake clock/timers) and extend `watchlist.page.spec.ts`
     (button visible+enabled idle; click → service invoked + syncing/disabled;
     success → success toast; failure → error toast; cooldown → disabled +
     `aria-label="Synced just now"`). Mock `TRIGGER_SYNC`, `ToastController`,
     `localStorage`; no network/emulator.
   - Update `libs/mobile/watchlist/README.md`: add `SyncStateService` to the slice
     description + note the toolbar refresh button calls `triggerSync` via the
     `TRIGGER_SYNC` token (no `@angular/fire/functions` import, no `apps/mobile`
     import).
   - **File manifest (creates/modifies):**
     - `libs/mobile/watchlist/src/lib/watchlist.sync-state.service.ts`
     - `libs/mobile/watchlist/src/lib/watchlist.sync-state.service.spec.ts`
     - `libs/mobile/watchlist/src/lib/watchlist.page.ts`
     - `libs/mobile/watchlist/src/lib/watchlist.page.html`
     - `libs/mobile/watchlist/src/lib/watchlist.page.scss`
     - `libs/mobile/watchlist/src/lib/watchlist.page.spec.ts`
     - `libs/mobile/watchlist/README.md`

5. **[sequential] e2e flow `manual-sync-trigger`. Depends on tasks 2 + 4** (the
   shell provider + the UI) **and on task 3** (the live callable). qa-runner /
   frontend-engineer. See Test plan for the flow + the `test.fixme` gate.
   - File manifest: `apps/mobile-e2e/src/manual-sync-trigger.spec.ts` (new), and
     any minimal Playwright/emulator config the flow needs (only if absent —
     prefer reusing the spec-0019 e2e setup).

(Tasks 3 and 4 write **disjoint** file sets — `apps/functions/**` +
`libs/functions/sync-titles/**` vs `libs/mobile/watchlist/**` — and may run in
parallel. Tasks 1, 2, 5 are sequential gates around them. `firebase-admin` /
`firebase-functions` / `@angular/fire` are already dependencies — verify, add
nothing new.)

## Test plan

Per the PLAN §5 pyramid: **unit** for the cooldown logic + the per-user gather +
the callable wiring; **component** for the toolbar button's states; **one e2e**
for the happy-path manual-sync flow.

**Unit — `scope:functions` (`user-gather.spec.ts`, mocked `firebase-admin`):**

- `gatherUserWatchlistTitles(db, uid)` reads `watchlistPath(uid)`, maps docs to
  raw `{ tmdbId, type }`, dedupes by `tmdbId`; empty watchlist → `[]`.

**Unit — `scope:functions` (`triggerSync` handler, fake engine + fake `db`):**

- No `request.auth` → throws `HttpsError('unauthenticated')`; engine **not**
  called.
- Valid `request.auth.uid` → engine called with the deduped per-user titles;
  resolves `{ syncedAt: <ISO string> }`.
- **Boundary:** across all paths the fake `db` records **no `users/**`write and
no`system/sync`write** — only`title-cache/\*\*` (via the store). This is the
  load-bearing boundary test.
- A partial engine error (one title `outcome: 'error'`) still **resolves**
  `{ syncedAt }` (manual refresh is best-effort, per 0008 isolation).
- **Regression:** `syncTitles` and `dispatchNotifications` remain exported and
  unchanged (assert their exports still exist; the existing 0009 `main.spec.ts`
  tests still pass).

**Unit — `scope:mobile` (`watchlist.sync-state.service.spec.ts`, fake
`localStorage` + fake timers):**

- No prior sync (empty `localStorage`) → `canSync` true.
- A stored timestamp **within** 5 min → `canSync` false; after advancing the fake
  clock to expiry the re-enable timer flips `canSync` true at the **exact** expiry.
- A stored timestamp **older** than 5 min → `canSync` true immediately.
- `triggerSync()` when `canSync` false / already `syncing` → **no** call to the
  injected `TRIGGER_SYNC` thunk (guarded).
- `triggerSync()` happy path → sets `syncing` true, awaits the thunk, on resolve
  writes a fresh ISO timestamp to `vultus_last_sync_at`, sets `syncing` false,
  `canSync` false (cooldown begins).
- Thunk rejects → `syncing` returns to false, the timestamp is **not** advanced
  (so the user may retry), failure is surfaced to the caller.
- `localStorage` unavailable/throws → degrades to "always allowed", no throw.

**Component — `scope:mobile` (`watchlist.page.spec.ts`, TestBed + Ionic; mocked
`SyncStateService`/`TRIGGER_SYNC`/`ToastController`):**

- Idle: the refresh button renders in `slot="end"`, enabled, `aria-label="Refresh
watchlist"`.
- Click → calls the service's `triggerSync()`; while `syncing()` the button shows
  the spinner and is `disabled`.
- Success → the success toast ("Watchlist synced") is presented.
- Failure → the error toast ("Sync failed — try again later", `color: 'danger'`)
  is presented.
- Cooldown (`canSync()` false) → the button is `disabled` with
  `aria-label="Synced just now"`.

**e2e — `scope:mobile` (REQUIRED — new primary action on a primary route):**
`apps/mobile-e2e/src/manual-sync-trigger.spec.ts`, named flow
**`manual-sync-trigger`**:

1. Boot the app logged-in (the spec-0019 emulator-backed e2e harness; seed a
   watchlist title for the test uid), land on the Watchlist tab.
2. Assert the toolbar refresh button is **visible and enabled**.
3. Tap it → assert the button enters the **loading/spinner state** (disabled,
   spinner shown).
4. Wait for the `triggerSync` callable to resolve against the **Functions
   emulator**.
5. Assert the **success toast** ("Watchlist synced") is shown.
6. Assert the button is **re-enabled** (after the toast / once cooldown UI logic
   permits — note: the 5-min cooldown will keep it disabled; the flow asserts the
   spinner clears and the success toast, then that the button shows the cooldown
   `aria-label="Synced just now"` disabled state — i.e. the sync completed, not
   that it is immediately tappable again).

> **e2e gate decision (per the rubric):** this is a `scope:mobile` feature adding
> a **primary user-facing action** → e2e is **REQUIRED**. **However**, the flow
> needs the **Functions emulator** running the `triggerSync` callable. If the
> spec-0019 e2e harness / CI does not yet run the **Functions emulator** (today
> `firebase.json` configures only firestore/auth/ui; task 2 adds the
> `functions:5001` entry, but CI must also **start** it), mark this spec
> **`test.fixme('manual-sync-trigger', …)`** with a comment naming the blocker
> ("Functions emulator not started in CI e2e harness — see spec 0019 /
> firebase.json `emulators.functions`"), and the implementer un-skips it once the
> Functions emulator is part of the e2e run. **Per project memory the Firestore/
> Functions emulator cannot run under Claude Code tools here (loopback blocked),
> so the implementing agent verifies this flow locally in the user's own terminal**
> (or leaves it `test.fixme` if the harness is not ready); CI is the automated
> gate where the emulator works. **Never silently omit** — ship either the live
> flow or the `test.fixme` stub.

## Definition of done

Tailored from the PLAN §5 / CLAUDE.md checklist to the four projects touched.

- [ ] `pnpm nx typecheck shared-domain functions-sync-titles functions mobile-watchlist mobile`
      passes — the `TRIGGER_SYNC` token, the `gatherUserWatchlistTitles` helper +
      `triggerSync` callable, the `SyncStateService` + button, and the shell
      provider all compile.
- [ ] `pnpm nx lint shared-domain functions-sync-titles functions mobile-watchlist mobile`
      passes **with Sheriff active**: the watchlist slice imports
      `@vultus/shared/domain` (incl. `TRIGGER_SYNC`), Ionic/AngularFire/ionicons
      (third-party) only — **no `@vultus/functions/*` import, no `@angular/fire/functions`
      import, no `apps/mobile` import, no other-slice import**. `apps/functions`
      imports `@vultus/functions/sync-titles` + `@vultus/shared/*` + Firebase only.
- [ ] `pnpm nx test functions-sync-titles` passes — the per-user gather unit test
      (mocked Admin SDK) green; the existing 0006/0007/0008/0009 tests still pass.
- [ ] `pnpm nx test functions` passes — the `triggerSync` handler unit tests
      (fake engine + fake `db`; no-auth → `unauthenticated`, deduped per-user
      gather, `{ syncedAt }`, **no `users/**`/`system/sync`write**, partial-error
    resolves) green; the existing`syncTitles` tests still pass.
- [ ] `pnpm nx test mobile-watchlist` passes — `SyncStateService` cooldown unit
      tests + the `WatchlistPage` button-state component tests green (mocked
      `TRIGGER_SYNC`/`ToastController`/`localStorage`; no network/emulator).
- [ ] `pnpm nx test mobile` passes — the `emulators.spec.ts` Functions-gating test
      green; the existing app/config tests still pass.
- [ ] `pnpm nx build functions` passes — the deployable barrel builds with **both**
      `syncTitles` (unchanged) and the new `triggerSync` exported.
- [ ] `pnpm nx build mobile` passes — the watchlist slice + shell Functions
      provider bundle cleanly within budgets.
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green
      (affected: `shared-domain`, `functions-sync-titles`, `functions`,
      `mobile-watchlist`, `mobile`).
- [ ] **e2e `manual-sync-trigger`** is present — either passing against the
      Functions+Firestore+Auth emulators (verified by the implementing agent
      **locally in the user's terminal**, since the emulator cannot run under
      Claude Code tools here) **or** `test.fixme`-gated with a comment naming the
      Functions-emulator-in-CI blocker. Never silently omitted.
- [ ] **`syncTitles` is byte-for-byte behaviourally unchanged** — the diff to
      `main.ts` only **adds** `triggerSync` (and at most an extracted shared
      `buildEngine` local that `syncTitles` provably still uses identically);
      `dispatchNotifications` export unchanged. Recorded in the PR.
- [ ] **Boundary verifications (review-checked):** (a) **no secret read/written** —
      params declared by name, read via `.value()` at runtime, never `.env.local`,
      never logged; (b) `triggerSync` writes **only** `title-cache` (via the engine
      port) — **no `users/**`write, no`system/sync`write**; (c) the mobile slice
    reaches the callable **only** via the`TRIGGER_SYNC`token (no
   `@angular/fire/functions`/ no`apps/mobile`import) and reaches the uid only
    via`AUTH_UID`; (d) **no cross-slice / cross-scope import** anywhere.
- [ ] **`sheriff.config.ts`, `firestore.rules`, `firestore.indexes.json` are NOT
      modified** (existing tags + rules already cover this — verified, recorded in
      the PR). `firebase.json` **is** modified (the Functions emulator entry).
- [ ] **READMEs updated in the same change** (CLAUDE.md lib-README rule):
      `libs/functions/sync-titles/README.md` (the gather helper + `triggerSync`),
      `libs/mobile/watchlist/README.md` (`SyncStateService` + the refresh button),
      and `libs/shared/domain/README.md` **if** it enumerates tokens
      (`TRIGGER_SYNC`).
- [ ] PR description records: the **Stitch Watchlist screen ID** used (or
      "Stitch screen NOT captured" as a blocking item), the exact verification
      commands, the **`syncTitles`-unchanged** confirmation, the no-secret /
      no-`users/**`-write / no-`system/sync`-write / token-only-callable-access
      boundary confirmations, the **no-`firestore.rules`/no-index-change**
      verification, and the e2e status (passing locally vs `test.fixme`-gated with
      the named blocker).

## Risks

- **PLAN §6 item 12 said "HTTPS callable"; spec 0009 resolved the cron path to
  `onRequest`.** This spec **honours both**: the cron keeps the `onRequest`
  `syncTitles` (shared secret), and the **manual** path gets the **callable**
  `triggerSync` (Firebase Auth) that PLAN §6 item 12 originally described. The two
  triggers share the engine, not the auth/gather machinery — a deliberate split,
  recorded here per the spec-author rule. **No silent PLAN departure.**
- **Client-side-only rate limiting.** The 5-minute cooldown lives in
  `localStorage`; clearing storage or a second device bypasses it. **Accepted for
  a personal single-user app** (locked decision) — there is no server gate on
  `triggerSync` (it does not touch `system/sync`). If multi-user ever lands, a
  server-side per-user `lastManualSyncAt` would be the upgrade — out of scope.
- **Callable region must match the deployment.** `httpsCallable` resolves the
  function by name in a region; the shell **must** call `getFunctions(app,
'europe-west1')` to match `setGlobalOptions({ region: 'europe-west1' })` in
  `main.ts`. A region mismatch silently 404s the callable (no boundary/auth
  error). Pinned in Public types / APIs + the shell task; verify in the PR.
- **The cron's `syncTitles` must not regress.** The biggest risk is "helpfully"
  refactoring `main.ts`. **Binding:** `triggerSync` is purely additive; any shared
  `buildEngine(db)` extraction must leave `syncTitles`' behaviour identical
  (its tests must still pass unchanged). Reviewer checks the `main.ts` diff is
  additive.
- **`triggerSync` syncs only the caller's titles, force-fresh (no staleness
  filter).** For a personal watchlist (dozens of titles) a full force pass is
  within the function wall-clock + the in-slice transport throttle (spec 0009
  "Scaling & limits"). If a user's watchlist ever grew very large, the manual
  force pass could approach the function timeout — acceptable at v1 volume;
  documented, not mitigated here.
- **e2e depends on the Functions emulator in CI.** Today `firebase.json` runs
  only firestore/auth/ui emulators and the spec-0019 e2e harness may not start the
  Functions emulator. Task 2 adds the `functions:5001` entry; if CI does not yet
  **start** it for e2e, the flow is `test.fixme`-gated with the named blocker
  (Test plan). Per project memory the emulator cannot run under Claude Code tools
  here, so the implementing agent verifies the flow **locally in the user's
  terminal**; CI is the automated gate once the Functions emulator is in the run.
- **Depends on specs 0008/0009 (engine + adapter) and 0010/0014 (shell + watchlist
  page) being merged.** The callable reuses `createSyncEngine` /
  `createFirestoreTitleCacheStore` (verify the merged barrel exports them — it
  does, per the current `src/index.ts`); the button is added to the merged
  `WatchlistPage` toolbar. If any of those contracts are absent in the worktree,
  **stop and flag the missing dependency** rather than recreating them.
- **AngularFire `Functions` injection is third-party, not a Sheriff violation.**
  `@angular/fire/functions` is external; the shell wires it in `app.config.ts`
  (its job) and hands the slice a `scope:shared` thunk via `TRIGGER_SYNC`, so the
  slice stays free of any AngularFire-functions import — mirroring the `AUTH_UID`
  pattern (spec 0014).
- **Data-source accuracy is the engine's concern, not this trigger's (PLAN §9).**
  `triggerSync` runs the same engine the cron runs; the Watchmode fallback is
  later. A manual refresh reflects whatever TMDB currently returns.
