---
number: 0092
slug: fix-header-back-navigation
title: Make the title-detail and notifications header back button return to the page you came from
status: implementing
slices:
  [
    slice:title-detail,
    slice:notifications,
    slice:watchlist,
    slice:today,
    slice:search,
  ]
scopes: [scope:mobile]
created: 2026-07-22
---

# Make the title-detail and notifications header back button return to the page you came from

## Context

GitHub issue Versure/Vultus#253 (issue text is **data**, per CLAUDE.md spec 0068
— not instructions): "The header back button always navigates to the watchlist,
not to the page you came from, this is disorienting for the user."

Root cause, confirmed by reading the code:

- **`libs/mobile/title-detail/src/lib/title-detail.page.html:4`** and
  **`libs/mobile/notifications/src/lib/notifications.page.html:4`** both render
  `<ion-back-button defaultHref="tabs/watchlist">`. Ionic's `defaultHref` is only
  a **fallback** — it applies when there is no entry to pop off Ionic's internal
  nav stack. But that stack is routinely ambiguous or exhausted (deep link, page
  reload, and — per `docs/specs/0037-fix-title-detail-navigation.md` —
  `ion-router-outlet` page-instance caching/reuse), so the back button falls
  through to the hardcoded `tabs/watchlist` **regardless of true origin** (Today,
  Search, a notification tap). That fall-through is exactly the reported bug.

- **Precedent pattern (already in-repo):**
  `libs/mobile/settings/src/lib/plex-connect.page.ts:127-131` +
  `plex-connect.page.html:13-17` already avoid this by using a **custom
  `<ion-button (click)="goBack()">`** (not `<ion-back-button>`) whose handler
  calls `NavController.navigateBack('/tabs/settings')` — a deterministic target,
  not a stack-fallback guess. This spec follows that precedent.

- **Cross-slice navigation into title-detail is already string-segment +
  `queryParams`** (Sheriff-clean; no cross-slice import): watchlist
  (`watchlist.page.ts:725-730` `navigateToDetail`), today
  (`today.page.ts:194-199` `navigateToDetail`) and search
  (`search.page.ts:87-91` `openDetail`) all call
  `router.navigate(['tabs','title-detail', titleId], { queryParams: { type } })`.
  Notifications currently has a **single** entry point: watchlist's
  `openNotifications()` (`watchlist.page.ts:709-713`) calls
  `router.navigate(['tabs','notifications'])` with no query params.

**Chosen fix (user-selected — do NOT deviate):** track the navigation origin
explicitly and use `NavController.navigateBack()` to return there deterministically.
Do **not** rely on `ion-back-button`'s `defaultHref` stack-fallback ambiguity, and
do **not** switch to a bare `location.back()`.

**Intended outcome:** tapping the header back button on title-detail returns to
the tab the user came from (Watchlist, Today, or Search); the notifications back
button returns to Watchlist deterministically (its only entry point today).

## Scope

**In scope (all `scope:mobile`):**

1. **`slice:title-detail` — custom back button + origin resolution.** Replace
   `<ion-back-button defaultHref="tabs/watchlist">` in `title-detail.page.html`
   with a custom `<ion-button (click)="goBack()">` (mirroring plex-connect). Add a
   `goBack()` handler that resolves the `?origin=` query param to a concrete tab
   route and calls `NavController.navigateBack(target)`:
   - `origin=watchlist` → `/tabs/watchlist`
   - `origin=today` → `/tabs/today`
   - `origin=search` → `/tabs/search`
   - missing / unrecognized → `/tabs/watchlist` (fallback)
2. **`slice:notifications` — custom back button.** Replace
   `<ion-back-button defaultHref="tabs/watchlist">` in `notifications.page.html`
   with a custom `<ion-button (click)="goBack()">` whose handler calls
   `NavController.navigateBack('/tabs/watchlist')` directly. **No `origin` query
   param** — notifications has one caller today; this is a mechanism fix (kill the
   stack-fallback ambiguity), not new origin-tracking. Do not over-engineer.
3. **`slice:watchlist`, `slice:today`, `slice:search` — thread `origin`.** Each
   existing call that navigates to `tabs/title-detail/:id` adds an `origin` query
   param identifying itself, alongside the existing `type`:
   - `watchlist.page.ts` `navigateToDetail` → `queryParams: { type, origin: 'watchlist' }`
   - `today.page.ts` `navigateToDetail` → `queryParams: { type, origin: 'today' }`
   - `search.page.ts` `openDetail` → `queryParams: { type: result.type, origin: 'search' }`
     Watchlist's `openNotifications()` (`tabs/notifications`) is **unchanged** — no
     origin param (see notifications above).
4. Unit/component test updates for all of the above (see Test plan).
5. Two e2e flows extending the existing `apps/mobile-e2e/src/title-detail.spec.ts`
   (Watchlist→detail→back and Today→detail→back).

**Out of scope (verify-and-record "no change needed"):**

- **`libs/mobile/settings/src/lib/plex-connect.page.ts` / `.html`** — already does
  the right thing (custom button + fixed `navigateBack('/tabs/settings')`, single
  entry point via Settings). **Not touched.**
- **`openNotifications()` origin-tracking** — deliberately not added (single
  caller; mechanism fix only).
- Any `shared/domain` / `shared/*` change, any data-model / `firestore.rules` /
  `firestore.indexes.json` / `sheriff.config.ts` change, any onboarding change.
- The rest of both headers (brand mark, account button, "Mark all read", title,
  the notifications-off empty state) and every non-header behavior of both pages.
- Search→detail→back and notifications-bell→notifications→back **e2e** coverage
  (explicitly discussed with the user and NOT selected for e2e — component/unit
  coverage below is sufficient). The `origin: 'search'` param is still wired in
  `search.page.ts` as part of the fix; only its dedicated e2e assertion is omitted.

## Affected slices & Sheriff tags

| Project              | Path                                                           | Sheriff tags                          | Change                                                                                           |
| -------------------- | -------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| mobile-title-detail  | `libs/mobile/title-detail/src/lib/title-detail.page.html`      | `scope:mobile`, `slice:title-detail`  | replace `<ion-back-button>` with custom `<ion-button (click)="goBack()">` + back-arrow icon      |
| mobile-title-detail  | `libs/mobile/title-detail/src/lib/title-detail.page.ts`        | `scope:mobile`, `slice:title-detail`  | inject `NavController`; reactive `origin$` + synchronous `currentOrigin`; `goBack()` resolver    |
| mobile-title-detail  | `libs/mobile/title-detail/src/lib/title-detail.page.spec.ts`   | `scope:mobile`, `slice:title-detail`  | back-button resolves the right `navigateBack` target per origin (+ fallback)                     |
| mobile-notifications | `libs/mobile/notifications/src/lib/notifications.page.html`    | `scope:mobile`, `slice:notifications` | replace `<ion-back-button>` with custom `<ion-button (click)="goBack()">` + back-arrow icon      |
| mobile-notifications | `libs/mobile/notifications/src/lib/notifications.page.ts`      | `scope:mobile`, `slice:notifications` | inject `NavController`; add `goBack()` → `navigateBack('/tabs/watchlist')`; add `arrowBack` icon |
| mobile-notifications | `libs/mobile/notifications/src/lib/notifications.page.spec.ts` | `scope:mobile`, `slice:notifications` | back-button click calls `navigateBack('/tabs/watchlist')`                                        |
| mobile-watchlist     | `libs/mobile/watchlist/src/lib/watchlist.page.ts`              | `scope:mobile`, `slice:watchlist`     | `navigateToDetail` adds `origin: 'watchlist'` to `queryParams`                                   |
| mobile-watchlist     | `libs/mobile/watchlist/src/lib/watchlist.page.spec.ts`         | `scope:mobile`, `slice:watchlist`     | assert `origin: 'watchlist'` in the navigate call                                                |
| mobile-today         | `libs/mobile/today/src/lib/today.page.ts`                      | `scope:mobile`, `slice:today`         | `navigateToDetail` adds `origin: 'today'` to `queryParams`                                       |
| mobile-today         | `libs/mobile/today/src/lib/today.page.spec.ts`                 | `scope:mobile`, `slice:today`         | assert `origin: 'today'` in the navigate call                                                    |
| mobile-search        | `libs/mobile/search/src/lib/search.page.ts`                    | `scope:mobile`, `slice:search`        | `openDetail` adds `origin: 'search'` to `queryParams`                                            |
| mobile-search        | `libs/mobile/search/src/lib/search.page.spec.ts`               | `scope:mobile`, `slice:search`        | assert `origin: 'search'` in the navigate call                                                   |
| mobile-e2e           | `apps/mobile-e2e/src/title-detail.spec.ts`                     | _(untagged — black-box)_              | extend F4 to click back → `/tabs/watchlist`; add Today→detail→back → `/tabs/today`               |

- **No cross-slice / cross-scope import.** Every change is slice-internal. The
  five mobile slices communicate via **string-segment navigation + query params**
  exactly as they already do (spec 0043) — no `@vultus/mobile/*` slice import is
  added; the `origin` string is just another query-param value. `NavController`,
  `Router`, `ActivatedRoute`, and the `arrowBack` icon all come from
  `@ionic/angular/standalone` / `@angular/router` / `ionicons`, which these slices
  already consume.
- **No `shared/` extraction.** The origin→route resolver is a ~4-line
  slice-internal map used by **one** slice (title-detail). It is **not** duplicated
  across 3+ slices (notifications uses a single fixed target, not the resolver), so
  the "extract only at 3+ slices" rule (PLAN §3) does not apply. Do **not** hoist
  it into `shared/`.
- **No `sheriff.config.ts` change.** No new lib, no new tag; existing globs already
  tag all five `libs/mobile/*/src` slices. Record "no `sheriff.config.ts` change
  needed" in the PR.

## Data model touchpoints

**None.** This is pure client-side routing. No Firestore collection or field is
read, written, or added; no converter change. Consequently:

- **`firestore.rules` — no change.** No new read/write path.
- **`firestore.indexes.json` — no change.** No new query.
- **No rules-test change.**

Record all three as "no change needed" in the PR so a reviewer does not go looking
for an orphaned rules/index/rules-test task.

## Public types / APIs

**None.** No new or changed `shared/domain` type, token, callable, or HTTP shape.

- The `origin` value travels only as a URL **query-param string** (`'watchlist' |
'today' | 'search'`); it is **not** a persisted field and **not** part of any
  Firestore document. No `shared/*` file changes → **no F2 shared-type ripple.**
- **No `User` domain field is added or changed → the F4 onboarding-parity rule
  does not apply** (no persisted preference; a transient query param is not a user
  setting).
- Public barrels are unchanged: `TitleDetailPage` gains a public `goBack()` method
  (template-bound handler), `NotificationsPage` gains a public `goBack()` method;
  neither changes the barrel export surface. `watchlist`/`today`/`search`
  navigation method signatures are unchanged (only the object literal passed to
  `router.navigate` gains one key).
- **README impact:** none of the five libs change their public API, boundaries, or
  documented behavior in a way that needs a README rewrite; update a lib's
  `README.md` **only if** it currently documents the header back-navigation
  behavior (verify — likely a "no README change needed" record).

### Behavior contract for the implementer (illustrative — behavior is the contract)

**title-detail** — mirror the existing reactive `typeHint$` / `currentTmdbId`
pattern already in `title-detail.page.ts` (lines 172-200) so the origin is not
read from a stale snapshot under Ionic page reuse (the exact failure mode spec
0037 fixed for `tmdbId`):

```ts
private readonly nav = inject(NavController);

/** Origin tab that opened this page, from ?origin=; drives the back target. */
private currentOrigin: string | null = null;

// in constructor, alongside the existing tmdbId$ subscription:
this.route.queryParamMap
  .pipe(map((p) => p.get('origin')), distinctUntilChanged(), takeUntilDestroyed())
  .subscribe((o) => (this.currentOrigin = o));

/** Header back — return to the tab we came from (deterministic, not stack fallback). */
goBack(): void {
  const target =
    this.currentOrigin === 'today' ? '/tabs/today'
    : this.currentOrigin === 'search' ? '/tabs/search'
    : '/tabs/watchlist'; // 'watchlist' + missing/unrecognized fallback
  void this.nav.navigateBack(target);
}
```

Remove `IonBackButton` from the component `imports` (and the `@ionic/angular/standalone`
import) once the template no longer uses it; add `NavController` and the
`arrowBack` icon (`addIcons({ ..., arrowBack })`).

**notifications** — no origin param; single fixed target:

```ts
private readonly nav = inject(NavController);
goBack(): void {
  void this.nav.navigateBack('/tabs/watchlist');
}
```

## UI / Stitch screen refs

**No new Stitch screen fetch required — this reuses an existing in-repo header
control pattern, changing only the back button's mechanism, not the header
chrome's appearance.**

The replacement back control is **visually identical** to the existing
`ion-back-button` (a leading back chevron/arrow in `ion-buttons slot="start"`) and
follows the **already-shipped** `plex-connect.page.html:13-17` custom-back-button
markup verbatim:

```html
<ion-buttons slot="start">
  <ion-button class="back-button" aria-label="Go back" (click)="goBack()">
    <ion-icon name="arrow-back" slot="icon-only"></ion-icon>
  </ion-button>
</ion-buttons>
```

Checkable UI contract (both title-detail and notifications headers):

- **Icon:** Ionicon `arrow-back` (`slot="icon-only"`) — the same glyph
  `plex-connect` uses; do **not** invent a new asset. `arrow-back` must be
  registered via `addIcons({ arrowBack })` in each page's constructor (an unregistered
  Ionicon renders blank — the token-must-be-wired trap).
- **Placement:** inside `<ion-buttons slot="start">`, first control in the toolbar,
  replacing the removed `<ion-back-button>` — header layout, brand mark / title,
  and the trailing controls (title-detail's account button; notifications'
  "Mark all read") are **unchanged**.
- **Accessibility:** `aria-label="Go back"` (an `icon-only` button has no visible
  text label).
- **Colors / sizing:** default `ion-button` in a toolbar — inherit the
  toolbar/`--vultus-*` theme already applied (tokens live at
  `docs/design/vultus-design-system.md`; do **not** reprint hex). No new spacing,
  radius, or color is introduced.
- **Interactive states:** an `ion-button` provides the standard Ionic ripple/press
  (active) and focus states out of the box, identical to `plex-connect`'s back
  button and the surrounding toolbar buttons — no custom default/hover/focus/
  active/disabled styling is added (the button is always enabled; there is no
  disabled state).
- **Verify:** on `pnpm nx run mobile:serve-mock`, the back arrow renders in both
  headers and tapping it returns to the originating tab. If serve-mock cannot be
  run here, explicitly flag **UNVERIFIED for a human eyeball** (CLAUDE.md
  UI-fidelity rule) — do not report done off a green build alone.

## Implementation task graph

The title-detail back-button + resolver (T1) is the consumer of the `origin` query
param; the three navigation-caller edits (T3–T5) are the producers. They touch
**disjoint files** and the resolver falls back safely when `origin` is absent, so
they can run **in parallel** — a title-detail with the resolver but a
watchlist/today not yet threading `origin` simply falls back to `/tabs/watchlist`
(no crash). Notifications (T2) is independent. No shared-dep / new-slice / root
wiring exists, so there is **no `[sequential]` gate**. The e2e task (T6) depends on
T1 + T3 + T4 (title-detail resolver + watchlist/today origin) being present in the
worktree — the Today→back flow's preferred variant taps the real `.today-card`,
which only carries `origin: 'today'` once T4 lands; without T4 that tap falls back
to `/tabs/watchlist` and the assertion fails. (T1 alone is enough for T6's
deterministic `?origin=today` direct-nav fallback, but not for the card-tap
variant — see T6.)

### T1 — title-detail custom back button + origin resolver (frontend-engineer) `[parallel]`

Manifest (writes only):

- `libs/mobile/title-detail/src/lib/title-detail.page.html`
- `libs/mobile/title-detail/src/lib/title-detail.page.ts`
- `libs/mobile/title-detail/src/lib/title-detail.page.spec.ts`

Steps: replace the `<ion-back-button>` (`.html:2-5`) with the custom
`<ion-button (click)="goBack()">` markup above; in `.ts` inject `NavController`,
add the reactive `origin$`→`currentOrigin` subscription (mirroring the existing
`tmdbId$`/`currentTmdbId` pattern), add `goBack()` with the four-way resolver,
register `arrowBack`, and drop the now-unused `IonBackButton` import; add the
component tests (see Test plan).

### T2 — notifications custom back button (frontend-engineer) `[parallel]`

Manifest (writes only):

- `libs/mobile/notifications/src/lib/notifications.page.html`
- `libs/mobile/notifications/src/lib/notifications.page.ts`
- `libs/mobile/notifications/src/lib/notifications.page.spec.ts`

Steps: replace the `<ion-back-button>` (`.html:3-5`) with the custom back button;
inject `NavController`, add `goBack()` → `navigateBack('/tabs/watchlist')`,
register `arrowBack`, drop the unused `IonBackButton` import; add the component
test.

### T3 — watchlist origin param (frontend-engineer) `[parallel]`

Manifest (writes only):

- `libs/mobile/watchlist/src/lib/watchlist.page.ts`
- `libs/mobile/watchlist/src/lib/watchlist.page.spec.ts`

Steps: in `navigateToDetail` (`~L725-730`) add `origin: 'watchlist'` to
`queryParams`. `openNotifications` unchanged. Update the spec's navigate
assertion.

### T4 — today origin param (frontend-engineer) `[parallel]`

Manifest (writes only):

- `libs/mobile/today/src/lib/today.page.ts`
- `libs/mobile/today/src/lib/today.page.spec.ts`

Steps: in `navigateToDetail` (`~L194-199`) add `origin: 'today'` to `queryParams`.
Update the spec's navigate assertion.

### T5 — search origin param (frontend-engineer) `[parallel]`

Manifest (writes only):

- `libs/mobile/search/src/lib/search.page.ts`
- `libs/mobile/search/src/lib/search.page.spec.ts`

Steps: in `openDetail` (`~L87-91`) add `origin: 'search'` to `queryParams`. Update
the spec's navigate assertion.

### T6 — e2e back-to-origin flows (qa-runner / frontend-engineer) `[parallel, after T1+T3+T4]`

Manifest (writes only):

- `apps/mobile-e2e/src/title-detail.spec.ts`

Steps: **extend the existing file** (do not create a new one), reusing its
`bootAndSeed` fixture and the seeded "Breaking Bad" (tmdbId 2) pattern:

- **Watchlist→detail→back:** in the existing `title-detail F4 —
watchlist-to-detail-correct-title` block, after the card tap lands on
  `/tabs/title-detail/2` and the hero asserts, click the header back button and
  assert the URL returns to `/tabs/watchlist`.
- **Today→detail→back (the #253 regression):** boot lands on Today (spec 0083).
  Reach title-detail with Today as the recorded origin, then click back and assert
  the URL returns to **`/tabs/today`, NOT `/tabs/watchlist`**. At implementation,
  inspect whether `bootAndSeed`'s seed renders a tappable Today card
  (`today.page.html`'s `.today-card` → `navigateToDetail(titleId, type)`): if it
  does, tap it (exercises the real `origin: 'today'` wiring end-to-end); if the
  seed yields no "ready to watch" card, navigate directly to
  `/tabs/title-detail/2?type=tv&origin=today` (exercises the resolver→
  `navigateBack` path deterministically). Either way the load-bearing assertion is
  `back → /tabs/today`.

Both flows are **fixme-free** (the route + all entry points already exist; no
unmerged-spec dependency). Per project memory (`emulator-tooling-limitation`), the
Firestore emulator cannot run under Claude Code tools here — these e2e flows
**degrade gracefully** (authored + committed, run in CI / the user's terminal).
The component/unit tests in T1–T5 are the in-tool proof.

> **Query-param ordering note (no test regression):** adding `origin` after `type`
> yields `?type=tv&origin=watchlist`. The existing F4 assertion
> `toHaveURL(/\/tabs\/title-detail\/2\?type=tv/)` is an unanchored prefix match and
> **still passes**. Keep `type` first in the object literal so this holds.

## Test plan

Per the PLAN §5 pyramid: **component/unit** for every slice's logic, **e2e** for
the two named navigation flows.

**Component — `title-detail.page.spec.ts` (Angular Testing Library on Vitest;
`NavController` mocked via DI; `ActivatedRoute.queryParamMap` driven so `origin`
can be set):**

- **Back resolves the origin target:** with `origin=watchlist`, invoking
  `goBack()` (or clicking the header back button) calls
  `navController.navigateBack('/tabs/watchlist')`; with `origin=today` →
  `'/tabs/today'`; with `origin=search` → `'/tabs/search'`.
- **Fallback:** with `origin` **absent** and with an **unrecognized** value (e.g.
  `origin=bogus`), `goBack()` calls `navigateBack('/tabs/watchlist')`.
- **F3 exact-target discipline:** assert the **literal** target string passed to
  `navigateBack` (`'/tabs/today'`, etc.) — do **not** use a partial / normalized /
  `stringContaining` match. A `navigateBack('/tabs/todayXYZ')` or a stray-space
  target must fail the assertion.
- **No regression:** existing `title-detail.page.spec.ts` specs stay green
  (dropping `IonBackButton` from imports must not break the render).

**Component — `notifications.page.spec.ts`:**

- Back button click / `goBack()` calls `navController.navigateBack('/tabs/watchlist')`
  (assert the exact literal string). Existing specs stay green.

**Unit/component — `watchlist.page.spec.ts`, `today.page.spec.ts`,
`search.page.spec.ts`:**

- Assert the respective navigate call now includes the correct `origin` in
  `queryParams`: watchlist → `{ type: <type>, origin: 'watchlist' }`, today →
  `{ type: <type>, origin: 'today' }`, search →
  `{ type: <type>, origin: 'search' }`. Assert the **exact** object (or the exact
  `origin` value + preserved `type`) — do not weaken existing navigate assertions.
  `watchlist.page.spec.ts` must also confirm `openNotifications` still navigates to
  `['tabs','notifications']` with **no** `origin` (unchanged).

**e2e — REQUIRED (per the rubric):** this is a `scope:mobile` fix to a primary
user-facing navigation action; the two flows below become DoD gates
(`qa-runner` / `feature-reviewer`), run against the emulator-backed harness
(spec 0019: `clearAll` / `resolveAnonUid` / `seedFor`):

- **`watchlist-to-detail-back-returns-to-watchlist`** (extend the existing F4
  test): tap the seeded card → `/tabs/title-detail/2` → click header back →
  assert `toHaveURL(/\/tabs\/watchlist$/)`.
- **`today-to-detail-back-returns-to-today`** (new, the #253 core scenario): reach
  title-detail from Today (tapped card or `?origin=today` direct nav — see T6) →
  click header back → assert `toHaveURL(/\/tabs\/today$/)` (and explicitly **not**
  `/tabs/watchlist`).

Search→detail→back and notifications-bell→notifications→back are **not** covered
by e2e per the user's decision (component/unit coverage above suffices).

## Definition of done

Tailored from PLAN §5 / CLAUDE.md. Every checkbox maps to a task (T1–T6).

- [ ] `pnpm nx affected -t lint typecheck test build --base=main` green — affected
      set: `mobile-title-detail`, `mobile-notifications`, `mobile-watchlist`,
      `mobile-today`, `mobile-search`, `mobile`. (T1–T5)
- [ ] **Sheriff clean** (in the lint above): no new cross-slice / cross-scope
      import; the five slices still communicate only via string-segment nav + query
      params; no `sheriff.config.ts` change. (T1–T5)
- [ ] **title-detail back button** replaced with a custom `<ion-button
(click)="goBack()">` + `arrow-back` icon; `goBack()` resolves
      `watchlist→/tabs/watchlist`, `today→/tabs/today`, `search→/tabs/search`,
      missing/unrecognized→`/tabs/watchlist`, via `NavController.navigateBack`;
      `IonBackButton` import removed; origin read reactively (no stale snapshot).
      (T1)
- [ ] **notifications back button** replaced with a custom `<ion-button
(click)="goBack()">` + `arrow-back` icon → `navigateBack('/tabs/watchlist')`;
      `IonBackButton` import removed. (T2)
- [ ] **`origin` threaded** in `watchlist.page.ts` (`'watchlist'`),
      `today.page.ts` (`'today'`), `search.page.ts` (`'search'`) navigate calls,
      alongside the existing `type`; `openNotifications` unchanged. (T3–T5)
- [ ] **Component/unit tests** cover the resolver targets + fallback (title-detail),
      the fixed target (notifications), and the `origin` query-param additions
      (watchlist/today/search), asserting **exact** target/param strings (F3); all
      pre-existing specs in the five slices stay green. (T1–T5)
- [ ] **e2e authored + committed:** `watchlist-to-detail-back-returns-to-watchlist`
      (extends F4) and `today-to-detail-back-returns-to-today` (new) assert back
      returns to the originating tab. Run green where the emulator gate is runnable;
      degrade gracefully if the emulator tooling is absent here (project memory
      `emulator-tooling-limitation`) — flag for a run in the user's terminal rather
      than reporting them passed. (T6)
- [ ] **Visual verification** on serve-mock: the back arrow renders in both headers
      and tapping it returns to the originating tab — OR explicitly flagged
      UNVERIFIED for a human. (T1, T2)
- [ ] **Verify-and-record NO change:** `plex-connect.page.*` untouched;
      `openNotifications` origin-tracking not added; no `shared/*`, data-model,
      `firestore.rules`, `firestore.indexes.json`, rules-test, `sheriff.config.ts`,
      or onboarding change; README changes only if a lib documented the back-nav
      behavior (else "no README change needed"). (T1–T6)
- [ ] **No `User` domain field changed → F4 onboarding-parity rule N/A** — recorded.
- [ ] **No secret read/written** (CLAUDE.md hard rule).
- [ ] PR references this spec and records: the fix (issue #253 — `defaultHref`
      stack-fallback replaced by explicit origin tracking + `NavController.navigateBack`),
      the origin→route mapping, and the e2e run status (run here vs deferred to the
      user's terminal).

## Risks

- **Origin param is best-effort, resolver must fail safe.** A deep link, a
  notification tap (`notification-deep-links` e2e / spec), or any future caller that
  reaches `tabs/title-detail/:id` without an `origin` will hit the
  `/tabs/watchlist` fallback — the **same** behavior as today, so it is a strict
  non-regression, not a new bug. The resolver must treat any missing/unknown value
  as the watchlist fallback (never throw, never navigate to a bogus route). Covered
  by the fallback component test.
- **Stale-snapshot trap (spec 0037).** `origin` must be read from the reactive
  `route.queryParamMap` (kept in a `currentOrigin` field via `takeUntilDestroyed`),
  **not** a one-time `route.snapshot`, so a reused `ion-router-outlet` page instance
  (A→B→A on the same component) resolves the current origin, not the first
  navigation's. This mirrors the existing `tmdbId$`/`currentTmdbId` handling in the
  same file — do not regress it by reading a snapshot in `goBack()`.
- **`navigateBack` vs the tab stack.** `NavController.navigateBack(target)` plays
  the reverse transition and navigates to `target`; because all three targets are
  top-level tab routes this is deterministic (matches the shipped `plex-connect`
  precedent). If a future requirement needs to return to a _scrolled/stateful_
  origin rather than the tab root, that is a separate spec — out of scope here.
- **e2e emulator gate not runnable here** (project memory
  `emulator-tooling-limitation`) — the two flows are authored/committed and gate in
  CI / the user's terminal; the component tests are the in-tool proof. Do not report
  the e2e flows green off a build alone.
- **No PLAN conflict.** All changes stay within their respective `scope:mobile`
  vertical slices and the existing string-segment cross-slice navigation contract
  (PLAN §3); no cross-slice/cross-scope import, no shared extraction, no data-model
  change (PLAN §4), no `User` field (F4 N/A).
  </content>
  </invoke>
