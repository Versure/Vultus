---
number: 0022
slug: onboarding-flow
title: Add the first-launch onboarding flow — region pick + push-permission grant + FCM token registration before the tabs shell
status: implementing
slices: [slice:onboarding]
scopes: [scope:mobile, scope:shared]
created: 2026-06-25
---

# Add the first-launch onboarding flow — region pick + push-permission grant + FCM token registration before the tabs shell

## Context

PLAN §6 item 22 — **onboarding** — is the first-launch gate that runs **once**
before the user ever reaches the tabs shell. Everything before it is built: the
tabs shell with AngularFire init + anonymous auth and the `AUTH_UID` token (spec
0010), the settings / search / watchlist / title-detail slices (0011, 0013,
0014, 0016), the e2e harness + `mock` serve profile (0018/0019), and the native
Android platform with `@capacitor/push-notifications` installed and synced but
**never invoked** (spec 0020 explicitly deferred the permission prompt and token
registration "to onboarding"). Today, a fresh install drops the user straight on
`/tabs/watchlist` with no region prompt and no push permission; `users/{uid}` is
created only **lazily** when the user happens to open Settings (spec 0011), and
`fcmTokens` is always `[]` (no real token has ever been written).

This spec adds a new **`slice:onboarding`** lib (`libs/mobile/onboarding`),
lazy-routed at `/onboarding`, plus a route guard on `tabs` in the shell. On first
launch the guard sees no completion flag and redirects to a single onboarding
page; the page collects the streaming **region**, explains and requests **push
notification permission**, and on "Get started":

- writes/creates `users/{uid}` with the chosen region + default `notificationPrefs`
  - empty `fcmTokens` (so onboarding — not the lazy settings read — is the normal
    creator of the user doc);
- if push permission is granted, registers for FCM and writes the received token
  into `users/{uid}.fcmTokens` (the **first** real token write in the app);
- records completion in Capacitor `Preferences` (`onboarding_done = 'true'`) and
  navigates to `/tabs/watchlist`.

Intended outcome: a fresh install lands on the onboarding page, not the tabs;
after "Get started" the user doc exists with their region, push permission has
been requested (and, if granted, a token is persisted), the completion flag is
set, and the app proceeds to the watchlist. On every subsequent launch the guard
sees the flag and goes straight to the tabs. A reinstall clears `Preferences`, so
the user re-onboards — desired behaviour.

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **New `libs/mobile/onboarding` lib** — a brand-new Nx lib, Sheriff-tagged
   `scope:mobile` + `slice:onboarding` (by the existing `libs/mobile/<slice>/src`
   path glob — **no `sheriff.config.ts` edit**, see Affected slices), lazy-loaded at
   the Angular route `/onboarding`. The lib owns the page, the data/permission
   service, and the route guard; the shell (`apps/mobile`) owns the route wiring and
   the guard registration on `tabs`.

2. **Route guard on `tabs`.** A `CanActivateFn` (`onboardingGuard`) is added to the
   `tabs` route in `apps/mobile/src/app/app.routes.ts`. On each route activation the
   guard reads Capacitor `Preferences` for `'onboarding_done'`: if the value is
   `'true'` it allows navigation to `tabs`; otherwise it redirects to `/onboarding`
   (returning a `UrlTree`). The guard **lives in the slice** and is re-exported from
   its barrel so the shell imports it via `@vultus/mobile/onboarding` (a `scope:mobile`
   importing a `slice:onboarding` barrel — allowed; see Affected slices).

3. **Single-page onboarding screen** — one Angular/Ionic page (`OnboardingPage`), no
   wizard/multi-step: a welcome header, a region picker (`IonSelect` over the shared
   `REGIONS`), an explanation + control for notifications, and a "Get started"
   `IonButton`.

4. **Region selection reuses the shared `REGIONS` / `Region`** from
   `@vultus/shared/domain` (already the ten regions `NL, DE, GB, US, FR, BE, ES, IT,
CA, AU` — widened by spec 0011; **no domain change needed here**). Default `NL`,
   changeable in the picker. On "Get started" the slice **creates/writes**
   `users/{uid}` with the chosen region + default `notificationPrefs: { episodeAired:
true, movieAvailable: true, cameToPlatform: true }` + `fcmTokens: []` via the
   shared `@vultus/shared/firestore-schema` converters. This makes **onboarding** the
   normal creator of the user doc. The settings slice's eager read-or-create (spec 0011) still works correctly if the user somehow reaches settings without
   onboarding, but on the normal path the doc already exists.

5. **FCM token registration — full: request permission + write token.** On
   "Get started", after the user-doc write:
   a. Call `PushNotifications.requestPermissions()` (`@capacitor/push-notifications`).
   b. If `receive === 'granted'`: call `PushNotifications.register()`, listen for the
   `'registration'` event, and write the received token into `users/{uid}.fcmTokens`
   (see Data model — the field is `FcmToken[]`, **not** `string[]`; see Risks for
   the resolution and how `arrayUnion` is applied).
   c. If `receive === 'denied'`, or on **any** push-notifications error, **proceed
   silently** — never block onboarding completion. The user can grant later via
   device settings; `fcmTokens` stays `[]`.
   d. `PushNotifications` is a native Capacitor plugin, **unavailable in browser/dev**.
   The service **must guard on `Capacitor.isNativePlatform()`** and skip the entire
   push flow gracefully in-browser (web build, `mock` serve, e2e smoke) — the
   region write + completion flag must still run.

6. **Onboarding-done state via Capacitor `Preferences`** (`@capacitor/preferences`).
   After all of the above, write `{ key: 'onboarding_done', value: 'true' }`. The
   guard reads `Preferences.get({ key: 'onboarding_done' })` on activation. On
   reinstall `Preferences` are cleared → the user re-onboards (desired). **NB:
   `@capacitor/preferences` is NOT part of `@capacitor/core` and is NOT installed
   today** — it is a separate package that must be added (sequential task 1; see
   Risks; this corrects the decision record's note).

7. **Sheriff boundaries.** The `slice:onboarding` lib:
   - May import `scope:shared` (`@vultus/shared/domain`,
     `@vultus/shared/firestore-schema`, `@vultus/shared/domain/tokens`) and
     `slice:onboarding` (its own) only.
   - Obtains the uid via the **`AUTH_UID`** token from `@vultus/shared/domain/tokens`
     (already provided at the app root by the shell in `app.config.ts`). **Never
     imports `apps/mobile`.**
   - Imports **no other slice** (`slice:settings` etc.) — no cross-slice import, no
     duplication of settings logic.
   - The route guard lives in the slice and is **barrel-exported** so
     `apps/mobile/app.routes.ts` imports it via `@vultus/mobile/onboarding`.

8. **`app.routes.ts` change (shell, not slice).** Add `canActivate: [onboardingGuard]`
   to the `tabs` route, and a new top-level `/onboarding` route lazy-loading
   `OnboardingPage` from `@vultus/mobile/onboarding`. After completion the page
   navigates to `/tabs/watchlist`.

9. **No domain type change.** `User` (with `notificationPrefs` + `fcmTokens:
FcmToken[]`), `Region`/`REGIONS`, and the `AUTH_UID` token all already exist in
   `@vultus/shared/domain`; the converters/paths exist in
   `@vultus/shared/firestore-schema`. **Reuse them — add no shared type.** (The only
   `scope:shared`-tagged touch is the new `slice:onboarding` lib itself; the
   `shared/*` libs are read-only consumers here.)

10. **Out of scope** (each its own later spec / explicitly excluded):
    - **Per-type notification preferences** (separate episode/movie/platform toggles) —
      still deferred (PLAN §6 item 14 / the dispatcher spec).
    - **Settings tab behaviour** — unchanged; region/notification edits post-onboard
      continue to go through the settings slice (spec 0011). This spec does **not**
      touch `libs/mobile/settings`.
    - **Emulator-backed e2e for the navigation/region flows IS in scope** (three flows —
      F-onboard-1/2/3 — in a new `apps/mobile-e2e/src/onboarding.spec.ts`; see Test plan).
      Only the **native FCM path** (the push-permission dialog + the token write) is
      **device-only** — it has no browser runtime and is never exercised in e2e. (A
      `mock`-profile manual smoke is also encouraged for visual verification — see Test
      plan.)
    - **iOS** (no `ios/` platform — PLAN §1) and **multi-device token rotation /
      token-removal-on-sign-out** (only the additive `arrayUnion` write here).
    - **A skippable / "remind me later" onboarding, analytics, or A/B variants.**

## Scope

In scope:

- **New `libs/mobile/onboarding` lib** generated via the Nx Angular library
  generator, tagged `scope:mobile` + `slice:onboarding` by the existing path glob,
  with a barrel, a real `README.md`, and tests.
- **`OnboardingPage`** — a single standalone Ionic page (welcome header, region
  `IonSelect`, notifications explanation/toggle, "Get started" `IonButton`),
  render-able under the `mock` serve profile (no Firebase, no native plugins).
- **`OnboardingService`** — slice data-access + permission orchestration: injects
  AngularFire `Firestore` + the `AUTH_UID` token; on `complete(region)` writes/creates
  `users/{uid}` (decision 4), runs the native push flow (decision 5, guarded by
  `Capacitor.isNativePlatform()`), and sets the `Preferences` completion flag
  (decision 6). Exposes the selectable `regions` and the chosen region state for the
  page.
- **`onboardingGuard`** — a `CanActivateFn` reading the `Preferences` flag, returning
  `true` or a redirect `UrlTree` to `/onboarding`. Barrel-exported.
- **Shell route wiring** in `apps/mobile/src/app/app.routes.ts`: `canActivate:
[onboardingGuard]` on `tabs`; a new lazy `/onboarding` route.
- **Add `@capacitor/preferences`** (and confirm `@capacitor/push-notifications`,
  already present from spec 0020) to the **root `package.json`** at a Capacitor-8
  compatible pinned version; lockfile + (if needed) `pnpm-workspace.yaml` allowBuilds
  updated (see Risks / project memory). Run `cap sync android` so the plugin resolves
  natively.
- **A `mock`-profile providers swap** for `OnboardingService` (mirroring spec
  0018's `settings.providers.mock.ts`) so the page renders in the browser without
  Firebase/native plugins.
- `libs/mobile/onboarding/README.md` (real public surface, behaviour, Sheriff tags).
- Tests (see Test plan).

Out of scope (see decision 10 for the full list): per-type notification prefs;
any `libs/mobile/settings` change; emulator-backed e2e + `ci.yml`/`playwright`
changes; iOS; multi-device token rotation / sign-out token removal; skippable
onboarding / analytics; `firestore.rules` / `firestore.indexes.json` changes (the
existing owner-only `users/{uid}` rules already cover the onboarding write — see
Data model).

## Affected slices & Sheriff tags

| Project / area     | Path                                                    | Sheriff tags                       | Change                                                                                   |
| ------------------ | ------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| mobile-onboarding  | `libs/mobile/onboarding`                                | `scope:mobile`, `slice:onboarding` | **new lib** — `OnboardingPage`, `OnboardingService`, `onboardingGuard`, barrel, README   |
| mobile (app/shell) | `apps/mobile/src/app/app.routes.ts`                     | `scope:mobile`                     | add `onboardingGuard` to `tabs`; add lazy `/onboarding` route                            |
| Root deps          | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` | none (root)                        | add `@capacitor/preferences` (pinned, Capacitor-8); allowBuilds only if genuinely needed |

- **Tagging is by PATH GLOB in `sheriff.config.ts`** (`'libs/mobile/<slice>/src':
['scope:mobile', 'slice:<slice>']`). A new `libs/mobile/onboarding/src`
  **inherits `['scope:mobile', 'slice:onboarding']` automatically** the moment the
  lib is generated — **this spec does NOT edit `sheriff.config.ts`.** (`slice:onboarding`
  is not yet in the comment vocabulary in `sheriff.config.ts`; updating that
  doc-comment is optional polish, not required for the rule to apply — the glob is what
  enforces.)
- **Import boundaries (verified against the merged `sheriff.config.ts` rules):**
  - `libs/mobile/onboarding` (`slice:onboarding`) may import `['scope:shared',
sameTag]` only. It imports `@vultus/shared/domain` (`Region`/`REGIONS`/`User`/
    `FcmToken`), `@vultus/shared/domain/tokens` (`AUTH_UID`), and
    `@vultus/shared/firestore-schema` (`userPath`, `userToData`/`dataToUser`) — **all
    `scope:shared`, allowed (rule 4).** It imports **no other slice**.
  - It injects AngularFire `Firestore` and the `@capacitor/*` plugins
    (`PushNotifications`, `Preferences`, `Capacitor`) — **all third-party**, not
    policed by Sheriff (which governs only `scope:`/`slice:` workspace edges).
  - **uid via the `AUTH_UID` token, never `ShellAuthService`.** `ShellAuthService`
    lives in `apps/mobile` (`scope:mobile`); a `slice:onboarding` lib **cannot import
    `apps/mobile`** (even a type-only import is a forbidden Sheriff edge). The token is
    already provided at root (`app.config.ts`), so the slice injects
    `AUTH_UID` — exactly the spec-0011 pattern. **No 0010 dependency to flag** (unlike
    0011's authoring time, the token now exists).
  - **The shell importing the slice barrel is allowed (rule 3).** `apps/mobile`
    (`scope:mobile`) importing `@vultus/mobile/onboarding`'s `onboardingGuard` /
    `OnboardingPage` is `scope:mobile → scope:mobile` — permitted. (The lazy
    `loadComponent` import of `OnboardingPage` follows the same pattern the shell
    already uses for every slice page.)
  - **No `scope:functions` file is touched.**
- **No `shared/` extraction.** The onboarding service's write-user-doc + push-flow +
  preferences logic lives **inside the slice** — used by exactly **one** slice, far
  short of the 3+-slice rule (CLAUDE.md / PLAN §3). The user-doc create overlaps
  conceptually with the settings slice's eager create, but **deliberately is NOT
  shared**: it is the same shape in two slices (2 < 3), and vertical-slice + "don't
  DRY across slices" say leave the small duplication in place rather than extract a
  shared writer. Only the **types + path/converter** helpers are shared, and they
  already exist.

## Data model touchpoints

PLAN §4 `users/{uid}` is the only document touched. **The shape is already defined
and converter-backed** (`@vultus/shared/domain` `User`/`FcmToken`/`NotificationPrefs`,
`@vultus/shared/firestore-schema` `userPath` / `userToData` / `dataToUser`) — this
spec **reuses** it; it does not redefine it.

| PLAN §4 path     | Access by this slice         | Fields                                                                                                                                                                           |
| ---------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users/{uid}`    | **create / set**, **update** | `region: Region`; `notificationPrefs: { episodeAired, movieAvailable, cameToPlatform }` (all `true`); `fcmTokens` (`[]` on create, then `arrayUnion` of one `FcmToken` on grant) |
| `users/{uid}/**` | **none**                     | watchlist / episodes / notifications subcollections untouched                                                                                                                    |
| `title-cache/**` | **none**                     | not touched                                                                                                                                                                      |

- **User-doc create (decision 4):** on `complete(region)`, write `users/{uid}` via
  `setDoc(doc(firestore, userPath(uid)), userToData({ region, notificationPrefs: {
episodeAired: true, movieAvailable: true, cameToPlatform: true }, fcmTokens: [] }))`.
  Use `setDoc` (idempotent create-or-overwrite of these onboarding-owned defaults) —
  acceptable because onboarding runs once and is the doc's normal creator; if the doc
  somehow already exists (e.g. settings opened first), the region the user just chose
  in onboarding is authoritative for this write. (Implementer may instead `setDoc(...,
{ merge: true })` if preserving an existing non-default `notificationPrefs`/`fcmTokens`
  is preferred — **binding constraint:** after `complete`, the doc exists with the
  chosen `region` and a valid `notificationPrefs`; do not clobber a previously
  registered `fcmTokens` array if one exists.)
- **FCM token write (decision 5b):** on the `'registration'` event, write **one
  `FcmToken`** into `fcmTokens`. Because `fcmTokens` is `FcmToken[]` (objects, **not**
  `string[]` — see Risks), the additive write is `updateDoc(ref, { fcmTokens:
arrayUnion(fcmTokenWire) })`. Build it in two steps:
  1. Construct a **domain `FcmToken`** (`@vultus/shared/domain`): `{ token:
<event.registration.value>, deviceId: <stable device id>, createdAt: new
Date().toISOString() }` — `createdAt` is an **ISO 8601 string** at the domain layer.
  2. Map it to the **wire shape** `FcmTokenWriteData` (`@vultus/shared/firestore-schema`):
     `{ token, deviceId, createdAt: new Date(iso) }` — `createdAt` becomes a JS `Date`
     here (so Firestore stores a Timestamp). Pass this wire-shaped element to
     `arrayUnion(...)`.

  `deviceId`: use a stable id where available (`@capacitor/device` is **not**
  installed — see Risks); a documented constant or a generated-and-persisted id is
  acceptable for v1 single-device. The token write **must not** run on web (guarded by
  `isNativePlatform()`).

- **Use the shared converters / paths:** `userPath(uid)` for the path,
  `userToData(user)` for the create payload. For the single-element `arrayUnion` there
  is **no public single-element FCM converter** — `fcmTokenToData` is **private and not
  exported** from `converters.ts`, so the implementer **cannot call it**. Instead, write
  the single-element wire mapping **inline**: construct a `FcmTokenWriteData` object
  `{ token, deviceId, createdAt: new Date(iso) }` directly, typed to the **exported**
  `FcmTokenWriteData` from `@vultus/shared/firestore-schema`. This small inline mapping
  is intentional; this spec does **not** add a public single-element FCM converter to
  `shared/firestore-schema` (out of scope per decision 9).
- **No `firestore.rules` change.** Spec 0004's rules grant owner-only read/write to
  `users/{uid}` for any authenticated uid (anonymous included). The create + the
  `fcmTokens` update are owner writes to the user's own doc — already permitted. **Do
  NOT edit `firestore.rules`.**
- **No `firestore.indexes.json` change** — no query (single-doc writes only).

## Public types / APIs

- **No new shared domain type.** `User`, `FcmToken`, `NotificationPrefs`, `Region`,
  `REGIONS` already exist in `@vultus/shared/domain`; `AUTH_UID` in
  `@vultus/shared/domain/tokens`; `userPath`, `userToData`, `dataToUser`,
  `FcmTokenWriteData` in `@vultus/shared/firestore-schema`. **Reuse — do not
  duplicate.**
- **Onboarding slice surface** (`libs/mobile/onboarding/src/index.ts`):
  - `OnboardingPage` — the standalone Ionic page (selector e.g. `lib-onboarding`),
    lazy-loaded by the shell.
  - `onboardingGuard` — the `CanActivateFn`, **exported** so the shell registers it on
    `tabs`. (Type `CanActivateFn`.)
  - `OnboardingService` — export **only if** a test or the page composition needs it
    across the barrel; otherwise keep internal (it is page-scoped data-access). The
    `mock` providers swap (`onboarding.providers.mock.ts`) follows spec 0018's
    structural-mirror pattern. Document whatever is exported in the README.
  - **Recommended (not binding) shapes:**

    ```ts
    // onboardingGuard — CanActivateFn
    export const onboardingGuard: CanActivateFn = async () => {
      const { value } = await Preferences.get({ key: ONBOARDING_DONE_KEY });
      if (value === 'true') return true;
      return inject(Router).createUrlTree(['/onboarding']);
    };

    @Injectable() // page-scoped or providedIn:'root' — implementer's call
    export class OnboardingService {
      /** The selectable regions (the shared REGIONS const). */
      readonly regions: readonly Region[];
      /**
       * Persist users/{uid} with the chosen region + default prefs, run the
       * native push-permission + token flow (no-op on web), then set the
       * Preferences 'onboarding_done' flag. Resolves when safe to navigate; never
       * rejects on a denied/failed push flow (decision 5c).
       */
      complete(region: Region): Promise<void>;
    }
    ```

    What is **binding**: `onboardingGuard` gates `tabs` on the `'onboarding_done'`
    Preferences flag (redirect to `/onboarding` when unset); `complete(region)`
    creates `users/{uid}` with the decision-4 defaults via the shared converter,
    requests push permission and (on grant + native) registers + writes a `FcmToken`
    via `arrayUnion`, swallows any push failure (never blocking completion), and sets
    `onboarding_done = 'true'` last; the slice never writes outside `users/{uid}`,
    never touches another slice, never imports `apps/mobile`.

- **`apps/mobile/src/app/app.routes.ts`** — the only shell API change:
  ```ts
  import { onboardingGuard } from '@vultus/mobile/onboarding';
  // tabs route gains:  canActivate: [onboardingGuard],
  // new top-level route:
  {
    path: 'onboarding',
    loadComponent: () =>
      import('@vultus/mobile/onboarding').then((m) => m.OnboardingPage),
  },
  ```
  Route shape is the **binding** contract; the existing `{ path: '', redirectTo:
'tabs/watchlist' }` stays — first launch hits `tabs`, the guard redirects to
  `/onboarding`, the page navigates back to `/tabs/watchlist` on completion.

## UI / Stitch screen refs

This is a mobile slice — UI fidelity is a contract (CLAUDE.md). The authoritative
design tokens live at **`docs/design/vultus-design-system.md`** (wired into
`shared/ui-kit` `theme.scss`); **reference that file — do NOT reprint or
hand-transcribe hex values** (primary is `#4edea3`, **not** `#10B981`). The screen
to match is the **onboarding / welcome / get-started** screen of Stitch project
**`projects/13590348714018893783`** ("Vultus Android App Design").

> **BLOCKING OPEN ITEM — Stitch onboarding screen NOT captured in this spec session.**
> The `stitch` MCP tools (`list_screens` / `get_screen`) were **not available to the
> spec author this session** (consistent with specs 0013 / 0020). Per CLAUDE.md and
> project memory ("a sub-agent's 'MCP unreachable' is a retry, not a reason to ship
> token-only UI"; the MCP is reachable from the orchestrator), the implementer
> **MUST**, before building the page:
>
> 1. `list_screens` on `projects/13590348714018893783` and find the **onboarding /
>    welcome / get-started** screen (the first-run gate, not a content tab). **Retry on
>    MCP failure.** (Note: the merged Settings page cites screen
>    `81945ff3381e453dafcc4e5ce896fcfa` — the onboarding screen is a _different_ one;
>    do not reuse the Settings screen.)
> 2. `get_screen` on it for `htmlCode.downloadUrl` + `screenshot.downloadUrl`. **Fetch
>    the raw HTML via a plain GET / `Invoke-WebRequest` (NOT WebFetch — it summarises
>    away the CSS)** and read the Tailwind config (`colors`/`fontSize`/`spacing`) +
>    element markup for concrete values. Grab the screenshot for a visual compare.
> 3. **Record the resolved Stitch screen ID in the PR.**
> 4. If, after retries, the screen genuinely can't be read, mark the page task
>    **`needs-human` / blocked** in the PR and do **not** ship a guessed layout — the
>    rest of the spec (guard, service, routing, deps) can still land; the page visual
>    must be human-verified.

**Concrete contract** (token references via `docs/design/vultus-design-system.md`;
pull exact values there — these are the structural pins the implementer ties to the
captured screen):

- **Page chrome:** dark-first; `IonContent` background = `surface`/`background`
  (`#0b1326`). `Inter` must be **loaded as a web font** (the shell loads it in
  `index.html` per spec 0010 — verify it applies on this page; a named family stack
  without the loaded font silently falls back to system-ui).
- **Welcome header:** a title + short subtitle. Type roles (from the design doc's
  scale): the headline uses `display-lg-mobile` (28/700) **or** `headline-md` (24/600)
  — match the captured screen; the subtitle uses `body-md` (14/400/20) in
  `on-surface-variant`. Body title text is `on-surface` (`#dae2fd`).
- **Region picker:** an `IonSelect` (`interface="popover"`, mirroring the merged
  Settings picker) over the ten `REGIONS`, default-selected `NL`, label "Region".
  Display the region code (a human-readable label map is optional polish). Sits in a
  `surface-container` (`#171f33`) card/row, radius `DEFAULT` (`0.5rem`), consistent
  insets on the 8px grid (`md` 16px gutter) — **aligned to the "Get started" button's
  horizontal insets** so the control and the CTA share one left/right margin.
- **Notifications control:** an explanation line (`body-md`, `on-surface-variant`)
  plus the control. **Structure from the actual screen** — this may be a plain
  explanatory block with the permission requested on "Get started" (not necessarily an
  `IonToggle`); decide the control shape from the captured markup, do not assume a
  toggle. If a toggle is present, it uses `primary` (`#4edea3`) as its on-accent.
- **"Get started" `IonButton`:** full-width (`expand="block"`), `primary` background
  (`#4edea3`) with `on-primary` (`#003824`) label text, radius `DEFAULT` (`0.5rem`),
  standard Ionic control height (do not shrink); the page's primary CTA at the bottom
  of the content. On tap it disables + shows an inline busy state while `complete()`
  runs (the push-permission prompt is async), then navigates.
- **Interactive states (per-element acceptance list — tick each):**
  - Region select — **default** (shows `NL`), **focus** (Ionic focus ring/popover
    open), **disabled** while `complete()` is in flight.
  - Notifications control — **default**; if a toggle: **on/off**, **focus**,
    **disabled** in flight.
  - "Get started" button — **default**, **hover/active** (pressed feedback),
    **disabled + busy** (spinner or disabled state) while `complete()` runs so a
    double-tap can't fire two completions; **re-enabled** only on a failure that keeps
    the user on the page (none expected — completion always proceeds, so the button
    effectively transitions to navigation).
  - **Transition:** the navigation to `/tabs/watchlist` happens only after
    `complete()` resolves (so the permission dialog has been shown); no flash of the
    tabs before the dialog.

**Visual verification (CLAUDE.md): a green build does NOT prove the UI is right.**
Render the page under the **`mock` serve profile** (`pnpm nx serve mobile
--configuration=mock`, spec 0018) and screenshot it, or **explicitly flag the page
unverified for a human eyeball** in the PR (alongside the Stitch-screen capture
status). The native permission dialog + token write can only be verified on a device
— flag that path as device-only.

## Implementation task graph

A new single-slice lib with one root-dep prerequisite and one shell wiring step. The
dependency add and the lib generation are shared prerequisites (sequential); the
slice-internal page/service/guard work then all writes within
`libs/mobile/onboarding/**` so it is **sequential within the slice** (the tasks share
the lib's files / the page composition). The **shell route wiring** writes a
different file (`apps/mobile/src/app/app.routes.ts`) and only depends on the barrel
existing, so it **can run in parallel** with the slice-internal page/service work
once the lib + its exported `onboardingGuard`/`OnboardingPage` symbols exist —
manifests are disjoint. frontend-engineer owns the slice + shell route;
infrastructure-engineer owns the dependency add + `cap sync`.

1. **[sequential] Add `@capacitor/preferences`; pin + lock; sync.**
   infrastructure-engineer. (Shared dep — the service + guard import it; must land
   first.)
   - Add **`@capacitor/preferences`** to the **root `package.json` `dependencies`**
     (there is **no `apps/mobile/package.json`** — deps live in the root manifest) at
     the **Capacitor-8-compatible** version (verify peer range against
     `@capacitor/core` 8.4.0; **it is NOT bundled in `@capacitor/core`** — Risks). Pin
     exact (repo convention: no `^`). Confirm `@capacitor/push-notifications` (8.1.1,
     already present from spec 0020) is still installed. Update `pnpm-lock.yaml`.
   - **Fresh-worktree install guards (project memory):** ensure `pnpm install`
     completes — `pnpm-workspace.yaml` should already carry `re2: false` and `sharp:
true`; if `@capacitor/preferences` introduces a newly-blocked native postinstall,
     add it to the allowBuilds list and record it. Likewise, if the pinned version is
     newer than the cooldown window defined in `pnpm-workspace.yaml`
     (`minimumReleaseAgeExclude`), add `@capacitor/preferences` to that list — analogous
     to the allowBuilds guard — so a fresh install does not fail on the release-age gate.
   - Run `npx cap sync android` so the plugin resolves natively (`cap sync` is a
     Node-level step — runnable in-session per spec 0020's note; native Gradle is not
     invoked here).
   - Files: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (only if a new
     allowBuilds entry is genuinely needed). (`apps/mobile/android/**` may change from
     `cap sync` — commit any resulting plugin manifest entries.)

2. **[sequential] Generate the `libs/mobile/onboarding` lib. Depends on task 1.**
   frontend-engineer.
   - Use the Nx Angular library generator to create `libs/mobile/onboarding`
     (matching the spec-0010 slice-lib conventions: `sourceRoot
libs/mobile/onboarding/src`, `prefix lib`, `projectType library`, `tags: []` in
     `project.json` — Sheriff tags come from the path glob, NOT `project.json`). It
     inherits `['scope:mobile', 'slice:onboarding']` automatically.
   - Create the barrel `src/index.ts` (exports filled in by tasks 3–4) and a real
     `README.md` (no Nx scaffold text).
   - Files: `libs/mobile/onboarding/project.json`, `libs/mobile/onboarding/README.md`,
     `libs/mobile/onboarding/src/index.ts`, plus the generator's tsconfig/vite/eslint
     scaffold under `libs/mobile/onboarding/**` (e.g. `tsconfig*.json`, `vite.config.*`,
     `eslint.config.*`).

3. **[sequential] `OnboardingService` + `onboardingGuard` + `mock` providers.
   Depends on task 2.** frontend-engineer.
   - `onboarding.service.ts`: inject `Firestore` + `AUTH_UID`; implement
     `complete(region)` — write `users/{uid}` (decision 4 / Data model), run the
     `isNativePlatform()`-guarded push flow (`requestPermissions` → on `granted`,
     `register` + `'registration'` listener → `arrayUnion` `FcmToken` write; swallow
     denied/errors — decision 5), then `Preferences.set({ key: 'onboarding_done',
value: 'true' })`. Expose `regions = REGIONS`. **Null-uid guard** before any
     Firestore call (the `AUTH_UID` signal can be null before the anon session
     resolves — see Risks).
   - `onboarding.guard.ts`: the `CanActivateFn` reading `Preferences.get({ key:
'onboarding_done' })`; return `true` or `Router.createUrlTree(['/onboarding'])`.
     Export an `ONBOARDING_DONE_KEY` constant shared by the service + guard (same lib,
     no boundary issue).
   - `onboarding.providers.mock.ts`: a structural mock of `OnboardingService` (spec
     0018 pattern) whose `complete()` resolves without Firebase/native plugins, for the
     `mock` serve profile.
   - Barrel-export `onboardingGuard` (and `OnboardingService` only if needed).
   - Files: `libs/mobile/onboarding/src/lib/onboarding.service.ts`,
     `libs/mobile/onboarding/src/lib/onboarding.guard.ts`,
     `libs/mobile/onboarding/src/lib/onboarding.providers.ts`,
     `libs/mobile/onboarding/src/lib/onboarding.providers.mock.ts`,
     `libs/mobile/onboarding/src/index.ts`.

4. **[sequential] `OnboardingPage` + README. Depends on task 3.** frontend-engineer.
   - Build the standalone page (UI / Stitch screen refs): welcome header, region
     `IonSelect` (default `NL`), notifications explanation/control, "Get started"
     `IonButton` that disables + busy-states while `complete(selectedRegion)` runs then
     `Router.navigate(['/tabs/watchlist'])`. Wire the `mock` providers swap into the
     component `providers` (spec 0018 pattern).
   - Barrel-export `OnboardingPage`.
   - Write `libs/mobile/onboarding/README.md` to the real public surface (what the lib
     is, exports `OnboardingPage` + `onboardingGuard`, behaviour: gates `tabs`, creates
     `users/{uid}`, requests push + writes a token on grant, sets the Preferences flag;
     Sheriff tags `scope:mobile` + `slice:onboarding`; uid via `AUTH_UID`).
   - **Pull the Stitch onboarding screen first** (blocking item in UI section); record
     the screen ID or flag the page `needs-human`.
   - Files: `libs/mobile/onboarding/src/lib/onboarding.page.ts`,
     `libs/mobile/onboarding/src/lib/onboarding.page.html`,
     `libs/mobile/onboarding/src/lib/onboarding.page.scss`,
     `libs/mobile/onboarding/src/index.ts`, `libs/mobile/onboarding/README.md`.

5. **[parallel] Shell route wiring. Depends on task 2 (the barrel must exist with
   `onboardingGuard` + `OnboardingPage` exported — i.e. needs tasks 3–4's exports at
   build time, but the _edit_ itself touches only `app.routes.ts` and can be authored
   concurrently once the barrel symbols are agreed).** frontend-engineer.
   - In `apps/mobile/src/app/app.routes.ts`: add `canActivate: [onboardingGuard]` to
     the `tabs` route and the new lazy `/onboarding` route (Public types / APIs). Keep
     the existing `{ path: '', redirectTo: 'tabs/watchlist' }`.
   - **File manifest: `apps/mobile/src/app/app.routes.ts`** (this one file only).
     Disjoint from all of tasks 2–4 (`libs/mobile/onboarding/**`) and task 6
     (`*.spec.ts`), so it is the single safe parallel fan-out. **Ordering caveat for
     the orchestrator:** the route file _imports_ the barrel symbols, so a green
     typecheck/build requires tasks 3–4 to have produced those exports — run this task's
     final verify after 3–4, but its file write conflicts with nothing and may be done
     concurrently.

6. **[sequential] Unit + component tests. Depends on tasks 3–5.** frontend-engineer /
   qa-runner.
   - Service unit tests, guard unit tests, page component test (Test plan).
   - Files: `libs/mobile/onboarding/src/lib/onboarding.service.spec.ts`,
     `libs/mobile/onboarding/src/lib/onboarding.guard.spec.ts`,
     `libs/mobile/onboarding/src/lib/onboarding.page.spec.ts`.

7. **[parallel] e2e spec + spec-0019 backward-compat fix. Depends on tasks 3–5 (the
   guard + `/onboarding` route must be wired so the flows can run).**
   frontend-engineer / qa-runner.
   - Author `apps/mobile-e2e/src/onboarding.spec.ts` with the three flows
     **F-onboard-1 / F-onboard-2 / F-onboard-3** (Test plan): first-launch redirect to
     `/onboarding`, pick "DE" → complete → `/tabs/watchlist` + emulator `users/{uid}`
     with `region: 'DE'` + `CapacitorStorage.onboarding_done = 'true'`, and flag-pre-set
     → straight to `/tabs/watchlist`. `onboarding.spec.ts` leaves the flag unset (or
     clears it) for the first-launch flows. Native FCM (dialog + token write) is **not**
     exercised (device-only).
   - **Backward-compat fix:** update the existing spec-0019 e2e files that boot and
     expect `/tabs/watchlist` so they pre-set `localStorage.setItem(
'CapacitorStorage.onboarding_done', 'true')` in their `beforeEach` (or set it by
     default in `global-setup.ts` / a shared support helper) — at minimum
     `apps/mobile-e2e/src/app.boot.spec.ts`, plus any other spec-0019 file that boots
     without pre-setting the flag. This keeps the spec-0019 suite green now that boot
     redirects to `/onboarding` until the flag is set.
   - **File manifest: `apps/mobile-e2e/src/**`** — concretely
`apps/mobile-e2e/src/onboarding.spec.ts`(new) plus the spec-0019 files needing the
fix (at least`apps/mobile-e2e/src/app.boot.spec.ts`, and `global-setup.ts` /
support helper if the default-baseline approach is used). **Disjoint** from task 6
(`libs/mobile/onboarding/**/\*.spec.ts`) and tasks 2–5 — `apps/mobile-e2e/src/` only,
     **no `libs/mobile/onboarding/` files** — so it runs **parallel\*\* to task 6.

(All slice work is under `libs/mobile/onboarding/**`; the files outside it are
`apps/mobile/src/app/app.routes.ts` (task 5), the root dep files (task 1), and the
`apps/mobile-e2e/src/**` e2e files (task 7). No `sheriff.config.ts`, `firestore.rules`,
`firestore.indexes.json`, `libs/mobile/settings`, or `scope:functions` file is touched.
The two parallel manifests — `app.routes.ts` (task 5) and `apps/mobile-e2e/src/**`
(task 7) — are disjoint from each other and from the slice-internal tasks.)

## Test plan

Per the PLAN §5 pyramid — a thin slice, so focused **unit** tests (service +
guard) and a **component** test (page), with **no emulator-backed e2e in this PR**
(decision 10). All Firebase + native-plugin access is **mocked** (no live Firebase,
no network, no native runtime, no secrets).

**Unit — `onboarding.service.spec.ts`** (Vitest; mocked AngularFire `Firestore`,
mocked `AUTH_UID` signal, mocked `@capacitor/push-notifications` / `@capacitor/preferences`
/ `Capacitor.isNativePlatform`):

- **Creates the user doc with defaults + chosen region:** `complete('DE')` writes
  `users/{uid}` with `region: 'DE'`, `notificationPrefs` all `true`, `fcmTokens: []`
  (assert the converted `setDoc` payload via `userToData`); the write targets
  `userPath(uid)`.
- **Web (non-native) skips the push flow but still completes:** with
  `isNativePlatform() === false`, `requestPermissions`/`register` are **not** called,
  no `fcmTokens` update fires, yet the user-doc write and the `Preferences.set({ key:
'onboarding_done', value: 'true' })` both run.
- **Native + granted writes a token:** `isNativePlatform() === true` and
  `requestPermissions` resolves `{ receive: 'granted' }` → `register()` is called, and
  on a simulated `'registration'` event the service issues an `arrayUnion` update to
  `fcmTokens` with a wire-shaped (`FcmTokenWriteData`) element (`token`, `deviceId`,
  `createdAt` as a `Date` — mapped from the domain `FcmToken`'s ISO-string
  `createdAt`). Still sets the completion flag.
- **Native + denied proceeds silently:** `{ receive: 'denied' }` → no `register`, no
  `fcmTokens` write, **no throw**, completion flag still set.
- **Push error never blocks completion (decision 5c):** if `requestPermissions` /
  `register` rejects, `complete()` still resolves and still sets the completion flag.
- **Null-uid guard:** if `AUTH_UID()` is null, the service does **not** call Firestore
  (no read/write) and surfaces a defined not-ready outcome rather than throwing on an
  undefined path (see Risks).
- **No write outside `users/{uid}`:** every mocked Firestore write targets
  `userPath(uid)` — never a subcollection, never `title-cache`.

**Unit — `onboarding.guard.spec.ts`** (mocked `@capacitor/preferences` + a mocked
`Router`):

- Flag `'true'` → guard returns `true` (allow `tabs`).
- Flag absent/`null` → guard returns a `UrlTree` for `/onboarding` (assert
  `Router.createUrlTree(['/onboarding'])`).
- Flag any non-`'true'` value → redirect (treats only exact `'true'` as done).

**Component — `onboarding.page.spec.ts`** (Angular TestBed + Ionic test setup,
mirroring the spec-0011 page test; `OnboardingService` mocked, `Router` mocked):

- Renders the welcome header, the region `ion-select` (lists the ten regions,
  default `NL`), the notifications control, and the "Get started" `ion-button`.
- Changing the select updates the selected region passed to `complete`.
- Tapping "Get started" calls `service.complete(selectedRegion)` once and, on
  resolve, navigates to `/tabs/watchlist`; the button is disabled while in flight
  (no double-fire).

**e2e — `apps/mobile-e2e/src/onboarding.spec.ts`** (Playwright, emulator-backed,
new file). `@capacitor/preferences` falls back to `localStorage` on web, so Playwright
can read/write the completion flag via `page.evaluate`. The key Capacitor uses is
prefixed: **`CapacitorStorage.onboarding_done`**. That makes the navigation/region
flows testable in browser mode without native plugins. Three flows:

- **F-onboard-1** (`empty` fixture, **no** localStorage flag set): Boot → URL is
  `/onboarding`; the welcome header, the region `ion-select`, and the "Get started"
  `ion-button` render. Asserts the onboarding guard is active (no flag → redirect).
- **F-onboard-2** (`empty` fixture, **no** localStorage flag): Pick region **"DE"** in
  the `ion-select`, tap "Get started" → URL becomes `/tabs/watchlist`; `users/{uid}`
  exists in the Firestore emulator with `region: 'DE'`; `localStorage` has
  `CapacitorStorage.onboarding_done = 'true'`. (The FCM permission dialog + token write
  are **device-only** — **not** asserted here.)
- **F-onboard-3** (`empty` or `seeded` fixture, `CapacitorStorage.onboarding_done =
'true'` pre-set in `beforeEach` via
  `page.evaluate(() => localStorage.setItem('CapacitorStorage.onboarding_done', 'true'))`):
  Boot → URL is `/tabs/watchlist` directly; **no** redirect to `/onboarding`.

`onboarding.spec.ts` explicitly **does NOT** set the flag (or clears it) before
F-onboard-1 / F-onboard-2 so it exercises the first-launch path. **Native FCM parts
(the permission dialog and the token write) remain device-only** — they are never
exercised in e2e (browser mode has no native runtime); the e2e flows assert only the
navigation + region-write + completion-flag behaviour.

**Backward-compat note (BLOCKING for green CI):** once the onboarding guard lands, **all
existing spec-0019 e2e tests** (which currently assume boot → `/tabs/watchlist`) will
break, because boot now redirects to `/onboarding` until the flag is set. The
implementer **must** pre-set `localStorage.setItem('CapacitorStorage.onboarding_done',
'true')` in those tests' `beforeEach` setup — or, preferably, set it as the default
baseline for all non-onboarding specs in `global-setup.ts` / a shared support helper —
so the spec-0019 suite stays green. The new `onboarding.spec.ts` is the **only** spec
that leaves the flag unset (or clears it), to test the first-launch path.

A `mock`-profile manual smoke (serve `--configuration=mock`, confirm the page renders
and "Get started" routes to the tabs) is also encouraged for visual verification. The
full native first-launch flow (real permission dialog + token write +
`Preferences`-gated reboot) is device-only and human-verified.

## Definition of done

Tailored from PLAN §5. Green gate is **lint/Sheriff + unit + component + build + e2e**
(what `ci.yml` runs) — the navigation/region e2e flows are now in scope (decision 10).
Only the **native permission/token path** is out of CI scope (device-only).

- [ ] `pnpm nx run-many -t lint test -p mobile-onboarding mobile` passes **with
      Sheriff active** (lint includes Sheriff): the onboarding slice imports
      `@vultus/shared/domain`, `@vultus/shared/domain/tokens`,
      `@vultus/shared/firestore-schema`, AngularFire + `@capacitor/*` (third-party) —
      **no other-slice import, no `apps/mobile` deep import, no `scope:functions`
      import**; the shell route edit is `scope:mobile → scope:mobile` (allowed). Service + guard unit tests and the page component test are green (no emulator, no network,
      no native runtime, no secrets — Firebase + Capacitor plugins mocked).
- [ ] `pnpm nx typecheck mobile-onboarding mobile` passes — the page, service, guard,
      and the shell route's barrel import all compile (`AUTH_UID`, the shared
      converters / `User`/`FcmToken` types, and `CanActivateFn` resolve).
- [ ] `pnpm nx build mobile` passes (production configuration) — the new slice
      lazy-loads cleanly into the shell, the guard registers on `tabs`, and the bundle
      stays within existing budgets. (`mobile-onboarding` is a lib with no `build`
      target; `lint`/`test`/`typecheck` cover it.)
- [ ] `pnpm nx affected -t lint test build --base=main` is green — mirrors CI. The
      affected set is `mobile-onboarding` and `mobile` (depends on the new slice +
      the new dep).
- [ ] **Component test** asserts the page renders the region select + notifications
      control + "Get started", and that "Get started" calls `complete` once and routes
      to `/tabs/watchlist` (PLAN §5: component tests for non-trivial UI).
- [ ] **e2e:** `apps/mobile-e2e/src/onboarding.spec.ts` exists with the three flows
      **F-onboard-1 / F-onboard-2 / F-onboard-3**. **F-onboard-1** (first-launch boot →
      `/onboarding` with header + region select + "Get started") and **F-onboard-3**
      (flag pre-set → straight to `/tabs/watchlist`, no redirect) are **green**;
      **F-onboard-2** passes (pick "DE" → complete → `/tabs/watchlist`, emulator
      `users/{uid}` created with `region: 'DE'`, `CapacitorStorage.onboarding_done =
    'true'`). All **pre-existing spec-0019 e2e flows (F1–F8 across `app.boot.spec.ts`,
      `search.spec.ts`, `settings.spec.ts`, `watchlist-refresh.spec.ts`)** remain green
      after the backward-compat fix (the flag pre-set in `beforeEach` / `global-setup`).
      The **FCM flows (permission dialog + token write) are explicitly device-only — NOT
      a CI gate**.
- [ ] `@capacitor/preferences` is added to the root `package.json` at a pinned,
      Capacitor-8-compatible version; `pnpm-lock.yaml` updated; `cap sync android`
      resolves all plugins with no error (the new plugin's native module is present).
- [ ] `libs/mobile/onboarding/README.md` states the real public surface
      (`OnboardingPage` + `onboardingGuard`), behaviour, and Sheriff tags — **no
      leftover Nx scaffold text** (CLAUDE.md lib-README rule).
- [ ] **`sheriff.config.ts`, `firestore.rules`, `firestore.indexes.json`, and
      `libs/mobile/settings` are NOT modified** (the path-glob tagging + owner-only
      rules already cover this slice; settings is untouched).
- [ ] **Guardrail verifications (review-checked):** (a) **every Firestore write
      targets `users/{uid}`** — no subcollection, no `title-cache`, no other slice's
      data; (b) the **only** `fcmTokens` mutation is the additive `arrayUnion` of a
      single `FcmToken` on a granted+native registration (no token write on web/denied;
      no token removal); (c) **the push flow is `isNativePlatform()`-guarded** and a
      denied/failed prompt **never blocks** completion (the user doc + flag still get
      written); (d) **`onboarding_done` is the last write** and the guard treats only
      exact `'true'` as done; (e) **no cross-slice import, no `apps/mobile` import from
      the slice, no `scope:functions` file**; (f) **no secret read/written** — the slice
      uses the shell's already-initialised AngularFire and the public Capacitor plugins
      (no new Firebase config, no `.env.local`).
- [ ] PR description records: the **Stitch onboarding screen ID** used (or that the
      MCP was unreachable after retries and the page was flagged `needs-human` / the
      `mock`-render verification status), the chosen `@capacitor/preferences` version +
      its Capacitor-8 compatibility check + the `cap sync` plugin-resolution result, the
      `fcmTokens` `FcmToken[]`-vs-`string[]` resolution (Risks), the writes-only-to-
      `users/{uid}` / no-cross-slice / no-`scope:functions` / push-never-blocks boundary
      confirmations, the **e2e result** (F-onboard-1/2/3 green + the spec-0019 suite still
      green after the `CapacitorStorage.onboarding_done` backward-compat fix), and that
      **the native FCM path (permission dialog + token write) is device-only, not a CI
      gate**.

## Risks

- **`fcmTokens` is `FcmToken[]`, NOT `string[]` (corrected in-spec — decision 5b).**
  The decision record describes writing "the received token to `users/{uid}.fcmTokens`
  via `arrayUnion`" and calls the field `string[]`. The **merged** domain
  (`@vultus/shared/domain` `User.fcmTokens: FcmToken[]`, with `FcmToken = { token,
deviceId, createdAt: string }` — ISO 8601) and its (private) converter persist an
  **array of objects** with `createdAt` mapped to a `Date` on the wire
  (`FcmTokenWriteData.createdAt: Date`). **Resolution (binding):** build a domain
  `FcmToken` first (`{ token: <event.registration.value>, deviceId, createdAt: new
Date().toISOString() }` — ISO **string**), then map it inline to the exported wire
  type `FcmTokenWriteData` (`{ token, deviceId, createdAt: new Date(iso) }` — `Date`)
  and pass that to `arrayUnion` — NOT a bare string. The private `fcmTokenToData` is
  **not exported**, so do the inline single-element map; this spec adds no public
  single-element FCM converter (decision 9). Writing a bare string would corrupt the
  array shape and break the read converter. If the implementer believes a `string[]`
  field is wanted instead, that is a **data-model change** (new spec + converter rewrite
  - migration), not a silent divergence.

- **`@capacitor/preferences` is NOT bundled in `@capacitor/core` and is NOT installed
  (corrected in-spec — decision 6).** Verified against `package.json`: only
  `@capacitor/{app,core,haptics,keyboard,push-notifications,splash-screen,status-bar}`
  are present — **no `@capacitor/preferences`**. It is a separate plugin package.
  **Resolution:** add it as a root dependency at a Capacitor-8-compatible pinned
  version (sequential task 1) and `cap sync`. If no Capacitor-8-compatible release
  exists, **stop and flag it** rather than forcing a mismatched install.

- **`AUTH_UID()` can be null briefly (or in dev/test).** The shell exposes the uid as
  a signal that is null before the anonymous session resolves (spec 0010), and under
  the no-emulator dev/`mock` context sign-in may not complete. In `mock` mode
  `environment.mockAuthUid` provides a fixture uid (see `app.config.ts`), so the
  onboarding write works in `mock` serve. **Mitigation:** the service **guards a null
  uid** before any Firestore call and surfaces a not-ready outcome (tested); the page's
  "Get started" handler should not navigate on a not-ready completion (or should retry
  once a uid resolves). Edge timing (user taps "Get started" before anon sign-in
  finishes on a real device) is rare given the splash + initializer gate; acceptable
  for v1, but the null guard must exist so it never writes to an undefined path.

- **`Preferences` cleared on reinstall → re-onboarding (intended — decision 6).** This
  is desired: a reinstall re-prompts for region + push. No migration, no server-side
  "has onboarded" flag (the `users/{uid}` doc surviving a reinstall does **not**
  suppress onboarding — the gate is the device-local `Preferences` flag by design).
  Documented so a reviewer does not mistake it for a bug.

- **Onboarding vs. settings both create `users/{uid}` (deliberate duplication, not a
  shared extraction).** The settings slice (spec 0011) eagerly read-or-creates the same
  doc shape. After this spec, onboarding is the **normal** creator and settings' create
  becomes a fallback. The two writers are the **same shape in two slices (2 < 3)**, so
  per CLAUDE.md / PLAN §3 the small duplication stays in the slices — **do NOT extract
  a shared user-doc writer.** Caveat: if onboarding uses `setDoc` without `merge` and a
  user somehow opened settings first (writing a non-default doc), the onboarding write
  overwrites it with the onboarding-chosen region + defaults. Given onboarding gates
  `tabs` (settings lives under `tabs`), the settings-first path is effectively
  unreachable on a fresh install; still, prefer not clobbering a pre-existing
  `fcmTokens` (Data model note).

- **Native plugins can't run under Claude Code tools here (project memory:
  emulator-tooling-limitation; the native permission dialog + FCM are device-only).**
  The unit/component tests mock the Capacitor plugins, and `cap sync` is a Node-level
  step (runnable in-session per spec 0020). The **actual** permission prompt + token
  registration + `Preferences`-gated reboot are verifiable only on a device — the
  implementer flags that path **device-only / human-verified** in the PR; it is not a
  CI gate.

- **Stitch onboarding screen NOT captured this session (BLOCKING for the page task —
  see UI / Stitch screen refs).** The `stitch` MCP was unavailable to the spec author
  (consistent with 0013 / 0020). The implementer **must** capture it (retry — reachable
  from the orchestrator per project memory) and record the screen ID, or flag the page
  blocked / `needs-human`. The guard, service, routing, and deps are **not** blocked by
  this — they can land while the page visual is human-verified.

- **`@capacitor/device` (stable `deviceId`) is not installed.** `FcmToken.deviceId`
  needs a value. **Mitigation:** for v1 single-device, use a documented constant (e.g.
  `'android'`) or a generated id persisted in `Preferences`; do **not** add
  `@capacitor/device` in this spec (keep the dep surface minimal — out of scope). Note
  the chosen approach in the PR. Multi-device token rotation / dedup is explicitly out
  of scope (decision 10).

- **No PLAN conflict.** This implements PLAN §6 item 22 (first-run region pick + push
  permission) on the PLAN §4 `users/{uid}` shape and the spec-0010 `AUTH_UID` DI
  contract, completing the FCM token registration that spec 0020 explicitly deferred
  "to onboarding". The new `slice:onboarding` lib fits the vertical-slice rules (PLAN
  §3 / CLAUDE.md): own page/service/guard, shared types only, no cross-slice import.
  The two interview-vs-merged-code mismatches (`fcmTokens` `string[]`,
  `@capacitor/preferences` bundled in core) are reconciled toward the merged code in
  Risks, not designed around.
