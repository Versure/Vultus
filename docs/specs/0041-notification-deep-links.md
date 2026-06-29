---
number: 0041
slug: notification-deep-links
title: Display FCM push notifications and deep-link taps to the title-detail page
status: done
slices: [slice:title-detail]
scopes: [scope:mobile, scope:functions]
created: 2026-06-29
---

# Display FCM push notifications and deep-link taps to the title-detail page

## Context

Spec 0012 (`done`) built the notification dispatcher: a Firestore trigger that, on a
flatrate availability transition, writes a `users/{uid}/notifications/{id}` doc and
sends a **data-only** FCM message (`{ notificationId, titleId, kind, region, tmdbId }`,
all strings) to each of the user's registered tokens. Spec 0022 (`done`) requests
push permission at onboarding and registers the FCM token into `users/{uid}.fcmTokens`.
But two pieces are missing, and together they mean a user **never actually sees a
notification**:

1. A **data-only** FCM message is **not rendered by Android** when the app is
   backgrounded or terminated — the OS shows nothing. Decision 2 of spec 0012 ("no
   `notification` key") is correct for foreground-only handling but produces a silent
   miss in the background/terminated case, which is the common case for a "new episode
   dropped" push that arrives hours after the user closed the app.
2. There is **no app-side handler** for the push at all — nothing listens for
   `pushNotificationReceived` / `pushNotificationActionPerformed`, so even a rendered
   notification, when tapped, just opens the app on its last route instead of the title.

This spec closes both. On the backend it adds the Android-standard `notification:
{ title, body }` key to the dispatch message so the OS renders it natively (superseding
spec 0012 decision 2 for the wire payload only — the pure core lib's decision/transition
logic is untouched). On the app it adds a single shell-level handler service that:
deep-links a tap to `tabs/title-detail/:titleId`, shows an in-app Ionic toast when a
push arrives in the foreground, and marks the notification read on an explicit tap/view.

Intended outcome: a tracked title that becomes available, or a tracked show with a new
episode, produces a **system notification the user sees** (foreground toast or OS
notification), and **tapping it lands on that title's detail page** — completing the
PLAN §1 promise end to end (sync → detect → notify → **the user taps through to the
title**).

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **Add an FCM `notification` key (wire-payload change in
   `apps/functions/src/dispatch-notifications.ts` only).** Spec 0012 decision 2
   (data-only) is **superseded for the wire message** — the OS needs a `notification`
   key to render a backgrounded/terminated push. The pure core lib
   (`libs/functions/dispatch-notifications`) is **unchanged**; the addition is in the
   Admin-SDK wiring (`apps/functions/src`). See the **important wiring constraint** in
   Public types / APIs — the `notification` body needs `payload.title` /
   `payload.providerName`, which the current core does **not** carry into the FCM
   `data` record, so the actual edit lands in the `dispatch/` adapter layer, not
   literally the trigger file (Risks).
2. **Handler lives in the app shell (`apps/mobile`), not a slice lib.** A new
   `NotificationHandlerService` (`apps/mobile/src/app/notification-handler.service.ts`).
   No new Nx lib. The shell already owns routing and may reach every route; the handler
   is routing glue that spans slices (it navigates **to** `slice:title-detail` from a
   system event), which a slice lib must not do.
3. **Three listener paths** over `@capacitor/push-notifications` (already installed,
   spec 0022): **foreground** (`pushNotificationReceived`) → Ionic toast with a "View"
   action; **background/terminated tap** (`pushNotificationActionPerformed`) → navigate
   - mark read; **cold start from a tap** → same event, fired after bootstrap, so the
     handler must be initialised early. Wire `NotificationHandlerService.init()` from the
     shell root component's `ngOnInit()`.
4. **Mark as read on explicit tap only.** On a user tap (foreground "View" button, or
   background/terminated tap) write `readAt` to
   `users/{uid}/notifications/{notificationId}`. On foreground arrival (before the user
   taps) do **not** mark read. The `uid` comes from the injected `AUTH_UID` token. See
   the **doc-id caveat** in Data model touchpoints — the FCM `data.notificationId` must
   equal the Firestore doc id for this write to hit the right doc; today it does not, so
   this spec also pins the notification-store id (a small additive functions change).
5. **No new Nx lib, no Sheriff violation.** All mobile changes are in `apps/mobile`
   (`scope:mobile`). The service imports `@capacitor/push-notifications` (third-party),
   `@angular/router`, `@angular/fire/firestore`, `@vultus/shared/firestore-schema`
   (path helper + converter), `@vultus/shared/domain` (types), and the `AUTH_UID` token
   from `@vultus/shared/domain/tokens`. It imports **no** `slice:*` lib; navigation is
   by `Router.navigate(['tabs','title-detail', titleId])` with string segments.
6. **No e2e for the push path.** Testing live FCM delivery in Playwright is not
   feasible. Any notification-tap e2e scenario is `test.fixme` with
   `// requires live FCM; verify manually`. Coverage is **unit tests** on
   `NotificationHandlerService` with the plugin/`Router`/`Firestore`/`ToastController`
   mocked.

## Scope

In scope:

- **Backend wire-payload change:** add `notification: { title, body }` to the FCM
  message in the `apps/functions` dispatch layer, with per-kind copy (see Public types
  / APIs). Pin the notification-store doc id to the deterministic `notificationId` so
  the app's mark-as-read targets the right doc.
- **`NotificationHandlerService`** in `apps/mobile/src/app/` — an Angular injectable
  that registers the three `@capacitor/push-notifications` listeners, deep-links taps,
  shows the foreground toast, and marks read on tap.
- **Shell wiring:** call `NotificationHandlerService.init()` from `App.ngOnInit()`
  (native-only guard, mirroring the existing `initStatusBar` pattern in `app.ts`).
- **Unit tests** for `NotificationHandlerService` and the new functions copy/id logic.

Out of scope (explicitly):

- **FCM token registration / push permission** — done in spec 0022 (`OnboardingService`).
  This spec neither registers tokens nor prompts for permission.
- **The dispatcher's decision/transition logic** — spec 0012's pure core lib is
  untouched; only the wire payload (and the store doc id) change.
- **A notifications inbox/list screen** in the app (reading the
  `users/{uid}/notifications` collection for an in-app history) — a later mobile spec.
  This spec only routes/marks-read on a live push.
- **iOS push** — Android-only for v1 (the app ships Android; `Capacitor.isNativePlatform`
  guards apply, but APNs specifics are not addressed).
- **Per-kind notification channels / sound / icon customisation** — v1 uses the OS
  default channel for the `notification` key.
- **Re-running e2e against live FCM** — `test.fixme` only (decision 6).

## Affected slices & Sheriff tags

| Project         | Path             | Sheriff tags      | Change                                                                                               |
| --------------- | ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------- |
| mobile (app)    | `apps/mobile`    | `scope:mobile`    | **add** `notification-handler.service.ts` + spec; wire `init()` into `App.ngOnInit()` (`app.ts`)     |
| functions (app) | `apps/functions` | `scope:functions` | **add** `notification: { title, body }` to the FCM send; pin notification-store doc id; update specs |

- **No new lib, no `slice:title-detail` import.** The handler is in the **shell**
  (`apps/mobile/src/app`), which Sheriff tags `scope:mobile` and which legitimately
  imports slice barrels (it already does in `app.config.ts` / `app.routes.ts`).
  Navigation to the detail page uses **`Router` string segments** — the handler does
  **not** import `@vultus/mobile/title-detail`, so no cross-slice edge is created. The
  `slices: [slice:title-detail]` frontmatter tag records the **route target** the
  deep-link lands on (spec 0016 owns that route), not an import.
- **Import boundaries (mobile handler):** `@capacitor/push-notifications`,
  `@capacitor/core` (for `Capacitor.isNativePlatform`), `@angular/router`,
  `@angular/core`, `@angular/fire/firestore`, `@ionic/angular/standalone`
  (`ToastController`), `@vultus/shared/firestore-schema` (`notificationPath`,
  `notificationToData`/`Timestamp` mapping), `@vultus/shared/domain` +
  `@vultus/shared/domain/tokens` (`AUTH_UID`). `scope:mobile → scope:shared` and
  framework/third-party only — **no** `slice:*`, **no** `scope:functions`.
- **Import boundaries (functions):** the change stays in `apps/functions/src`
  (`scope:functions`); it already imports `firebase-admin/messaging` and
  `@vultus/shared/firestore-schema`. No new workspace edge.
- **No `shared/` extraction.** Nothing is hoisted to `shared/` (the "extract only at
  3+ slices" rule holds — this is one shell handler + one functions wiring change).

## Data model touchpoints

| PLAN §4 path                                 | Access     | By                                                                                                |
| -------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `users/{uid}/notifications/{notificationId}` | **update** | the handler writes `readAt` on an explicit tap/view (decision 4)                                  |
| `users/{uid}/notifications/{notificationId}` | **create** | functions: the notification-store id is pinned to the deterministic `notificationId` (see caveat) |

- **No new fields.** `NotificationDoc.readAt: string | null` already exists
  (`libs/shared/domain/src/lib/documents.ts`); the handler sets it via the schema
  converter's ISO→Timestamp mapping. `NotificationPayload` already carries `tmdbId`,
  `titleId`, `title`, `region`, `providerName?` (added in spec 0012) — **no domain
  change is needed**.
- **Mark-as-read write.** `updateDoc(doc(firestore, notificationPath(uid,
notificationId)), { readAt: <Timestamp.now()> })`. Match the existing mobile
  pattern in `libs/mobile/settings/src/lib/settings.service.ts` (inject `Firestore`,
  build the ref via the `@vultus/shared/firestore-schema` path helper
  `notificationPath(uid, notificationId)`, call AngularFire `updateDoc`). For the
  `readAt` value, write a Firestore `Timestamp` (use `Timestamp.now()` from
  `@angular/fire/firestore`, consistent with how the schema converter persists
  timestamps) so the field stays a `timestamp | null` per PLAN §4. The full-doc
  converter writes `readAt` as a JS `Date`, but a partial `updateDoc` cannot go
  through the whole-doc converter by design — writing a `Timestamp` directly is
  correct and storage-compatible (both land as a Firestore timestamp).
- **DOC-ID CAVEAT (load-bearing — this is why a functions change is in scope).** The
  FCM `data.notificationId` the app receives is the dispatcher's deterministic id
  `${tmdbId}-${region}-${kind}` (`libs/functions/dispatch-notifications/src/lib/
dispatcher.ts`), but the notification-store **adapter writes with an auto-generated
  Firestore id** (`apps/functions/src/dispatch/adapters.ts`
  `createFirestoreNotificationStore` uses `.collection(...).add(...)`). So
  `data.notificationId !== <Firestore doc id>` today — a mark-as-read keyed on
  `data.notificationId` would target a **non-existent** doc. **Fix in this spec:** change
  the adapter to write with the deterministic id —
  `db.doc(notificationPath(uid, doc.payload.<deterministic id>)).set(notificationToData(doc), { merge: true })` —
  so the doc id equals the id the app receives. The deterministic id is not currently
  carried on `NotificationDoc`; the simplest pin is to have the adapter recompute it
  the same way (`${doc.payload.tmdbId}-${doc.payload.region}-${doc.kind}`) — keep that
  derivation in **one** place so the FCM `data.notificationId` and the doc id cannot
  drift. State the chosen single source in the PR. (This is the spec-0012 decision 3
  "deterministic id so a re-fire overwrites" upgrade path, now load-bearing.)
- **No `firestore.rules` change for the read/update.** The mark-as-read is a
  client-side `updateDoc` on the user's own `users/{uid}/notifications/**` doc, which
  the existing rules already permit for the authenticated owner (spec 0010's per-user
  rules). **Verify** the rules allow an owner `update` on the notifications subcollection;
  if they do not (e.g. notifications are server-write-only), record it as a blocking open
  item rather than silently widening rules — a rules change would be its own decision.

## Public types / APIs

No new domain types, no new HTTP/callable endpoint. One new app-shell service and one
functions wire-payload change.

### `NotificationHandlerService` (`apps/mobile/src/app/notification-handler.service.ts`)

```ts
import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Firestore, Timestamp, doc, updateDoc } from '@angular/fire/firestore';
import { ToastController } from '@ionic/angular/standalone';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import { notificationPath } from '@vultus/shared/firestore-schema';

@Injectable({ providedIn: 'root' })
export class NotificationHandlerService {
  private readonly router = inject(Router);
  private readonly firestore = inject(Firestore);
  private readonly toastController = inject(ToastController);
  private readonly uid = inject(AUTH_UID);

  /** Register the three push listeners. Native-only; a no-op in the browser
   *  (web has no @capacitor/push-notifications backend). Idempotent — guard so a
   *  double init() does not double-register listeners. Called from App.ngOnInit. */
  init(): Promise<void>;
}
```

- The FCM `data` payload shape the handler reads (all string values, from spec 0012):
  `{ notificationId, titleId, kind, region, tmdbId }`. The **route param** is
  `data.tmdbId` (spec 0016: `title-detail/:titleId` where `titleId = String(tmdbId)`).
  Navigate with `this.router.navigate(['tabs', 'title-detail', data.tmdbId])`.
  (Note `data.titleId` is the watchlist doc key, which equals `String(tmdbId)` in
  current slices — use `data.tmdbId` as the canonical route segment; if a future
  divergence makes `titleId !== String(tmdbId)`, the route segment stays `tmdbId`.)
- **Foreground** (`PushNotifications.addListener('pushNotificationReceived', …)`):
  present an Ionic toast via the injected `ToastController` (shape below). Do **not**
  navigate and do **not** mark read on arrival; only the "View" button action does both.
- **Background / terminated tap** (`addListener('pushNotificationActionPerformed', …)`):
  the default tap `actionId` is `'tap'`. Read `event.notification.data`, navigate, and
  mark read. This same event fires on a **cold start** from a tap (after bootstrap), so
  `init()` must run in `App.ngOnInit()` before the user can interact — registering the
  listener early ensures the queued cold-start action is delivered to it.
- **Mark read:** `const id = this.uid(); if (id) await updateDoc(doc(this.firestore,
notificationPath(id, data.notificationId)), { readAt: Timestamp.now() });` Guard the
  null uid (pre-auth) — skip the write rather than throw (mirrors the slices' uid guard).
  Wrap navigation/mark-read in try/catch so a Firestore failure never blocks the
  navigation (mark-read is best-effort, like the onboarding push flow).
- **Native guard + idempotency:** `if (!Capacitor.isNativePlatform()) return;` at the
  top of `init()`; a private `initialized` flag so a second `init()` does not add
  duplicate listeners.

### Ionic toast call shape (foreground, decision 3)

The foreground in-app notification is an Ionic `ToastController` toast — there is **no
Stitch screen** for it (it is a transient system affordance, not a designed page). Pin
the call options:

```ts
const toast = await this.toastController.create({
  message: notification.body ?? notification.title ?? 'New notification',
  duration: 4000, // 4 seconds (decision 3)
  position: 'top', // below the status bar; the tab bar owns the bottom
  buttons: [
    {
      text: 'View',
      role: 'info',
      handler: () => {
        // navigate + mark read (same path as a background tap)
      },
    },
  ],
});
await toast.present();
```

- The toast uses the app's default Ionic theming (`shared/ui-kit` `theme.scss` —
  dark surface, `--vultus-*` vars); **do not** hand-set colors. `color` may be left
  default (`dark`/surface) — do not invent a hex. `duration: 4000`, `position: 'top'`.
- The "View" button `handler` runs the **same** navigate + mark-read code as the
  background tap (extract a private `openTitle(data)` method so both paths share it).
- If the user does not tap "View", the toast auto-dismisses at 4s and the notification
  is **not** marked read (decision 4).

### Functions wire-payload change (`apps/functions/src/dispatch/…`)

Add `notification: { title, body }` to the Admin-SDK `messaging.send(...)` call
alongside the existing `data`. **Important wiring constraint:** the `send` happens in
`createMessagingFcmSender` (`apps/functions/src/dispatch/adapters.ts`), and the
human-readable copy needs `payload.title` and `payload.providerName` — which the core
lib's FCM `data` record does **not** currently carry (it sends only `notificationId,
titleId, kind, region, tmdbId`, and the core sets `payload.title = ''`). So the literal
edit cannot be "only `dispatch-notifications.ts`" as briefed. **Implement it thus,
keeping the pure core lib unchanged:** build the `notification` block in the
`apps/functions` layer from the title metadata that layer already has access to —
`handleDispatch` in `dispatch-notifications.ts` reads the `title-cache/{tmdbId}` doc
(for `type`); have it also read `metadata.title` and pass title + per-kind copy into the
adapter so `createMessagingFcmSender.send` can attach `notification`. Equivalent option:
widen the `FcmSender.send` data record (in the adapter call site) to include
`title`/`providerName` strings and build the `notification` in the adapter. Pick one,
keep the copy derivation in a single helper, and **do not** modify
`libs/functions/dispatch-notifications` (the pure core). Record the chosen wiring in the
functions README / PR.

Per-kind copy (fields from the title metadata + `payload.providerName`):

- `kind: 'movie-available'` → `{ title: 'Now available to stream', body: '<title> is
available on <providerName ?? 'a streaming platform'>' }`
- `kind: 'show-came-to-platform'` → `{ title: 'Now available to stream', body: '<title>
is available on <providerName ?? 'a streaming platform'>' }`
- `kind: 'episode-aired'` → `{ title: 'New episode available', body: '<title> has a new
episode on <providerName ?? 'a streaming platform'>' }`

Also pin the notification-store doc id to the deterministic `notificationId` (Data model
caveat) so the app's mark-as-read targets the right doc.

## UI / Stitch screen refs

No Stitch screen. The only UI surface is the foreground Ionic toast, fully specified by
the `ToastController.create` call shape above (message = notification body, `duration:
4000`, `position: 'top'`, one "View" button). It inherits `shared/ui-kit` theming; no
new tokens, no design-system change. The deep-link target — the `title-detail/:titleId`
page — is owned and styled by spec 0016 and is **not** modified here. (Per CLAUDE.md the
toast is a transient system affordance, not a designed page, so "no Stitch screen" is the
correct, intentional outcome — not a skipped capture.)

## Implementation task graph

No shared-domain change is required (`NotificationPayload`/`readAt` already exist), so
there is **no `[sequential]` foundation task**. The two tasks touch disjoint projects
(`apps/mobile` vs `apps/functions`) with non-overlapping file manifests and may run
**concurrently**.

1. **[parallel] Mobile: `NotificationHandlerService` + shell wiring (`scope:mobile`).**
   frontend-engineer.
   - Add `apps/mobile/src/app/notification-handler.service.ts` per Public types / APIs:
     `init()` (native guard + idempotency), the three listeners, the shared
     `openTitle(data)` (navigate `['tabs','title-detail', data.tmdbId]` + best-effort
     mark-read via `updateDoc` on `notificationPath(uid, data.notificationId)`), and the
     foreground toast (`ToastController`, `duration: 4000`, `position: 'top'`, "View").
   - Wire `inject(NotificationHandlerService).init()` into `App.ngOnInit()` in
     `apps/mobile/src/app/app.ts` (fire-and-forget `void`, native-guarded, mirroring the
     existing `initStatusBar` pattern).
   - Add unit tests (Test plan): mock `PushNotifications`, `Router`, `Firestore`/
     `updateDoc`, `ToastController`, and the `AUTH_UID` signal.
   - File manifest:
     - `apps/mobile/src/app/notification-handler.service.ts`
     - `apps/mobile/src/app/notification-handler.service.spec.ts`
     - `apps/mobile/src/app/app.ts` (add the `init()` call)
     - `apps/mobile/src/app/app.spec.ts` (only if it asserts `ngOnInit` behaviour)
     - `apps/mobile/README.md` (note the new shell service, if it enumerates shell services)

2. **[parallel] Functions: `notification` key + pinned doc id (`scope:functions`).**
   backend-engineer.
   - Add the `notification: { title, body }` block to the FCM `messaging.send(...)`
     call with the per-kind copy (Public types / APIs), wired so the pure core lib stays
     unchanged: read `metadata.title` in `handleDispatch` (it already reads the
     `title-cache` doc for `type`) and thread title + copy into the adapter; keep the
     copy in one helper.
   - Pin `createFirestoreNotificationStore.write` to the deterministic id
     (`db.doc(notificationPath(uid, id)).set(notificationToData(doc), { merge: true })`,
     id = `${payload.tmdbId}-${payload.region}-${kind}`) so the FCM `data.notificationId`
     equals the Firestore doc id (Data model caveat). **Note:** for `episode-aired`,
     multiple aired episodes of the same show in the same region share one doc id —
     a second dispatch overwrites (merge) the first notification doc rather than
     duplicating it; this is intentional for v1 (the push still fires per send; only
     the stored doc collapses).
   - Update/extend the functions unit tests: the `notification` block is attached with
     the correct per-kind copy and `providerName` fallback; the store writes to the
     deterministic doc id; the existing spec-0012 wiring tests are **updated** for the
     new send shape and still pass; the SDK-free core lib is unmodified.
   - File manifest:
     - `apps/functions/src/dispatch-notifications.ts`
     - `apps/functions/src/dispatch/adapters.ts`
     - `apps/functions/src/dispatch-notifications.spec.ts` (and/or an adapter spec)
     - `apps/functions/README.md` (note the wire-payload change, if it documents the trigger)

The two manifests are **pairwise disjoint** (`apps/mobile/**` vs `apps/functions/**`),
so the orchestrator may fan them out concurrently. Neither task touches
`libs/functions/dispatch-notifications` (the pure core stays unchanged) or any
`shared/` lib.

## Test plan

Per the PLAN §5 pyramid: **unit** tests for both tasks; **no component** test (the only
UI is a transient toast, exercised at unit level via a mocked `ToastController`);
**e2e** is decision-6 `test.fixme` (see rubric outcome below).

**Mobile — `notification-handler.service.spec.ts` (Vitest, all collaborators mocked):**

- `init()` is a **no-op in the browser** (`Capacitor.isNativePlatform()` false) — no
  listener registered.
- `init()` on native registers `pushNotificationReceived` and
  `pushNotificationActionPerformed`; a **second** `init()` does not double-register
  (idempotency flag).
- **Background tap** (`pushNotificationActionPerformed`, `actionId: 'tap'`,
  `data: { notificationId:'603-NL-movie-available', titleId:'603', tmdbId:'603',
kind:'movie-available', region:'NL' }`): `Router.navigate` called with
  `['tabs','title-detail','603']`; `updateDoc` called once on
  `notificationPath(uid,'603-NL-movie-available')` with `{ readAt: <Timestamp> }`.
- **Foreground arrival** (`pushNotificationReceived`): `ToastController.create` called
  with `duration: 4000`, `position: 'top'`, a "View" button, and `message` = the push
  body; **no** `Router.navigate` and **no** `updateDoc` on arrival.
- **Foreground "View" tap:** invoking the button `handler` runs the **same**
  navigate + mark-read as the background tap (shared `openTitle`).
- **Null uid guard:** when `AUTH_UID` signal is `null`, the tap still navigates but
  **skips** `updateDoc` (no throw).
- **Mark-read failure is non-fatal:** an `updateDoc` rejection is caught; navigation
  still happened.
- **Route segment is `tmdbId`:** navigation uses `data.tmdbId` (assert the exact segment).

**Functions — `dispatch-notifications.spec.ts` / adapter spec (Vitest, fake `db`/
`messaging`):**

- `messaging.send` is called with **both** `data` (unchanged 0012 shape) **and**
  `notification: { title, body }`; per-kind copy is correct for each of
  `movie-available`, `show-came-to-platform`, `episode-aired`.
- `providerName` fallback: when `payload.providerName` is absent the body uses
  `'a streaming platform'`.
- The notification store writes to the **deterministic doc id**
  (`${tmdbId}-${region}-${kind}`), not an auto-id — assert the `db.doc(path).set(...)`
  path equals `notificationPath(uid, '${tmdbId}-${region}-${kind}')`.
- **Regression:** the existing spec-0012 wiring tests are **updated** for the new
  `messaging.send` call shape (the payload now includes `notification` alongside `data`)
  and still pass; the pure core lib (`libs/functions/dispatch-notifications`) is
  byte-unchanged (the diff touches only `apps/functions/src`).

**e2e (decision 6 — rubric outcome: Fixme-gated):** a `notification tap deep-links to
title detail` flow is **`test.fixme`** in `apps/mobile-e2e` with
`// requires live FCM; verify manually` — Playwright cannot deliver a real FCM push, and
there is no mock push bridge. Do **not** add a passing e2e that fakes the OS event (it
would assert nothing real). Manual verification recipe for the PR:
`pnpm nx run mobile:android-usb`, background the app, trigger a dispatch (or send a test
push), confirm the OS notification renders and tapping it opens the correct title.

Component tests: **none** (no designed page; the toast is covered by the service unit
test). Emulator: **none** (mark-read is asserted via a mocked `updateDoc`; the emulator
cannot run under Claude Code tools here — project memory).

## Definition of done

Tailored from the PLAN §5 checklist to the two projects touched. `<app(mobile)>` =
`mobile`; `<app(functions)>` = `functions`. No component/e2e gate (decision 6 + no
designed page).

- [ ] `pnpm nx typecheck mobile` passes — the handler service + shell wiring compile.
- [ ] `pnpm nx typecheck functions` passes — the `notification` block + pinned doc id
      compile; the pure core lib is unchanged.
- [ ] `pnpm nx lint mobile` passes **with Sheriff active**: the handler imports only
      framework / third-party / `@vultus/shared/*` — **no** `slice:*`, **no**
      `scope:functions`; navigation is by `Router` string segments (no
      `@vultus/mobile/title-detail` import).
- [ ] `pnpm nx lint functions` passes with Sheriff: the change stays in
      `apps/functions/src`; `libs/functions/dispatch-notifications` is untouched.
- [ ] `pnpm nx test mobile` passes — `NotificationHandlerService` unit tests green
      (native no-op, idempotent init, background tap navigate+mark-read, foreground
      toast, "View" handler, null-uid guard, mark-read-failure non-fatal,
      `tmdbId` route segment).
- [ ] `pnpm nx test functions` passes — the `notification`-block + per-kind copy +
      `providerName` fallback + deterministic-doc-id tests green; **the existing
      spec-0012 tests still pass**.
- [ ] `pnpm nx build mobile` and `pnpm nx build functions` pass.
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green (affected:
      `mobile` + `functions` and any dependents).
- [ ] The new shell service is `apps/mobile/src/app/notification-handler.service.ts` and
      is `init()`-ed from `App.ngOnInit()` (native-guarded, fire-and-forget).
- [ ] **Boundary verifications (review-checked):** (a) the handler creates **no**
      cross-slice import — it reaches the detail page only via `Router` string segments;
      (b) the only Firestore write is the owner's `users/{uid}/notifications/{id}.readAt`
      update on an **explicit tap** (not on foreground arrival); (c) the pure core lib
      `libs/functions/dispatch-notifications` is **unchanged** — the wire-payload change
      lives only in `apps/functions/src`; (d) **no secret is read or written**; (e) the
      FCM `data.notificationId` and the Firestore doc id are derived from a **single**
      `${tmdbId}-${region}-${kind}` source so they cannot drift.
- [ ] READMEs updated where they enumerate the changed surface (`apps/mobile`,
      `apps/functions`) per the CLAUDE.md README rule.
- [ ] PR description records the verification commands, the manual FCM-tap check
      (`mobile:android-usb` recipe), the chosen `notification`-wiring approach (which
      file builds the copy), and the `firestore.rules` owner-update verification result.

## Risks

- **Decision 1 cannot be a one-file edit as briefed.** The brief states the
  `notification` key is added "ONLY in `apps/functions/src/dispatch-notifications.ts`"
  and "the pure core lib is unchanged". The first half is not literally achievable: the
  `messaging.send(...)` call is in `apps/functions/src/dispatch/adapters.ts`
  (`createMessagingFcmSender`), and the body copy needs `payload.title` /
  `payload.providerName`, which the core's FCM `data` record does not carry and the core
  sets `payload.title = ''`. **Resolution (in scope):** build the `notification` block
  in the `apps/functions` layer (thread `metadata.title` from `handleDispatch`'s
  existing `title-cache` read into the adapter), keeping `libs/functions/
dispatch-notifications` unchanged. The "core unchanged" half of decision 1 **is**
  honoured; the "single file" half is relaxed to "the `apps/functions` dispatch layer".
  Flagged so the implementer does not waste effort trying to edit only the trigger file
  or, worse, modify the pure core.
- **Doc-id mismatch breaks mark-as-read unless the store id is pinned (decision 4).**
  The FCM `data.notificationId` is `${tmdbId}-${region}-${kind}` but the notification
  store writes with an **auto-generated** Firestore id (`.add(...)`), so a mark-as-read
  keyed on `data.notificationId` would hit a non-existent doc. This spec pins the store
  to the deterministic id (Data model caveat) — a small additive functions change that
  is **load-bearing for the feature to work**, not optional. A reviewer must confirm the
  id is derived in one place so the wire id and the doc id cannot drift. Side effect: the
  deterministic id makes a re-fired trigger **overwrite** rather than duplicate (the
  spec-0012 decision-3 upgrade path) — a behaviour change from 0012's at-least-once
  duplicates, called out here so it is intentional.
- **`firestore.rules` may forbid a client update on notifications.** Mark-as-read is a
  **client** `updateDoc`. If the rules make `users/{uid}/notifications/**`
  server-write-only, the update silently fails (caught as best-effort) and `readAt`
  never persists. The implementer must **verify** the owner-update rule; if it is
  missing, that is a **blocking open item** (a rules change is a separate decision), not
  something to widen silently.
- **`data.titleId` vs `data.tmdbId` for the route.** Spec 0016's route param is
  `String(tmdbId)`; current slices set the watchlist doc key = `String(tmdbId)`, so
  `data.titleId` and `data.tmdbId` coincide today. This spec routes on **`data.tmdbId`**
  as the canonical segment; if a future change makes them diverge, the route stays
  `tmdbId`. Flagged so the implementer picks `tmdbId` deliberately.
- **No automated e2e for the push path (decision 6).** Playwright cannot deliver a real
  FCM push; the tap deep-link is `test.fixme` + a manual `android-usb` check. The DoD
  cannot gate on it — the feature-reviewer relies on the unit tests + the manual recipe
  in the PR. Stated so the omission is intentional, not an oversight.
- **Android-only display assumptions.** The per-kind copy + default channel assume the
  Android `notification`-key rendering path. iOS/APNs is out of scope (the app ships
  Android); no APNs-specific keys are set.
- **PLAN alignment.** This completes PLAN §1's "push notification when a new episode
  drops or a movie becomes available" by making the push **visible** and **actionable**.
  It supersedes spec 0012 decision 2 (data-only) for the **wire payload** only — an
  intentional, documented revision, not a silent conflict — and leaves 0012's pure
  decision/transition core intact.
