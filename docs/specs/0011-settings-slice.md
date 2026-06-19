---
number: 0011
slug: settings-slice
title: Flesh out the settings slice — region picker, global notifications toggle, and eager users/{uid} init
status: approved
slices: [slice:settings]
scopes: [scope:mobile, scope:shared]
created: 2026-06-19
---

# Flesh out the settings slice — region picker, global notifications toggle, and eager users/{uid} init

## Context

PLAN §6 item 16 — **`slice:settings`** — is the **first real mobile slice**.
Everything before it on the mobile side is the shell (spec 0010, PLAN §6 item 15):
an Ionic tabs app with AngularFire wired against the emulators, anonymous auth on
first launch, and **three minimal stub slice libs** (`libs/mobile/{watchlist,search,settings}`)
generated, Sheriff-tagged (`scope:mobile` + `slice:<slice>`), and lazy-routed —
each with one placeholder `SettingsPage`/`SearchPage`/`WatchlistPage`, a barrel,
a real README, and a render test. Spec 0010 deliberately **does not write any
`users/**` document** — it states "The `users/{uid}` document … is owned and
created by the **settings** slice (PLAN §6 item 16), NOT the shell."

This spec fleshes out `libs/mobile/settings` (it does **not** regenerate the lib).
It delivers the two settings the user can change in v1 and the eager creation of
their user document:

- A **region picker** — choose a streaming region from a fixed list.
- A **global notifications on/off toggle** — one switch for "send me push
  notifications" (per-type granularity is deferred — see decision 2).
- **Eager `users/{uid}` initialisation** — on first open of the settings page the
  slice reads `users/{uid}`; if it does not exist it creates it with defaults, so
  every downstream slice (search, watchlist) can assume the doc exists.

Intended outcome: with the Firebase emulators running, opening the **Settings**
tab shows the current region and notifications state (creating the user doc with
defaults `region: 'NL'`, notifications on, if it was absent); changing the region
dropdown or toggling the switch persists immediately to `users/{uid}` and is
reflected on the next read.

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **Region scope — a fixed list of ~10, reusing the shared `Region` type.**
   The selectable regions are **NL, DE, GB, US, FR, BE, ES, IT, CA, AU**. **Locked
   decision:** these are surfaced as the shared `REGIONS` const from
   `@vultus/shared/domain` — **not** a slice-local enum. `REGIONS` today lists only
   six (`NL, DE, GB, US, FR, BE`); this spec **extends it to the ten above** in
   `libs/shared/domain` (a small, additive, sequential shared-domain change — see
   the task graph and Risks). There is **no TMDB API call for regions** — the list
   is the const array, easily extended later by editing it. The picker is a simple
   `IonSelect` (or equivalent dropdown). **Do NOT define a duplicate `Region`/region
   list inside the settings slice** (CLAUDE.md: don't duplicate shared types).

2. **Notification prefs — a single global on/off toggle in the UI.** The settings
   UI exposes exactly **one boolean control**: "notifications enabled". Per-type
   granularity (episode-aired / movie-available / show-came-to-platform) is
   **deferred** to a later spec, once the notification dispatcher (PLAN §6 item 14
   / `slice:dispatch-notifications`) is built and the kinds are finalised.
   - **Persistence reconciliation (binding — resolves a conflict with already-merged
     shared code; see Risks):** the canonical persisted `users/{uid}` shape is
     **already built** — `@vultus/shared/domain`'s `User` carries
     `notificationPrefs: NotificationPrefs` (`{ episodeAired, movieAvailable,
     cameToPlatform }`, all booleans), with a working converter in
     `@vultus/shared/firestore-schema` and matching PLAN §4. This spec **does NOT
     change the persisted shape** and does **NOT** introduce a `notificationsEnabled`
     field on the document. Instead, the single UI toggle is the **logical AND/OR
     projection** over `notificationPrefs`: it reads as "on" when **all three**
     prefs are `true` (the default), and writing it sets **all three** prefs to the
     toggle value at once. This honours the "global on/off only, per-type deferred"
     intent without forking the data model or rewriting the merged converter. The
     later per-type spec replaces the global projection with three individual
     toggles — no migration needed.
   - **FCM token registration is deferred** (decision 3); the toggle persists
     `notificationPrefs` only.

3. **FCM token registration — deferred to PLAN §6 item 21 (Capacitor Android build
   spec).** This spec does **NOT** add `@capacitor/push-notifications`, does **NOT**
   prompt for Android push permission, and does **NOT** write to
   `users/{uid}.fcmTokens`. On eager create it initialises `fcmTokens: []`; it never
   mutates that array thereafter. The actual FCM token write happens in item 21.

4. **`users/{uid}` document — created eagerly on first settings open.** On entering
   `SettingsPage` the slice reads `users/{uid}`. If the doc does **not** exist, it
   creates it with defaults `{ region: 'NL', notificationPrefs: { episodeAired:
   true, movieAvailable: true, cameToPlatform: true }, fcmTokens: [] }`. If it
   exists, it reads and displays the current values. This guarantees downstream
   slices can always assume the doc exists. The uid comes from the shell's
   `ShellAuthService` (spec 0010); the slice never re-inits Firebase or calls
   `signInAnonymously`.

5. **e2e against the emulators is descoped from this PR's gate** (consistent with
   spec 0010 decision 5 and PLAN §6 item 20). This spec's green gate is **unit +
   component + build** (what `ci.yml` runs: `lint test build`). The
   read-creates-doc / persist-on-change behaviour is asserted by **unit + component**
   tests against a **mocked AngularFire `Firestore`** (no live Firebase / no
   emulator — consistent with project memory: the emulator can't run under Claude
   Code tools here). The full emulator-backed settings flow is owned by the e2e-setup
   spec (PLAN §6 item 20); **no `ci.yml` / `playwright.config.ts` change here.**

## Scope

In scope:

- **Region picker** in `SettingsPage`: an `IonSelect` over the shared `REGIONS`
  list (extended to the ten in decision 1), bound to the current region, writing
  `users/{uid}.region` on change.
- **Global notifications toggle** in `SettingsPage`: an `IonToggle` projecting the
  three `notificationPrefs` booleans (decision 2), writing all three on change.
- **Eager `users/{uid}` init**: read-or-create with defaults on settings open
  (decision 4).
- A **settings data-access service** in the slice (e.g. `SettingsService`) that
  injects AngularFire `Firestore` + the shell `ShellAuthService`, performs the
  read-or-create, exposes current `region` + `notificationsEnabled` (the projected
  global) as signals, and persists changes.
- **Extend `REGIONS`** in `@vultus/shared/domain` from six to the ten regions
  (decision 1) — additive, with the derived `Region` union widening automatically.
- Replace the **stub `SettingsPage`** (from spec 0010) with the real page; keep it
  barrel-exported as `SettingsPage`.
- Update `libs/mobile/settings/README.md` to the real public surface.
- Tests (see Test plan).

Out of scope (each its own later spec):

- **Per-type notification preferences** (separate episode-aired / movie-available /
  show-came-to-platform toggles) — deferred until the dispatcher exists (decision 2;
  PLAN §6 item 14).
- **FCM token registration / push permission / `@capacitor/push-notifications`** —
  PLAN §6 item 21 (decision 3). No write to `fcmTokens` beyond the `[]` default.
- **Onboarding flow** (first-run region pick + notification permission prompt) —
  PLAN §6 item 22. This spec only delivers the settings page reachable via the tab.
- **Empty/loading/error-state polish** across slices — PLAN §6 item 23. A minimal
  loading guard (don't render the form before the doc resolves) is in scope; rich
  skeleton/empty states are not.
- **Emulator-backed e2e wiring** — PLAN §6 item 20 (decision 5). No `ci.yml` /
  `playwright.config.ts` change.
- **Search / watchlist / title-detail slices** — items 17–19.
- **`firestore.rules` / `firestore.indexes.json` changes** — the existing rules
  already cover owner-only `users/{uid}` read/write (see Data model touchpoints).

## Affected slices & Sheriff tags

| Project              | Path                              | Sheriff tags                     | Change                                                                       |
| -------------------- | --------------------------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| mobile-settings      | `libs/mobile/settings`            | `scope:mobile`, `slice:settings` | flesh out `SettingsPage` + add `SettingsService`; README; tests             |
| shared-domain        | `libs/shared/domain`              | `scope:shared`                   | **extend `REGIONS`** from 6 → 10 entries (additive); `Region` widens         |

- **Tagging is by PATH GLOB in `sheriff.config.ts`** (per spec 0010) — the settings
  lib already inherits `['scope:mobile', 'slice:settings']` from the glob and
  `shared/domain` is `scope:shared`. **This spec does NOT edit `sheriff.config.ts`.**
- **Import boundaries (verified against the spec-0010 Sheriff rules):**
  - `libs/mobile/settings` (`slice:settings`) may import `['scope:shared',
    'slice:settings']` only. It imports `@vultus/shared/domain` (`Region`/`REGIONS`,
    `User`/`NotificationPrefs`) and `@vultus/shared/firestore-schema`
    (`userPath`, `userToData`/`dataToUser`) — **both `scope:shared`, allowed (rule
    4)**. It imports **no other slice** (no `slice:search`/`slice:watchlist`).
  - The slice injects AngularFire `Firestore` and the shell's `ShellAuthService`.
    **AngularFire (`@angular/fire`), `firebase`, `@ionic/*` are third-party** — not
    policed by Sheriff (it governs only `scope:`/`slice:` workspace boundaries).
  - **`ShellAuthService` lives in `apps/mobile/src/app/auth/auth.service.ts` (the
    shell), tagged `scope:mobile` (spec 0010), not in a slice lib.** The
    `slice:settings` rule is `[scope:shared, sameTag]`, so a `slice:settings` lib
    **cannot statically import `apps/mobile` at all** — **even a type-only import of
    the `ShellAuthService` class creates a Sheriff dependency edge** that the rule
    forbids. **Binding:** the slice **must not directly import `ShellAuthService`
    from `apps/mobile`.** Instead it obtains the uid via an **injection token that
    `apps/mobile` provides at the root level** — either a token exported by the shell
    from a `scope:shared` location, or the uid injected as a route-level `data`
    value. The implementer must: **(a)** check whether spec 0010 exports an injection
    token from `scope:shared` for the uid; **(b)** if so, inject **that token** in the
    slice (a `scope:shared` import — allowed by rule 4); **(c)** if no such token
    exists, **flag it to the reviewer** (see Risks) and, as a stopgap, use
    `inject(ShellAuthService)` with an explicit comment that the resulting Sheriff
    edge must be resolved in 0010 (by exporting a `scope:shared` token / providing the
    uid via route data). This is a **0010 dependency**, not a blocker for writing the
    spec today.
  - **No `scope:functions` file is touched.**
- **No `shared/` extraction of settings logic.** The read-or-create + global-toggle
  projection logic lives **inside the settings slice** — it is used by **one** slice,
  far short of the 3+-slice rule (CLAUDE.md / PLAN §3). Only the **types** (`Region`,
  `User`, `NotificationPrefs`) and the **path/converter** helpers are shared, and
  those **already exist** in `shared/domain` + `shared/firestore-schema`; this spec
  reuses them and does not add new shared surface beyond widening `REGIONS`.

## Data model touchpoints

PLAN §4 `users/{uid}` is the only document touched. **The shape is already defined
and converter-backed** (`@vultus/shared/domain` `User`, `@vultus/shared/firestore-schema`
`userPath` / `userToData` / `dataToUser`) — this spec **reuses** it, it does not
redefine it.

| PLAN §4 path     | Access by this slice            | Fields                                                                                                  |
| ---------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `users/{uid}`    | **read**, **create**, **update** | `region: Region`; `notificationPrefs: { episodeAired, movieAvailable, cameToPlatform }`; `fcmTokens: []` |
| `users/{uid}/**` | **none**                        | watchlist / episodes / notifications subcollections untouched                                           |
| `title-cache/**` | **none**                        | not touched                                                                                             |

- **Read-or-create (decision 4):** read `users/{uid}` via `userPath(uid)`. If
  absent, create with defaults `{ region: 'NL', notificationPrefs: { episodeAired:
  true, movieAvailable: true, cameToPlatform: true }, fcmTokens: [] }`.
- **Region change:** update `region` only.
- **Notifications toggle (decision 2):** update all three `notificationPrefs`
  booleans to the toggle value; **leaves `fcmTokens` untouched.**
- **Use the shared converters:** `userToData(user)` on write, `dataToUser(snap.data())`
  on read — do **not** hand-roll the wire mapping in the slice (the converter is the
  persistence contract; `fcmTokens` has a nested timestamp the converter handles,
  though this slice writes an empty array).
- **No `firestore.rules` change.** Spec 0004's rules grant owner-only read/write to
  `users/{uid}` for any authenticated uid (anonymous counts — confirmed in
  `firestore.rules`). The eager create + updates are all owner writes to the user's
  own `users/{uid}` — already permitted. **Do NOT edit `firestore.rules`.**
- **No `firestore.indexes.json` change** — the slice issues no compound query (a
  single doc read).

## Public types / APIs

- **No new shared domain type.** `Region`, `REGIONS`, `User`, `NotificationPrefs`
  **already exist** in `@vultus/shared/domain`; `userPath`, `userToData`, `dataToUser`
  already exist in `@vultus/shared/firestore-schema`. **Reuse them — do not duplicate.**
- **`REGIONS` widened (the only shared API change):** in
  `libs/shared/domain/src/lib/enums.ts`, extend the `as const` array to the ten
  regions:
  ```ts
  export const REGIONS = [
    'NL', 'DE', 'GB', 'US', 'FR', 'BE', 'ES', 'IT', 'CA', 'AU',
  ] as const; // NL = v1 primary/default
  export type Region = (typeof REGIONS)[number];
  ```
  This is **additive** (no removals); `Region` widens automatically. **Required
  companion edit:** add `case 'ES': case 'IT': case 'CA': case 'AU':` to
  `assertRegionExhaustive` in `libs/shared/domain/src/lib/type-assertions.ts` —
  without it the four new members hit the `never` `default` and `shared-domain`
  fails `nx typecheck`/`build` (see task 1). `domain.spec.ts` (asserts only
  `REGIONS[0] === 'NL'`) stays green and needs no change.
- **Settings slice surface** (`libs/mobile/settings/src/index.ts`):
  - `SettingsPage` — the standalone Ionic page (already exported from the barrel by
    spec 0010; replace the stub body, keep the export).
  - Whether to also export `SettingsService` from the barrel is the implementer's
    call: it is an internal data-access service used only by `SettingsPage`. **Binding:**
    keep the public surface minimal — export `SettingsService` **only if** a test or
    the page composition genuinely needs it across the barrel; otherwise keep it
    internal. Document whatever is exported in the README.
  - **Recommended (not binding) service shape:**
    ```ts
    @Injectable() // page-scoped or providedIn: 'root' — implementer's call
    export class SettingsService {
      /** The selectable regions (the shared REGIONS const). */
      readonly regions: readonly Region[];
      /** Current persisted region; null until the user doc resolves. */
      readonly region: Signal<Region | null>;
      /** Global notifications projection (true when all notificationPrefs are true). */
      readonly notificationsEnabled: Signal<boolean>;
      /** Reads users/{uid}; creates it with defaults if absent. */
      load(): Promise<void>;
      setRegion(region: Region): Promise<void>;
      setNotificationsEnabled(enabled: boolean): Promise<void>;
    }
    ```
    Signal/method names are a **recommendation**; what is **binding** is: reads-or-
    creates `users/{uid}` with the decision-4 defaults, exposes the current region +
    the global notifications projection reactively, persists region/notifications
    changes via the shared converter, never writes outside `users/{uid}`, never
    touches `fcmTokens` beyond the `[]` default.

## UI / Stitch screen refs

This is a mobile slice — the implementer **must pull the Settings screen** via the
`stitch` MCP from project **`projects/13590348714018893783`** ("Vultus Android App
Design"): run `list_screens`, find the **Settings** screen, then `get_screen` on it;
**reference its screen ID in the PR** and align the layout (section grouping, labels,
control placement) to it.

> **Graceful degradation:** if the `stitch` MCP is **unavailable in-session**, apply
> the PLAN §2 design tokens below (fully specified here, seeded into `shared/ui-kit`
> by spec 0010) and **note in the PR that the MCP was unreachable** — a Stitch outage
> must not block an otherwise-correct PR.

Layout (Ionic, consuming the spec-0010 `shared/ui-kit` theme tokens):

- An `IonHeader` / `IonToolbar` / `IonTitle` ("Settings").
- An `IonContent` with an `IonList`:
  - An `IonItem` containing an **`IonSelect`** labelled "Region", its options the
    ten `REGIONS` values (display the code, e.g. "NL" — a human-readable label map is
    optional polish, not required), bound to the current region.
  - An `IonItem` containing an **`IonToggle`** labelled "Notifications", bound to the
    global notifications projection.
- Apply PLAN §2 tokens: **dark-first**, **Inter**, primary **Emerald `#10B981`**
  (Ionic `--ion-color-primary` — the toggle/select accents), navy-slate surfaces
  (`#0F172A` background / `#1E293B` items), **8px grid**, **0.5rem** radius. These
  come from the `shared/ui-kit` theme seeded in 0010 — consume them, do not redefine.
- Render-gate: don't render the form controls until `load()` resolves (avoids a flash
  of default values before the persisted doc is read). A minimal `IonSpinner` or
  `@if (loaded())` guard suffices; rich skeletons are PLAN §6 item 23.

## Implementation task graph

This is a single-slice spec with one small shared-domain prerequisite, so it is
mostly **sequential**. Task 1 (widen `REGIONS` in `shared/domain`) is a shared dep
the slice imports, so it goes **first**; tasks 2–4 all write within
`libs/mobile/settings` and therefore are **sequential** (they share the lib's files /
the page composition), not parallelisable.

1. **[sequential] Widen `REGIONS` in `@vultus/shared/domain`.** (shared dep — the
   slice imports the widened union; must land first.) frontend-engineer / domain.
   - Extend the `REGIONS` `as const` array in
     `libs/shared/domain/src/lib/enums.ts` to the ten regions (decision 1). `Region`
     widens automatically (derived type).
   - **Required (not conditional):** update the compile-time exhaustiveness check
     `assertRegionExhaustive(r: Region)` in
     `libs/shared/domain/src/lib/type-assertions.ts` (lines 61–75) — add
     `case 'ES':`, `case 'IT':`, `case 'CA':`, `case 'AU':` to its `switch`. Without
     this, the four new `Region` members fall into the `default` branch where
     `const _never: never = r;` no longer holds, which is a **guaranteed
     `nx typecheck`/`build` failure** for `shared-domain`. (`domain.spec.ts` only
     asserts `REGIONS[0] === 'NL'`, so it stays green and needs no change.) Update
     `libs/shared/domain/README.md` **only if** it lists the region set explicitly.
   - Files: `libs/shared/domain/src/lib/enums.ts`,
     `libs/shared/domain/src/lib/type-assertions.ts` (**required** — add the four
     new `case`s to `assertRegionExhaustive`),
     `libs/shared/domain/README.md` (if it lists regions).

2. **[sequential] Settings data-access service (`slice:settings`). Depends on task 1.**
   frontend-engineer.
   - Add `SettingsService` in the slice: inject AngularFire `Firestore` and the shell
     `ShellAuthService` (DI — see Affected slices for the boundary check). Implement
     read-or-create of `users/{uid}` with the decision-4 defaults using `userPath` +
     `userToData`/`dataToUser` from `@vultus/shared/firestore-schema`. Expose current
     `region` + the global `notificationsEnabled` projection (all-three-prefs) as
     signals. Implement `setRegion` (update `region`) and `setNotificationsEnabled`
     (set all three `notificationPrefs`). **Guard a null uid** (decision: see Risks)
     before any Firestore call.
   - Files: `libs/mobile/settings/src/lib/settings.service.ts`.

3. **[sequential] Real `SettingsPage` + barrel + README. Depends on task 2.**
   frontend-engineer.
   - Replace the spec-0010 stub `SettingsPage` body with the real page: `IonList`
     with the region `IonSelect` and notifications `IonToggle` (UI section above),
     wired to `SettingsService`. Writes happen **on change** (no explicit Save
     button). Render-gate on `load()`.
   - Keep `SettingsPage` exported from `src/index.ts`; export `SettingsService` only
     if needed (Public types).
   - Rewrite `libs/mobile/settings/README.md` to the real public surface (what the
     lib is, exports, that it reads/creates `users/{uid}` via the shared converter,
     Sheriff tags `scope:mobile` + `slice:settings`). **No leftover stub text.**
   - Files: `libs/mobile/settings/src/lib/settings.page.ts`,
     `libs/mobile/settings/src/lib/settings.page.html`,
     `libs/mobile/settings/src/lib/settings.page.scss`,
     `libs/mobile/settings/src/index.ts`,
     `libs/mobile/settings/README.md`.

4. **[sequential] Tests. Depends on tasks 2–3.** frontend-engineer / qa-runner.
   - Service unit tests + page component test (Test plan).
   - Files: `libs/mobile/settings/src/lib/settings.service.spec.ts`,
     `libs/mobile/settings/src/lib/settings.page.spec.ts` (replacing the spec-0010
     stub render test).

(All slice work lives under `libs/mobile/settings/**`; task 1 is the only file
outside it, in `libs/shared/domain/**`. No `apps/mobile`, `sheriff.config.ts`,
`firestore.rules`, or `scope:functions` file is touched.)

## Test plan

Per the PLAN §5 pyramid — a thin slice, so a focused set of **unit** tests (the
service logic) and a **component** test (the page), with **no emulator-backed e2e in
this PR** (decision 5). All Firebase access is **mocked** (no live Firebase, no
network, no secrets).

**Unit (`settings.service.spec.ts`, Vitest, mocked AngularFire `Firestore` +
mocked `ShellAuthService`):**

- **Read-creates-doc-with-defaults:** when `getDoc(users/{uid})` reports the doc
  does **not** exist, `load()` writes the defaults `{ region: 'NL', notificationPrefs:
  { episodeAired: true, movieAvailable: true, cameToPlatform: true }, fcmTokens: [] }`
  (assert the converted write payload) and exposes `region === 'NL'`,
  `notificationsEnabled === true`.
- **Read-uses-existing:** when the doc exists with e.g. `region: 'DE'` and one pref
  false, `load()` does **not** overwrite, and the signals reflect `region === 'DE'`,
  `notificationsEnabled === false` (projection: not all three true).
- **setRegion** updates only `region` (assert the write touches `region`, not other
  fields beyond what the converter emits) and updates the signal.
- **setNotificationsEnabled(false)** sets **all three** `notificationPrefs` to false;
  **`true`** sets all three true; **`fcmTokens` is untouched** in both.
- **Null-uid guard:** if `ShellAuthService.uid()` is null, the service does **not**
  call Firestore (no read/write) and surfaces a defined not-ready state rather than
  throwing on an undefined path (see Risks).
- **No write outside `users/{uid}`:** assert every mocked write targets the
  `userPath(uid)` document — never a subcollection, never `title-cache`.

**Component (`settings.page.spec.ts`, Angular TestBed + Ionic test setup, mirroring
the spec-0010 stub render test; `SettingsService` mocked):**

- Renders an `ion-select` (region) and an `ion-toggle` (notifications) once loaded.
- The select reflects the service's current region and lists the ten regions.
- Changing the select calls `setRegion` with the chosen `Region`; toggling the switch
  calls `setNotificationsEnabled` with the new boolean (persist-on-change, no Save
  button).
- Render-gate: before `load()` resolves, the form is not shown (spinner/guard).

**e2e:** **descoped to PLAN §6 item 20** (decision 5). No new Playwright spec; no
change to `apps/mobile-e2e`, `playwright.config.ts`, or `ci.yml`. The full
emulator-backed open-settings/persist flow is owned by the e2e-setup spec.

## Definition of done

Tailored from PLAN §5 to the projects touched. Green gate is **unit + component +
build** (what `ci.yml` runs: `lint test build`); emulator-backed e2e is descoped to
PLAN §6 item 20 (decision 5).

- [ ] `pnpm nx run-many -t lint test -p mobile-settings shared-domain` passes
      **with Sheriff active** (lint includes Sheriff): the settings slice imports
      `@vultus/shared/domain`, `@vultus/shared/firestore-schema`, AngularFire/Ionic
      (third-party), and the shell `ShellAuthService` **by DI only** — **no other
      slice import, no `apps/mobile` deep import, no `scope:functions` import**. The
      service unit tests + the page component test are green (no emulator, no network,
      no secrets; AngularFire + `ShellAuthService` mocked).
- [ ] `pnpm nx typecheck mobile-settings shared-domain` passes — the widened
      `Region` union, the service, and the page compile (the shared converters /
      `User` type resolve).
- [ ] `pnpm nx build mobile` passes (production configuration) — the fleshed-out
      slice lazy-loads cleanly into the shell and the bundle stays within the existing
      budgets. (`mobile-settings` / `shared-domain` are libs with no `build` target;
      `lint`/`test`/`typecheck` cover them.)
- [ ] `pnpm nx affected -t lint test build --base=main` is green — mirrors what CI
      runs. The affected set is `mobile-settings`, `shared-domain`, and `mobile`
      (which depends on the slice + domain).
- [ ] **Component test** asserts the region select + notifications toggle render and
      persist-on-change (PLAN §5: component tests for non-trivial UI).
- [ ] `libs/mobile/settings/README.md` is rewritten to the real public surface —
      **no leftover stub/Nx scaffold text** (CLAUDE.md lib-README rule). `shared/domain`
      README updated **only if** it enumerates the region set.
- [ ] **`sheriff.config.ts`, `firestore.rules`, `firestore.indexes.json` are NOT
      modified** (the existing tags + owner-only rules already cover this slice).
- [ ] **Guardrail verifications (review-checked):** (a) **every Firestore write
      targets `users/{uid}`** — no subcollection, no `title-cache`, no other slice's
      data; (b) **`fcmTokens` is never written beyond the `[]` default** (FCM deferred
      to item 21); (c) **no `notificationsEnabled` field is added to the document** —
      the persisted shape stays the merged `User` (`notificationPrefs`), the global
      toggle is a UI projection (decision 2); (d) **no cross-slice import and no
      `scope:functions` file touched**; (e) **no secret read/written** — the slice
      uses the shell's already-initialised AngularFire (no new config, no
      `.env.local`).
- [ ] PR description records: the **Stitch Settings screen ID** used (or that the MCP
      was unreachable and PLAN §2 tokens were applied), the exact verification
      commands, the no-`fcmTokens` / no-`notificationsEnabled`-field / writes-only-to-
      `users/{uid}` / no-cross-slice / no-`scope:functions` boundary confirmations,
      and that the **emulator-backed e2e is descoped to PLAN §6 item 20** (decision 5).

## Risks

- **Persisted shape conflicts with the decision record's `notificationsEnabled`
  field (RESOLVED in-spec — decision 2).** The interview phrased notifications as a
  single `notificationsEnabled: boolean` Firestore field. The **already-merged**
  `User` domain type, its converter, and PLAN §4 instead persist
  `notificationPrefs: { episodeAired, movieAvailable, cameToPlatform }`. Adding a
  separate `notificationsEnabled` field would **fork the data model** and require
  rewriting the merged converter + the per-type-prefs spec's migration. **Resolution
  (binding):** keep the persisted `notificationPrefs` shape; expose the single UI
  toggle as a **projection** over the three prefs (read = all-true, write = set-all).
  Same UX, no data-model fork, clean upgrade to per-type later. If the implementer
  believes a literal `notificationsEnabled` field is required, that is a **deviation
  from the merged data model + PLAN §4** and needs re-approval (a new spec), not a
  silent change.

- **`Region` already exists in `shared/domain` with six entries (RESOLVED — decision
  1).** The interview proposed a slice-local region const of ten. A slice-local
  duplicate would violate CLAUDE.md (don't duplicate shared types) and diverge from
  `userPath`/`availabilityDocPath`, which are typed on the shared `Region`.
  **Resolution:** widen the shared `REGIONS` to the ten and reuse it. This is the only
  shared-API change.

- **`ShellAuthService.uid` can be null briefly / cross-boundary DI.** The shell exposes
  the uid as a signal that is null before the anon session resolves (spec 0010), and
  in the no-emulator dev/test context sign-in may not complete at all. **Mitigations:**
  (a) the service **guards a null uid** before any Firestore call and exposes a
  not-ready state (tested); (b) the page render-gates on `load()`. **Cross-boundary
  caveat (0010 dependency):** `ShellAuthService` is tagged `scope:mobile`
  (`apps/mobile`), and the `slice:settings` rule `[scope:shared, sameTag]` forbids a
  `slice:settings` lib from importing `apps/mobile` — **even a type-only class import
  creates a disallowed Sheriff edge.** The slice must therefore obtain the uid via an
  **injection token provided at root by `apps/mobile`** (a `scope:shared`-exported
  token, or the uid as route-level `data`), **not** a direct import of
  `ShellAuthService`. Implementer: check whether 0010 exports a `scope:shared` uid
  token; if yes, use it; if not, **flag it to the reviewer** and use
  `inject(ShellAuthService)` only as a commented stopgap noting the Sheriff edge must
  be resolved in 0010 (export a `scope:shared` token / route-data). The fix belongs
  in the shell, not in a boundary-violating import here.

- **`users/{uid}` may not exist on first open (handled — decision 4).** The eager
  read-or-create is the whole point: downstream slices then assume the doc exists. The
  create races nothing here (single-user, single page); concurrent creates are not a
  v1 concern.

- **Injecting AngularFire `Firestore`/`Auth` is third-party, not a Sheriff violation.**
  Sheriff governs only `scope:`/`slice:` edges between workspace projects;
  `@angular/fire` is external. The slice uses the shell's already-initialised Firebase
  (DI of `Firestore`) and **never** calls `initializeApp` / `signInAnonymously`.

- **FCM deferred (decision 3).** No `@capacitor/push-notifications`, no permission
  prompt, no `fcmTokens` write beyond `[]`. The toggle persists `notificationPrefs`
  only; the FCM token write is PLAN §6 item 21.

- **Emulator-backed e2e descoped (decision 5).** Consistent with spec 0010 and project
  memory (the emulator can't run under Claude Code tools here). This PR's gate is unit
  + component + build; the full settings flow against the emulators is PLAN §6 item 20.
  No `ci.yml` / `playwright.config.ts` change.

- **Depends on spec 0010 being present.** This spec fleshes out the `libs/mobile/settings`
  stub, the `ShellAuthService`, and the AngularFire DI contract — **all delivered by
  spec 0010 (PLAN §6 item 15)**. The implementer works in a worktree branched after
  0010 has landed; if `libs/mobile/settings` / `ShellAuthService` / the AngularFire
  providers are absent, **stop and flag the missing dependency** rather than recreating
  shell scaffolding here (that is 0010's job, not this slice's).

- **No PLAN conflict.** This implements PLAN §6 item 16 (region + notification prefs;
  FCM correctly deferred to item 21) using the PLAN §4 `users/{uid}` shape and the
  spec-0010 AngularFire DI contract. The two interview-vs-merged-code mismatches
  (`notificationsEnabled` field, slice-local region list) are reconciled in-spec
  toward the merged architecture (decisions 1–2), not designed around it.
