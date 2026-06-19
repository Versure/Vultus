---
number: 0010
slug: app-shell
title: Add the Ionic tabs app shell, routing, Firebase/AngularFire init, anonymous auth, and the three stub mobile slice libs
status: implementing
slices: [slice:watchlist, slice:search, slice:settings]
scopes: [scope:mobile, scope:shared]
created: 2026-06-19
---

# Add the Ionic tabs app shell, routing, Firebase/AngularFire init, anonymous auth, and the three stub mobile slice libs

## Context

PLAN §6 item 15 — **App shell + routing + Firebase init** — is the first mobile
code in the repo. Everything before it is foundation (specs 0001–0005) and the
functions backend (0006–0009). The mobile half of the app is **entirely
unstarted**: `apps/mobile` is the default Nx Ionic/Angular scaffold — a single
lazy `home` page in `app.routes.ts`, an `App` root component using `IonApp` /
`IonRouterOutlet`, an `app.config.ts` with `provideIonicAngular` /
`provideRouter`, bootstrap in `main.ts`, and a dark-palette `styles.scss`. There
are **no `libs/mobile/*` slices**, **no `environments/` folder**, and **no
AngularFire**. The `firebase` client SDK (v12.15.0) and Capacitor
(`@capacitor/app|haptics|keyboard|status-bar`, android, cli v8) are already
installed; spec 0004 committed `firebase.json` with the Auth (9099) / Firestore
(8080) / UI (4000) emulators against the real project id **`vultus-cab62`**.

This spec delivers the shell that **every later mobile slice plugs into**:

- An Ionic **tabs** shell (Watchlist / Search / Settings) with lazy child routes.
- **Firebase init via AngularFire**, wired so the app boots against the **local
  emulators** in dev with **no real secrets** — the data-access DI contract
  every later slice (`settings` / `search` / `watchlist` / `title-detail`)
  follows.
- **Anonymous auth on first launch**, with app render gated until the session
  resolves and the uid exposed to slices via a small shell auth service/signal.
- **Three minimal stub slice libs** (`libs/mobile/{watchlist,search,settings}`)
  generated, tagged, and routed **now**, so each later slice spec fleshes out an
  already-tagged, already-routed lib instead of touching root config.
- The **global Stitch theme** seeded into `apps/mobile` styles + `shared/ui-kit`.

Intended outcome: with the Firebase emulators running, `pnpm nx serve mobile`
boots an Ionic app that signs in anonymously against the Auth emulator, lands on
the **Watchlist** tab, and lets you switch between three tabs — each rendering
its slice's placeholder page — with all data access pointed at the Firestore
emulator.

> **e2e gate scope (locked decision — see decision 5 below):** the _full_
> boot + anon-session + tab-nav flow **against the Firebase emulators** is
> **descoped from this PR's green gate** and is delivered by the **e2e-setup
> spec (PLAN §6 item 20)**, which owns wiring `firebase emulators:start` into
> the Playwright `webServer` / CI. This spec's green gate is \*\*unit + component
>
> - build** (exactly what `ci.yml` runs today: `lint test build`). The only e2e
>   change here is a **minimal, harness-coherent rewrite** of the existing
>   `apps/mobile-e2e/src/app.smoke.spec.ts` so it stops asserting the removed
>   `home` route — runnable under the **existing `nx serve`-backed Playwright
>   `webServer` with NO emulator\*\*. See Test plan.

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **Firebase access via AngularFire (`@angular/fire`).** Add `@angular/fire`
   (the implementer picks the version compatible with **Angular 21.2 / firebase
   12** — verifying that compatibility is an explicit implementation step; see
   Risks). Wire, in `app.config.ts`:
   `provideFirebaseApp(() => initializeApp(environment.firebase))`,
   `provideAuth(() => getAuth())`, `provideFirestore(() => getFirestore())`. In
   **dev** (non-production environment, `useEmulators: true`) connect to the
   emulators: `connectAuthEmulator(getAuth(), 'http://localhost:9099')` and
   `connectFirestoreEmulator(getFirestore(), 'localhost', 8080)` — so the app
   boots with **no real secrets**. **This AngularFire DI pattern is the
   data-access contract every later mobile slice follows** — slices inject
   `Auth` / `Firestore` from AngularFire, they do not re-init Firebase.

2. **Generate the three tab slice libs now as minimal stubs.** The shell
   generates `libs/mobile/watchlist`, `libs/mobile/search`,
   `libs/mobile/settings` — each: **one** placeholder standalone Ionic page
   component, a barrel `src/index.ts`, a real `README.md` (per CLAUDE.md), and
   correct Sheriff tags (by glob; see below). Tabs lazy-load
   (`loadComponent`) into these libs. **This spec edits `sheriff.config.ts`
   exactly once** — and only to confirm/extend the slice-tag glob (see Affected
   slices). **`title-detail` is NOT a tab and is NOT created here** — it is
   pushed from watchlist/search later (PLAN §6 item 19, its own spec).

3. **Anonymous auth: session only.** On first launch the shell signs in
   anonymously (`signInAnonymously`) and **gates app render until the session is
   resolved** via an Angular `provideAppInitializer` (recommended over a route
   guard, so the uid is ready before any slice loads). The resolved uid is
   exposed to slices via a small shell auth service exposing a signal. **The
   shell writes NO Firestore docs.** The `users/{uid}` document (region,
   notificationPrefs, fcmTokens — PLAN §4) is owned and created by the
   **settings** slice (PLAN §6 item 16), **NOT** the shell. **Guardrail: do not
   write `users/**` here.\*\*

4. **Emulator-first env, placeholder prod config.** Add
   `apps/mobile/src/environments/environment.ts` (dev: `production: false`,
   `useEmulators: true`, firebase config may be a public demo/placeholder) and
   `environment.prod.ts` (`production: true`, `useEmulators: false`, the **real
   public web config**). The real `vultus-cab62` web app config (`apiKey`,
   `authDomain`, `projectId`, `appId`, `messagingSenderId`, `storageBucket`) is a
   **documented manual prereq (PLAN §7)** the user pastes into
   `environment.prod.ts`; **do NOT fabricate `apiKey` values — use
   clearly-marked placeholders.** Per CLAUDE.md the implementer **never reads or
   writes `.env.local` or any secret** — and the Firebase web config is
   **explicitly NOT a secret** (it ships in every client), so committing the
   (placeholder, then user-filled) values is correct, not a secrets violation.
   Wire the Angular build to swap `environment.ts` → `environment.prod.ts` via
   the `apps/mobile/project.json` build target's `fileReplacements` for the
   `production` configuration.

   - **Dev `environment.ts` MUST pin `projectId: 'vultus-cab62'`** (the same
     project id `firebase.json` runs the emulators under, so
     `connectAuthEmulator` / `connectFirestoreEmulator` target the project the
     emulators serve) with a **dummy `apiKey`** the emulators accept — a
     clearly-fake placeholder such as `'demo-vultus-not-a-real-key'`. Do **not**
     pick an inconsistent placeholder `projectId`: a mismatch would make the
     "boots + signs in against the emulator" outcome silently fail. (The
     emulators do not validate `apiKey`, but the `projectId` must match.) The
     other dev fields may be `'demo-…'` placeholders. Prod `environment.prod.ts`
     keeps the real **public** web config as a user-filled manual prereq
     (decision 4).
   - Use the **function-based `provideAppInitializer`** (Angular 21), not the
     legacy `APP_INITIALIZER` token.

5. **e2e against the emulators is descoped from this PR's gate (delivered by
   PLAN §6 item 20).** The harness today (`ci.yml` runs `pnpm nx affected -t
lint test build`; the Playwright `webServer` runs `nx serve mobile` with **no
   emulator**) executes **no** emulator-backed e2e. Rather than claim a gate
   nothing runs, **this spec's green gate is unit + component + build** (what CI
   runs). The full **boot + anon-session + tab-nav e2e against the Firebase
   emulators** — including wiring `firebase emulators:start` into the Playwright
   `webServer` and/or CI — is owned by the **e2e-setup spec (PLAN §6 item 20)**.
   The only e2e edit in 0010 is to **rewrite the existing
   `apps/mobile-e2e/src/app.smoke.spec.ts`** (which currently asserts the removed
   `/home` route) into a **no-emulator smoke check** that runs under the
   **existing** `nx serve`-backed Playwright `webServer`: it asserts the tabs
   shell renders and Watchlist is the landing route. **Anonymous auth against the
   emulator is NOT asserted in this smoke run** (no emulator is available to the
   `nx serve` dev server). This spec adds **no** change to `ci.yml` or
   `playwright.config.ts`'s `webServer`.

## Scope

In scope:

- **AngularFire dependency** (`@angular/fire`, version-matched to Angular 21.2 /
  firebase 12; pin + update lockfile, per the spec-0001 "latest-then-pin"
  convention).
- **Three new stub slice libs** — `libs/mobile/{watchlist,search,settings}`,
  generated with the repo's Angular/Vitest generator defaults, each with one
  placeholder standalone Ionic page, a barrel, a real README, and a render test.
- **`sheriff.config.ts`** — one edit, to ensure `libs/mobile/<slice>` →
  `['scope:mobile', 'slice:<slice>']` covers the three new slices (see Affected
  slices for the verify-then-edit detail).
- **`shared/ui-kit` theming seed** — Stitch design tokens (Emerald primary,
  navy-slate surfaces, Inter, 8px grid, 0.5rem radius) as SCSS/CSS-variable
  theming, replacing the placeholder barrel's role with a real (minimal) theming
  surface. **Theming only — no speculative atom components.**
- **`apps/mobile` shell wiring**:
  - `environments/environment.ts` + `environment.prod.ts` and the
    `project.json` `fileReplacements`.
  - `app.config.ts` AngularFire providers (`provideFirebaseApp` / `provideAuth`
    / `provideFirestore`) + emulator connectors gated on `useEmulators` + the
    anonymous-auth `provideAppInitializer`.
  - A shell **auth service** exposing the resolved uid as a signal.
  - A **tabs shell component** (`IonTabs` / `IonTabBar` / `IonTabButton`) with
    three tabs and `ionicons` icons; child routes lazy-loading each slice's page.
  - `app.routes.ts` rewritten so the tabs shell is the root and **Watchlist is
    the default landing tab**.
  - **Remove the scaffold `home` page** and any reference to it (`app.routes.ts`,
    e2e smoke test — see below).
  - Global theme tokens applied in `styles.scss` (consuming the `shared/ui-kit`
    theming seed), keeping the existing dark-palette imports.
- **Tests** — unit (auth initializer/service, emulator-wiring helper), component
  (tabs shell renders three tabs / correct default; each stub page renders), and
  a **minimal rewrite of the existing `app.smoke.spec.ts`** so it no longer
  asserts the removed `/home` route — a **no-emulator** smoke check (tabs shell
  renders / Watchlist is the landing route) runnable under the existing `nx
serve`-backed Playwright `webServer`. **The emulator-backed boot+anon+nav e2e
  is descoped to PLAN §6 item 20** (decision 5); per Test plan.

Out of scope (each its own later spec):

- **Slice features.** The stub pages are placeholders only. Region picker /
  notification prefs / FCM token registration (settings, item 16), TMDB search +
  add-to-watchlist (search, item 17), the watchlist list / swipe / pull-to-
  refresh (watchlist, item 18), and the whole `title-detail` slice (item 19) are
  **not** built here.
- **Writing any `users/**` document\*\* — owned by the settings slice (item 16).
  The shell only establishes the anonymous session and exposes the uid.
- **FCM / push** — item 16 + the Capacitor build spec (item 21).
- **Capacitor native build** (icons, splash, APK) — PLAN §6 item 21.
- **Onboarding flow** (region pick, notification permission) — PLAN §6 item 22.
- **Empty/loading states** across slices — PLAN §6 item 23.
- **Emulator-backed e2e wiring** — starting `firebase emulators:start` for the
  Playwright `webServer` / CI and the full boot + anon-session + tab-nav e2e
  against the emulators is **PLAN §6 item 20 (e2e-setup spec)**, not this PR
  (decision 5). This spec only rewrites the existing smoke spec to drop the
  `/home` assertions, runnable with no emulator.
- **Real prod Firebase connection.** The prod web config is a **placeholder** the
  user fills (PLAN §7); dev + CI run **emulator-only**, so this does not block a
  green PR (see Risks).
- **Building real `shared/ui-kit` components.** Only theming tokens are seeded;
  component extraction waits for the 3+-slice rule (CLAUDE.md / PLAN §3).

## Affected slices & Sheriff tags

| Project          | Path                    | Sheriff tags                      | Change                                                                                     |
| ---------------- | ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| mobile (app)     | `apps/mobile`           | `scope:mobile`                    | tabs shell + routes, AngularFire + anon-auth providers, environments, theme, remove `home` |
| mobile-watchlist | `libs/mobile/watchlist` | `scope:mobile`, `slice:watchlist` | **new** stub page + barrel + README                                                        |
| mobile-search    | `libs/mobile/search`    | `scope:mobile`, `slice:search`    | **new** stub page + barrel + README                                                        |
| mobile-settings  | `libs/mobile/settings`  | `scope:mobile`, `slice:settings`  | **new** stub page + barrel + README                                                        |
| shared-ui-kit    | `libs/shared/ui-kit`    | `scope:shared`                    | seed Stitch theme tokens (theming only)                                                    |
| mobile-e2e       | `apps/mobile-e2e`       | none (e2e project, untagged)      | rewrite the `home` smoke spec to a no-emulator tabs-render smoke (drop `/home`)            |

- **Tagging is by PATH GLOB in `sheriff.config.ts`**, never via `project.json`
  `tags` (see the config header comment; the generated libs keep `tags: []` and
  that is correct). The config **already declares**
  `'libs/mobile/<slice>': ['scope:mobile', 'slice:<slice>']`, so the three new
  libs inherit `scope:mobile` + their `slice:*` tag **automatically on
  generation**. **Verify this against the actual `sheriff.config.ts`** (it is the
  case in the merged config). The "edit `sheriff.config.ts` once" task is
  therefore: **confirm the glob covers the three slices and the slice-tag
  vocabulary lists `slice:watchlist`/`slice:search`/`slice:settings` (it does);
  edit only if the verification shows a gap** (e.g. the header comment listing
  the slice vocabulary should mention these three are now in use). Do **not** add
  per-project tags. If verification shows the glob already fully covers the new
  libs and the vocabulary is complete, record in the PR that **no `sheriff.config.ts`
  change was needed** — that is an acceptable outcome of the "once" task, not a
  miss.
- **Import boundaries (verified against `sheriff.config.ts` rules 1–4):**
  - `apps/mobile` (`scope:mobile`) may import `['scope:shared', 'scope:mobile']`
    — so importing `@vultus/mobile/watchlist`, `@vultus/mobile/search`,
    `@vultus/mobile/settings` (each `scope:mobile` + `slice:*`) **and**
    `@vultus/shared/ui-kit` is **allowed** (rule 3: an app may import slices in
    its own scope; rule 4: anyone may import `scope:shared`). The tabs shell
    lazy-loads the three slice pages through their barrels — allowed.
  - Each slice stub (`slice:*`) may import `['scope:shared', sameTag]` — i.e.
    `scope:shared` and **only its own slice tag**, never another slice. The stub
    pages import Ionic + (optionally) `@vultus/shared/ui-kit` only. They import
    **no other slice** and **no AngularFire init** (they may inject `Auth` /
    `Firestore` providers later, but the stub pages do not yet).
  - `@angular/fire`, `firebase`, `@ionic/*`, `ionicons` are **third-party**
    imports Sheriff does not police (it governs only `scope:`/`slice:` boundaries
    between workspace projects).
  - **No `scope:functions` file is touched.** This spec is deliberately runnable
    in parallel with the in-flight `scope:functions` spec 0009 (Risks).
- **`shared/ui-kit` stays `scope:shared`** and is the correct home for the global
  theme (PLAN §2: "Treat the Stitch design system as the contract for
  `shared/ui-kit` theming"). Seeding **theming** there is **not** a premature
  3+-slice component extraction — it is the design-system contract, used app-wide.
- **The three stub libs are distinct slices, one per tab — NOT a premature
  `shared/` extraction.** Front-loading their generation into the shell spec is a
  deliberate trade (Risks): it keeps each later slice spec from re-editing root
  `sheriff.config.ts` + `app.routes.ts`. Duplication across the three stubs (each
  has a near-identical placeholder page) is **fine** — they will diverge as each
  slice is built; do not DRY them into shared.

## Data model touchpoints

The shell **establishes an anonymous Auth session** and **reads/writes no
Firestore document**. PLAN §4 paths:

| PLAN §4 path                 | Access by the shell | Note                                                                     |
| ---------------------------- | ------------------- | ------------------------------------------------------------------------ |
| Firebase Auth (anon session) | **create**          | `signInAnonymously` on first launch; uid exposed to slices via signal    |
| `users/{uid}`                | **none**            | **owned by the settings slice (item 16)** — guardrail: do not write here |
| `users/{uid}/**`             | **none**            | not touched                                                              |
| `title-cache/**`             | **none**            | read later by search/title-detail slices, not the shell                  |

- **No `firestore.rules` change.** Spec 0004's rules already allow an
  authenticated (including **anonymous** — the rules explicitly count anon uids)
  user owner-only access to `users/**` and authenticated read of `title-cache`.
  The shell only creates the anon session; it triggers **no** rule path that
  isn't already covered. Do **not** edit `firestore.rules`.
- **No `firestore.indexes.json` change** — the shell issues no query.
- **The Auth emulator must have Anonymous sign-in enabled.** The emulator
  permits all providers by default, so `signInAnonymously` works against it with
  no extra config; in prod the console must have **Anonymous** auth enabled
  (already a PLAN §7 manual prereq — note it, do not try to enable it from code).

## Public types / APIs

No domain types change (`@vultus/shared/domain` untouched). The stable surfaces
this spec fixes for later mobile slices to depend on:

### AngularFire DI contract (the data-access pattern for all mobile slices)

`apps/mobile/src/app/app.config.ts` providers (the contract slices rely on):

```ts
provideFirebaseApp(() => initializeApp(environment.firebase)),
provideAuth(() => {
  const auth = getAuth();
  if (!environment.production && environment.useEmulators) {
    connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
  }
  return auth;
}),
provideFirestore(() => {
  const fs = getFirestore();
  if (!environment.production && environment.useEmulators) {
    connectFirestoreEmulator(fs, 'localhost', 8080);
  }
  return fs;
}),
```

Later slices obtain Firestore/Auth by **injecting** AngularFire's `Firestore` /
`Auth` — they **do not** call `initializeApp` again. (The emulator-connect logic
should live in a small, **unit-testable helper** so the "connect only when
`useEmulators`" branch is asserted without a live Firebase — see Test plan.)

### Environment shape

`apps/mobile/src/environments/environment.ts` / `environment.prod.ts`:

```ts
export const environment = {
  production: boolean, // false in dev, true in prod
  useEmulators: boolean, // true in dev, false in prod
  firebase: {
    apiKey: string, // dev: public/demo placeholder; prod: REAL public web config (user-filled, PLAN §7)
    authDomain: string,
    projectId: string, // 'vultus-cab62' (non-secret)
    storageBucket: string,
    messagingSenderId: string,
    appId: string,
  },
};
```

`environment.prod.ts` uses **clearly-marked placeholders** (e.g.
`'REPLACE_WITH_REAL_WEB_API_KEY'`) — never a fabricated key. A comment points to
PLAN §7 (the user pastes the real public web config from the Firebase console).

### Shell auth service

A small injectable shell service (e.g. `apps/mobile/src/app/auth/auth.service.ts`)
exposing the resolved uid as a signal, e.g.:

```ts
@Injectable({ providedIn: 'root' })
export class ShellAuthService {
  /** Resolved anonymous (later: real) Firebase uid, or null before sign-in. */
  readonly uid: Signal<string | null>;
  /** Ensures an anon session exists; resolves once the uid is known. */
  ensureSignedIn(): Promise<string>;
}
```

The `provideAppInitializer` calls `ensureSignedIn()` so render is gated until the
uid resolves. **The exact signal/method names are a recommendation** — what is
binding: render is gated on the resolved session, the uid is exposed as a signal,
and **no `users/**` doc is written\*\*.

### Routing

`apps/mobile/src/app/app.routes.ts`: root path renders the tabs shell; default
child is **Watchlist**:

```ts
{ path: 'tabs', loadComponent: () => import('./tabs/tabs.page').then(m => m.TabsPage),
  children: [
    { path: 'watchlist', loadComponent: () => import('@vultus/mobile/watchlist').then(m => m.WatchlistPage) },
    { path: 'search',    loadComponent: () => import('@vultus/mobile/search').then(m => m.SearchPage) },
    { path: 'settings',  loadComponent: () => import('@vultus/mobile/settings').then(m => m.SettingsPage) },
    { path: '', redirectTo: 'watchlist', pathMatch: 'full' },
  ] },
{ path: '', redirectTo: 'tabs/watchlist', pathMatch: 'full' },
```

Each slice barrel exports its page component (e.g.
`export { WatchlistPage } from './lib/watchlist.page';`). Component/route/symbol
names are recommendations; what is binding is **Watchlist is the default landing
tab**, three lazy child routes, and the barrel-exported page per slice.

## UI / Stitch screen refs

This is the global-theme + tab-bar shell, so it **establishes the app-wide Stitch
theme** (PLAN §2). The implementer **must pull the relevant Stitch shell / tab-bar
screen** via the `stitch` MCP — project **`projects/13590348714018893783`**
("Vultus Android App Design"): `list_screens` to find the shell/navigation screen,
then `get_screen` on it; **reference its screen ID in the PR**. Align the tab bar
structure (order, labels, icons) and the design tokens.

> **Graceful degradation:** if the `stitch` MCP is **unavailable in-session**,
> apply the PLAN §2 design tokens enumerated below (they are fully specified
> here) and **note in the PR that the MCP was unreachable** — a Stitch outage
> must not block an otherwise-correct PR. Reconcile icon/label specifics against
> the screen later if it becomes available.

Design tokens (PLAN §2 — the contract, seeded into `shared/ui-kit` + applied in
`apps/mobile/src/styles.scss`):

- **Dark-first** (the existing `dark.always.css` import stays).
- Typography: **Inter**.
- Primary: **Emerald `#10B981`** (Ionic `--ion-color-primary`).
- Surfaces: navy-slate `#0F172A` (background) / `#1E293B` (elevated/cards).
- **8px grid** spacing, **0.5rem** default radius.
- Semantic status colors (for later slices, document in the ui-kit theme so the
  watchlist slice consumes them): Watching `#3B82F6`, Completed `#10B981`,
  Dropped `#EF4444`, Planned `#94A3B8`.

Tabs (Ionic `IonTabs` / `IonTabBar` / `IonTabButton`, `ionicons`):

| Tab       | Route            | Default | Suggested ionicon   |
| --------- | ---------------- | ------- | ------------------- |
| Watchlist | `tabs/watchlist` | **yes** | `bookmark` / `list` |
| Search    | `tabs/search`    | no      | `search`            |
| Settings  | `tabs/settings`  | no      | `settings` / `cog`  |

Match the icon choices to the Stitch screen where it specifies them. Keep the
`shared/ui-kit` seed **theming-only** (tokens / SCSS), not speculative atoms
(PLAN §3 / CLAUDE.md 3+-slice rule).

## Implementation task graph

Order reflects the dependency chain: the slice libs and `shared/ui-kit` theming
must **exist** before the shell can import their barrels and consume the theme.
Tasks 2a–2d write **disjoint** file sets (their manifests are pairwise disjoint —
the orchestrator asserts this before fanning out) and run **[parallel]**. Task 1
(root + lib generation + dep) and Task 3 (the shell wiring) are **[sequential]**.

1. **[sequential] Root config, AngularFire dependency, and slice-lib generation.**
   (frontend-engineer + infrastructure-engineer territory — shared/root
   touchpoints; everything else depends on it.)
   - Add **`@angular/fire`** at the version compatible with Angular 21.2 /
     firebase 12 (verify compatibility — Risks), pin it, update `pnpm-lock.yaml`.
   - **Generate** the three stub libs with the repo's Angular library generator
     (`@nx/angular:library`, matching how existing libs were scaffolded — Vitest
     unit runner per `nx.json` generator defaults), at `libs/mobile/watchlist`,
     `libs/mobile/search`, `libs/mobile/settings`. Generation produces
     `project.json` (`tags: []` — correct, Sheriff tags by glob), `tsconfig.*`,
     `vite.config.mts`, an `eslint.config.mjs`, a barrel `src/index.ts`, and the
     `@vultus/mobile/<slice>` tsconfig path alias. Confirm the three path aliases
     land in `tsconfig.base.json`.
   - **Delete the generator's default scaffold component + its `*.spec.ts`** for
     all three libs (the `lib/<name>/…` files the `@nx/angular:library` generator
     emits), leaving only the project config + an empty/placeholder barrel, so
     tasks 2a–2c start from a **clean slate** and own every file in their
     manifests with no ambiguity. (The page component, README, and render test
     are written in 2a–2c.)
   - **Verify-then-edit `sheriff.config.ts` once** per Affected slices: confirm
     `'libs/mobile/<slice>'` glob + the `slice:watchlist|search|settings`
     vocabulary cover the new libs; edit only if a gap exists (record "no change
     needed" in the PR if so).
   - Files: `package.json`, `pnpm-lock.yaml`, `tsconfig.base.json`,
     `sheriff.config.ts`, and the **generator-scaffolded** project files for
     `libs/mobile/watchlist/**`, `libs/mobile/search/**`,
     `libs/mobile/settings/**` (project.json / tsconfig / vite.config /
     eslint.config / barrel). The **page component + README + render test** for
     each slice are written in tasks 2a–2c (disjoint).

2a. **[parallel] Watchlist stub page + barrel + README + render test
(`slice:watchlist`).** - One standalone Ionic placeholder page (`WatchlistPage`) — `IonHeader` /
`IonToolbar` / `IonTitle` / `IonContent` with placeholder copy identifying
the tab; may consume `@vultus/shared/ui-kit` theming. - Barrel `src/index.ts` exporting `WatchlistPage`. - Real `README.md` (no Nx scaffold text — CLAUDE.md): what the lib is, public
surface (`WatchlistPage`), usage note (lazy-loaded by the tabs shell),
Sheriff tags (`scope:mobile`, `slice:watchlist`). - A render `*.spec.ts` (Vitest + Angular TestBed, mirroring `app.spec.ts`). - Files: `libs/mobile/watchlist/src/index.ts`,
`libs/mobile/watchlist/src/lib/watchlist.page.ts`,
`libs/mobile/watchlist/src/lib/watchlist.page.html`,
`libs/mobile/watchlist/src/lib/watchlist.page.scss`,
`libs/mobile/watchlist/src/lib/watchlist.page.spec.ts`,
`libs/mobile/watchlist/README.md`.

2b. **[parallel] Search stub page + barrel + README + render test
(`slice:search`).** As 2a, for `SearchPage`. - Files: `libs/mobile/search/src/index.ts`,
`libs/mobile/search/src/lib/search.page.ts`,
`libs/mobile/search/src/lib/search.page.html`,
`libs/mobile/search/src/lib/search.page.scss`,
`libs/mobile/search/src/lib/search.page.spec.ts`,
`libs/mobile/search/README.md`.

2c. **[parallel] Settings stub page + barrel + README + render test
(`slice:settings`).** As 2a, for `SettingsPage`. - Files: `libs/mobile/settings/src/index.ts`,
`libs/mobile/settings/src/lib/settings.page.ts`,
`libs/mobile/settings/src/lib/settings.page.html`,
`libs/mobile/settings/src/lib/settings.page.scss`,
`libs/mobile/settings/src/lib/settings.page.spec.ts`,
`libs/mobile/settings/README.md`.

2d. **[parallel] `shared/ui-kit` Stitch theme seed (`scope:shared`).** - Replace/augment the placeholder barrel with a **theming** surface: a
theme SCSS/CSS-variables file carrying the PLAN §2 tokens (Emerald primary,
navy-slate surfaces, Inter, 8px grid, 0.5rem radius, the four status
colors), exported/importable by `apps/mobile`. Keep the barrel non-empty
and lint-clean. **Theming only — no atom components.** - Update `libs/shared/ui-kit/README.md` to a **real** README (the scaffold
currently says "generated with Nx" — replace it): what the lib is (shared
theming + future atoms), public surface, usage (imported by `apps/mobile`
global styles), Sheriff scope (`scope:shared`). - Files: `libs/shared/ui-kit/src/index.ts`,
`libs/shared/ui-kit/src/lib/theme.scss` (or `theme.ts` + scss),
`libs/shared/ui-kit/README.md`.

(Manifests 2a/2b/2c/2d are pairwise disjoint — distinct lib directories.)

3. **[sequential] `apps/mobile` shell wiring. Depends on tasks 1, 2a–2d** (it
   imports the three slice barrels and the ui-kit theme). frontend-engineer.
   - Add `environments/environment.ts` + `environment.prod.ts` (shapes above;
     prod uses **placeholders**), and the `project.json` `production`
     `fileReplacements` swapping them.
   - Add the **emulator-wiring helper** (small pure function that, given the
     environment + the `Auth`/`Firestore` instance, connects to emulators only
     when `useEmulators`) so the branch is unit-testable.
   - Rewrite `app.config.ts`: add `provideFirebaseApp` / `provideAuth` /
     `provideFirestore` (emulator-gated via the helper) + the anon-auth
     `provideAppInitializer` invoking `ShellAuthService.ensureSignedIn()`. Keep
     `provideIonicAngular` / `provideRouter` / `provideBrowserGlobalErrorListeners`.
   - Add `ShellAuthService` (uid signal + `ensureSignedIn`, using AngularFire
     `Auth` + `signInAnonymously`). **No `users/**` write.\*\*
   - Add the **tabs shell** component (`tabs.page.ts/html/scss`) with `IonTabs` /
     `IonTabBar` / three `IonTabButton`s (labels + `ionicons` icons matching the
     Stitch screen), and rewrite `app.routes.ts` to the tabs structure with
     **Watchlist default**.
   - **Remove the scaffold `home` page** (`apps/mobile/src/app/home/**`) and all
     references to it. The `App` root component keeps `IonApp` / `IonRouterOutlet`.
   - Apply the `shared/ui-kit` theme tokens in `apps/mobile/src/styles.scss`
     (keep the existing Ionic core + `dark.always.css` imports).
   - Add unit + component tests (Test plan): emulator-helper unit test, auth
     service/initializer unit test, tabs-shell component test, and update
     `app.spec.ts` **only if needed**. The `App` root component hosts only
     `IonApp` / `IonRouterOutlet` — the AngularFire providers live in the
     bootstrap (`app.config.ts`), **not** in the component's `imports` — so a
     Firebase provider mock may not be required. **Verify whether the existing
     `ion-app` / `ion-router-outlet` TestBed render still compiles as-is before
     adding any AngularFire mock**; add a mock only if TestBed actually needs one.
   - Files: `apps/mobile/src/environments/environment.ts`,
     `apps/mobile/src/environments/environment.prod.ts`,
     `apps/mobile/project.json` (fileReplacements),
     `apps/mobile/src/app/app.config.ts`,
     `apps/mobile/src/app/app.routes.ts`,
     `apps/mobile/src/app/firebase/emulators.ts` (+ `.spec.ts`),
     `apps/mobile/src/app/auth/auth.service.ts` (+ `.spec.ts`),
     `apps/mobile/src/app/tabs/tabs.page.ts` / `.html` / `.scss` (+ `.spec.ts`),
     `apps/mobile/src/styles.scss`,
     `apps/mobile/src/app/app.spec.ts` (update),
     **delete** `apps/mobile/src/app/home/**`.

4. **[sequential] Rewrite the e2e smoke spec (no-emulator). Depends on task 3.**
   qa-runner / frontend-engineer.
   - Rewrite `apps/mobile-e2e/src/app.smoke.spec.ts` — it currently asserts the
     redirect to `/home` and the home page copy, both of which **no longer
     exist**. Replace with a **no-emulator smoke check** that runs under the
     **existing `nx serve`-backed Playwright `webServer`** (which has **no**
     Firebase backend): assert the **tabs shell renders** (three
     `ion-tab-button`s) and that the landing route is **Watchlist**
     (`/tabs/watchlist`). **Do NOT assert anonymous auth / any emulator-backed
     behavior here** — that, plus emulator wiring into the `webServer`/CI, is
     PLAN §6 item 20 (decision 5). **This is the only orphaned reference to
     `home`; the removal must not leave a dangling import or test.**
   - **Do NOT change `playwright.config.ts`'s `webServer` or `ci.yml`** — they
     stay `nx serve`-backed with no emulator (decision 5). Note: because the dev
     server has no backend, if the app's render is gated on the anon session
     resolving, the implementer must ensure the shell **degrades gracefully**
     (renders the shell even when sign-in cannot complete) so this no-emulator
     smoke can observe the tabs; verify this against the gating implementation
     from task 3 and reconcile if needed.
   - Files: `apps/mobile-e2e/src/app.smoke.spec.ts` only.

(`firebase` and Capacitor are already installed; only `@angular/fire` is added —
verify it is genuinely absent before adding, and pick the Angular-21-compatible
version. The component/symbol/file names above are recommendations; the binding
contracts are the AngularFire DI pattern, the gated anon-auth, the Watchlist-
default tabs, the three tagged stub libs, the placeholder prod env, and the
no-`users/**`-write guardrail.)

## Test plan

Per the PLAN §5 pyramid — a thin shell, so the surface is a focused set of
**unit** tests (the logic: emulator gating, anon-auth), **component** tests (the
tabs shell + each stub page), and **one updated e2e** critical flow.

**Unit:**

- **Emulator-wiring helper** (`emulators.spec.ts`): given `useEmulators: true`
  (and `production: false`), the helper calls `connectAuthEmulator` /
  `connectFirestoreEmulator` (with mocked AngularFire fns) with the right
  host/port; given `useEmulators: false` (or `production: true`), it calls
  **neither**. (No live Firebase — assert against mocked connectors.)
- **Shell auth service** (`auth.service.spec.ts`): with a mocked AngularFire
  `Auth`, `ensureSignedIn()` calls `signInAnonymously`, resolves, and exposes the
  resolved **uid** via the signal; the **failure path** (sign-in rejects)
  surfaces the error (does not hang / does not silently expose a stale uid).
  Assert **no Firestore write occurs** (the service must not touch `users/**`).

**Component (Angular TestBed + Ionic test setup, mirroring `app.spec.ts`; no
emulator, no network, AngularFire mocked where a TestBed actually needs it):**

- **Tabs shell** (`tabs.page.spec.ts`): renders an `ion-tabs` with **three**
  `ion-tab-button`s, with the correct labels (Watchlist / Search / Settings),
  the configured `ionicons`, and the correct `tab`/route targets; **Watchlist is
  the default** (the `''` child redirects to `watchlist`).
- **Each stub page** (`watchlist|search|settings.page.spec.ts`): minimal render
  test — the page mounts and renders its `ion-content` / identifying copy.
- Updated `app.spec.ts` keeps asserting `ion-app` + `ion-router-outlet` render.
  Add an AngularFire provider mock **only if** the TestBed no longer compiles
  without one (the providers live in `app.config.ts`, not the component's
  `imports`); verify first (task 3).

**e2e (Playwright, `apps/mobile-e2e`) — no-emulator smoke only:** the existing
`app.smoke.spec.ts` is rewritten to drop the removed `/home` assertions and
instead assert, **under the existing `nx serve`-backed `webServer` (no Firebase
backend)**: `goto('/')` → the **tabs shell renders** (three `ion-tab-button`s
visible) and the **landing route is Watchlist** (`/tabs/watchlist`). **Anonymous
auth / emulator-backed behavior is NOT asserted here** (no emulator is available
to the dev server).

- **Why no emulator-backed e2e in this PR (decision 5):** the current harness
  runs **no** emulator — `ci.yml` is `lint test build`, and the Playwright
  `webServer` is `nx serve mobile` with no backend. The full **boot +
  anon-session + tab-nav e2e against the Firebase emulators** — and the wiring of
  `firebase emulators:start` into the `webServer` / CI — is **PLAN §6 item 20
  (e2e-setup spec)**, not 0010. So this spec's **actual green gate is unit +
  component + build** (what CI runs). This is also consistent with project memory
  (mirroring spec 0009): the **Firebase emulator cannot run under Claude Code
  tools here (loopback blocked)** — but here that is moot for the gate, because
  **no emulator-backed run is part of 0010's gate at all**. The implementing
  agent verifies unit + component + build in-session; the rewritten smoke spec
  runs via `nx e2e mobile-e2e` (locally / whenever e2e runs) against the
  `nx serve` dev server, needing **no** emulator and **no** secrets.

## Definition of done

Tailored from the PLAN §5 checklist to the projects touched. This spec's green
gate is **unit + component + build** (what `ci.yml` runs: `lint test build`); the
emulator-backed boot+nav e2e is **descoped to PLAN §6 item 20** (decision 5), not
run here. The verified Nx targets per project: `mobile` has
`lint`/`test`/`build`/`typecheck`; `shared-ui-kit` and the three new libs have
`lint`/`test`/`typecheck` (no `build` — non-app libs); `mobile-e2e` has only
`lint` and `e2e` (**no `test`/`build`** — so `lint test build` does **not**
exercise the smoke spec; it runs via `nx e2e mobile-e2e`).

- [ ] `pnpm nx run-many -t lint test -p mobile mobile-watchlist mobile-search
  mobile-settings shared-ui-kit` passes **with Sheriff active** (lint
      includes Sheriff): `apps/mobile` imports
      `@vultus/mobile/{watchlist,search,settings}` + `@vultus/shared/ui-kit` +
      third-party only; each slice stub imports `scope:shared` + Ionic only (no
      other slice); **no `scope:functions` import anywhere**. Unit tests
      (emulator-helper + auth-service) + component tests (tabs shell + each stub
      page) are green (no emulator, no network, no secrets; AngularFire mocked
      where a TestBed needs it).
- [ ] `pnpm nx typecheck mobile mobile-watchlist mobile-search mobile-settings
  shared-ui-kit` passes — the shell, the three slice stubs, and the ui-kit
      theme compile (AngularFire providers + environment types resolve). (A real
      `typecheck` target exists for each of these projects.)
- [ ] `pnpm nx build mobile` passes for the **production** configuration — the
      `fileReplacements` swap to `environment.prod.ts` succeeds and the bundle is
      within the existing budgets (`500kb`/`1mb` initial). (`shared-ui-kit` and
      the slice libs have no `build` target; their `lint`/`test`/`typecheck`
      cover them.)
- [ ] `pnpm nx affected -t lint test build --base=main` is green — this mirrors
      **exactly what CI runs**. The affected set whose `lint`/`test`/`build` is
      exercised is `mobile`, `mobile-watchlist`, `mobile-search`,
      `mobile-settings`, and `shared-ui-kit`. (`mobile-e2e` has no `test`/`build`;
      it is **not** covered by this line — its smoke spec runs via `nx e2e`.)
- [ ] **Component tests for the tabs shell** assert three tabs / correct
      labels+icons / **Watchlist default** (PLAN §5: component tests for
      non-trivial UI).
- [ ] The **rewritten no-emulator smoke spec** (`apps/mobile-e2e/src/
  app.smoke.spec.ts`) no longer references `/home` and asserts the tabs shell
      renders / Watchlist is the landing route — runnable via `nx e2e mobile-e2e`
      against the existing `nx serve`-backed `webServer` with **no emulator**.
      **The emulator-backed boot+anon+nav e2e is descoped to PLAN §6 item 20**
      (decision 5) and is **NOT** part of this PR's gate; `ci.yml` and
      `playwright.config.ts`'s `webServer` are **unchanged**.
- [ ] Every **new lib has a real `README.md`** (watchlist / search / settings)
      and `shared/ui-kit`'s README is rewritten — **no leftover Nx scaffold text**
      (CLAUDE.md lib-README rule).
- [ ] **`sheriff.config.ts` touched at most once** (verify-then-edit); the PR
      records whether an edit was needed or "no change needed".
- [ ] **Guardrail verifications (review-checked):** (a) **no `users/**`document
  is written** by the shell or the auth service — the anon session is created,
  nothing in Firestore is written; the`users/{uid}`doc remains the settings
  slice's job (item 16); (b) **no`scope:functions`file is touched** (this
  spec runs in parallel with spec 0009); (c) **no secret is read or written** —
 `.env.local`is never touched, the Firebase **web config is public** (dev =
  placeholder/demo, prod = clearly-marked placeholders the user fills per
  PLAN §7); (d) the scaffold`home` page is removed with **no orphaned
  reference** (`app.routes.ts`, e2e, any import).
- [ ] PR description records: the **Stitch screen ID** used for the tab bar (or
      that the `stitch` MCP was unreachable and PLAN §2 tokens were applied), the
      chosen `@angular/fire` version + the Angular-21/firebase-12 compatibility
      check, the exact verification commands, the no-`users/**`-write / no-secret /
      no-`scope:functions` boundary confirmations, and that the **emulator-backed
      boot+nav e2e is descoped to PLAN §6 item 20** (decision 5) — this PR's gate
      is unit + component + build, with only a no-emulator smoke-spec rewrite.

## Risks

- **AngularFire ↔ Angular 21.2 / firebase 12 compatibility (verify before
  coding).** `@angular/fire` must match Angular's major and support firebase 12.
  The implementer **must verify** the compatible version (release notes / peer
  deps) and pick the matching major; if no `@angular/fire` release supports
  Angular 21.2 cleanly, **stop and flag it in the PR** rather than force a
  mismatched/legacy-compat install. (A fallback — using the raw `firebase` SDK
  via thin injectable providers instead of `@angular/fire` — exists but is a
  **deviation from locked decision 1**, so it requires re-approval, not a silent
  switch.)
- **Emulator-backed e2e is descoped — the harness runs none today.** `ci.yml`
  runs only `pnpm nx affected -t lint test build` (no `e2e` target, no emulator
  startup), and `playwright.config.ts`'s `webServer` runs `nx serve mobile` with
  **no** Firebase backend. So an emulator-backed boot+anon-session e2e is
  executed by **nothing** in the current harness. **Resolution (decision 5):**
  this PR's green gate is **unit + component + build** (what CI runs); the full
  boot + anon-session + tab-nav e2e against the emulators — and wiring
  `firebase emulators:start` into the `webServer` / CI — is owned by the
  **e2e-setup spec (PLAN §6 item 20)**. The 0010 e2e change is limited to a
  **no-emulator smoke-spec rewrite** (drop `/home`, assert tabs render +
  Watchlist landing) runnable under the existing `nx serve` `webServer`. (Project
  memory's loopback constraint — the emulator can't run under Claude Code tools
  here, same as spec 0009 — is consistent with this: no in-session emulator run
  is claimed, and none is part of the gate.) **No `ci.yml` or `webServer` change
  is made here** — that would belong to item 20.
- **No-emulator smoke depends on graceful render gating.** Because the dev server
  has no backend, anon sign-in cannot complete under the smoke run. If the shell
  hard-blocks render until the uid resolves, the smoke spec would never see the
  tabs. **Mitigation:** the shell's render gating (task 3) must degrade
  gracefully (render the shell shell even if sign-in cannot complete); the
  implementer reconciles task 3's `provideAppInitializer` gating with the
  no-emulator smoke (task 4) — the full auth-gated boot is asserted later by item
  20 against the emulators.
- **Front-loading three stub libs into the shell spec.** Generating
  `watchlist`/`search`/`settings` here (rather than in each slice's own spec) is
  deliberate: it means later slice specs flesh out an **already-tagged,
  already-routed** lib and never re-edit root `sheriff.config.ts` / `app.routes.ts`.
  The stubs are **minimal** (one placeholder page each). **This is NOT a premature
  `shared/` extraction** — they are **three distinct slices**, one per tab, each
  with its own scope+slice tag; the near-identical placeholder pages are allowed
  duplication that will diverge (CLAUDE.md: don't DRY across slices).
- **Placeholder prod Firebase config.** The app will **not** connect to real prod
  until the user pastes the real public web config into `environment.prod.ts` (a
  **PLAN §7 manual prereq**). Dev + CI run **emulator-only** (`useEmulators:
true`), so this does **not** block a green PR. The placeholders are
  clearly-marked; the Firebase web config is **public, not a secret** (it ships in
  every client), so committing it is correct — flagged here so a reviewer does not
  mistake it for a secrets violation.
- **Scaffold `home` removal must not orphan references.** The current
  `app.routes.ts` redirects `'' → home` and the e2e smoke test asserts `/home` +
  home copy. Both are rewritten (tasks 3 + 4); the implementer must confirm **no
  remaining import/route/test references `home`** after removal (a grep for
  `home` across `apps/mobile**` + `apps/mobile-e2e**` is the check).
- **Parallel with spec 0009 (`scope:functions`).** This spec is `scope:mobile` +
  `scope:shared` and **touches no `scope:functions` file**, so it can land
  alongside the in-flight 0009. The only shared-ish files are root config
  (`package.json`/`pnpm-lock.yaml`/`tsconfig.base.json`) — both specs add
  dependencies; a lockfile/`package.json` merge conflict is possible and resolved
  at merge time (additive, not a logic conflict). `sheriff.config.ts` is touched
  by neither in a conflicting way (0009 explicitly does not edit it; this spec
  edits it at most once, additively).
- **Anonymous auth must be enabled (prod) — already a PLAN §7 manual prereq.** The
  emulator allows it by default (dev/CI fine); in prod the console must have
  Anonymous sign-in enabled (the user's job, PLAN §7). Noted, not coded.
- **No PLAN conflict.** This implements PLAN §6 item 15 as written; the
  `slice:title-detail` lib is deliberately **not** created (it is not a tab — PLAN
  §6 item 19), and `users/**` creation is correctly deferred to the settings slice
  (PLAN §6 item 16). The AngularFire choice is an implementation detail consistent
  with PLAN §2's Firebase Auth/Firestore decisions.
  </content>
  </invoke>
