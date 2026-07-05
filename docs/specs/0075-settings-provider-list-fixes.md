---
number: 0075
slug: settings-provider-list-fixes
title: Fix "N of 0 selected" providers on Settings entry + make the provider list collapsible
status: done
slices: [slice:settings]
scopes: [scope:mobile]
created: 2026-07-05
---

## Context

Two GitHub reports against the "My Providers" card on the Settings tab
(`libs/mobile/settings`, spec 0060/0061):

- **#165 (bug).** Entering Settings shows the footer **"5 of 0 selected"** in
  "My Providers": the count of _selected_ ids is right (`myProviderIds` loaded
  from the user doc) but the _catalog length_ `M` is `0`, and no chips render.
  Switching the region "fixes" it (chips appear). Root cause (verified by reading
  the code, below): the page fires `load()` and `loadProviderCatalog()`
  **concurrently** in `ngOnInit`, and the catalog load early-returns on the
  not-yet-resolved `null` region, so the catalog is never fetched for that visit.
- **#166 (enhancement).** A region can carry up to ~72 provider chips; the card
  is very long. The user wants to **collapse** the "My Providers" section.

Intended outcome: on every Settings entry the provider catalog loads without a
region switch (footer reads e.g. "5 of 72 selected", never "5 of 0"), and the
"My Providers" card is **collapsed by default** with a tappable disclosure header,
so the long chip grid is out of the way but the selected count stays glanceable.

## Scope

In:

- **#165:** trigger the provider-catalog load once the region resolves (chain it
  at the end of `SettingsService.load()`'s success branch) and drop the racy
  eager `loadProviderCatalog()` call from `SettingsPage.ngOnInit()`.
- **#166:** make the "My Providers" `.settings-card` collapsible — an in-memory
  `providersExpanded` signal (default `false` = **collapsed**), a `toggleProviders()`
  handler, the card header turned into a tappable disclosure `<button>` with a
  rotating chevron, the chip grid gated on `providersExpanded()`, and the summary
  footer visible in **both** states (once the catalog has loaded).
- Component + unit tests for both, and the slice `README.md`.

Out of scope (explicitly unchanged):

- Provider **selection / prune** logic (spec 0060 `toggleProvider` / `setRegion`
  prune) and the Plex chip **toggle** behaviour (spec 0061 `toggleHasPlex`).
- The separate **"Plex Server" card** (spec 0073) below "My Providers" — it is
  **not** wrapped by the collapse and is untouched. (Note: the collapse wraps the
  TMDB grid **and the in-grid Plex chip** inside `.provider-grid`, so collapsing
  hides that Plex _chip_ too; the dedicated Plex Server card is separate and stays
  visible.)
- Region logic, the notification rows, the sync-status card.
- **Persistence** of the collapse preference — the collapse is **ephemeral**
  (in-memory, resets to collapsed on each visit). No localStorage / Capacitor
  Preferences / Firestore.
- **Lazy-deferring** the catalog fetch until expand — the footer count needs
  `M` = catalog length, so the catalog must load regardless of collapse state.
  The catalog loads on entry; only the _grid rendering_ is gated by expand.

## Affected slices & Sheriff tags

Everything is in **one** slice — no cross-slice import, no shared-code extraction.

| Path                                                    | Scope / slice                    | Change                                                                                                    |
| ------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `libs/mobile/settings/src/lib/settings.service.ts`      | `scope:mobile`, `slice:settings` | #165: chain `loadProviderCatalog()` at end of `load()` success branch                                     |
| `libs/mobile/settings/src/lib/settings.page.ts`         | `scope:mobile`, `slice:settings` | #165: drop eager `ngOnInit` catalog call; #166: `providersExpanded` + toggle + icon                       |
| `libs/mobile/settings/src/lib/settings.page.html`       | `scope:mobile`, `slice:settings` | #166: disclosure header + `aria-expanded` (no `aria-controls`); gate grid; single-line footer both states |
| `libs/mobile/settings/src/lib/settings.page.scss`       | `scope:mobile`, `slice:settings` | #166: chevron rotation + disclosure header hover/focus/press states                                       |
| `libs/mobile/settings/src/lib/settings.service.spec.ts` | `scope:mobile`, `slice:settings` | #165 regression unit test                                                                                 |
| `libs/mobile/settings/src/lib/settings.page.spec.ts`    | `scope:mobile`, `slice:settings` | #166 component tests + reconcile the existing "calls loadProviderCatalog() on init" test                  |
| `libs/mobile/settings/README.md`                        | `scope:mobile`, `slice:settings` | document the load-on-entry behaviour + the collapse UI                                                    |
| `apps/mobile-e2e/src/provider-preferences.spec.ts`      | `scope:mobile`                   | N2 courtesy edit: skipped `test.fixme` body expands the card before chip click (inert; not a gate)        |

No new import edges: the `providersExpanded` signal reuses `@angular/core`
`signal` (already imported by the page); the chevron uses an existing `ionicons`
glyph via `addIcons` (already wired). This **replicates** the title-detail
season-collapse idiom in-slice — it does **not** import `slice:title-detail`
(the "extract at 3+ slices" rule is not met and would break vertical slice).

## Data model touchpoints

**None.** No Firestore collection or field is read/written differently, no new
field, no converter change. The collapse state is in-memory only. Consequently:

- **No `firestore.rules` change** and **no rules-tests** — no new read/write path.
- **No `firestore.indexes.json` change** — no new query.
- **No `shared/firestore-schema` / `shared/domain` change.**

(#165 changes _when_ the existing `getWatchProviders` callable is invoked — via
the `scope:shared` `GET_WATCH_PROVIDERS` thunk the shell provides — not _what_ is
persisted. `myProviderIds` / `hasPlex` reads and writes are unchanged.)

## Public types / APIs

**No new or changed public/exported types, function signatures, or barrel
exports.** `SettingsService` and `SettingsPage` are not barrel-exported (internal
data-access + page), so there is no repo-wide ripple.

- **F2 ripple check: empty.** No `shared/domain` type is added, widened, or made
  required; `nx affected -t test` scope is confined to `libs/mobile/settings`.

One **internal behaviour change** to call out (not a signature change):

- `SettingsService.load()` — at the **end of its success branch** (after
  `_region.set(user.region)` and `_loaded.set(true)`), it now kicks
  `void this.loadProviderCatalog()`. Both `load()` entry points funnel through
  this branch: the `ngOnInit` fast path and the constructor `effect` slow path
  (late anonymous-auth uid), so the catalog loads on both.
- `SettingsService.loadProviderCatalog()` — **guard made concurrency-safe
  (in-flight guard).** Today (`settings.service.ts:266,274`) the
  `loadedCatalogRegion` guard is set **only after** the
  `await getWatchProviders(region)` resolves, so a second same-region caller that
  enters before that resolution double-fetches. Because `load()` now chains an
  **un-awaited** `void this.loadProviderCatalog()`, a later explicit /
  `setRegion()` call for the same region could race that in-flight fetch. **Fix:
  claim the region synchronously _before_ the await** — set
  `this.loadedCatalogRegion = region;` up front (immediately after the
  `region === null` / already-loaded early-returns and before
  `this._catalogLoading.set(true)`), so any second same-region caller short-circuits
  on the already-claimed guard while the first fetch is in flight. **Reset the
  guard on failure** so a failed catalog fetch stays retryable: in a `catch`,
  restore `this.loadedCatalogRegion = null` (and re-throw so `setRegion` still
  skips its prune), keeping the existing `finally { this._catalogLoading.set(false); }`.
  This makes the "does not double-fetch" guarantee **true** (single fetch per
  region across the `load()`-chained call and any later explicit/`setRegion` call)
  and preserves today's retry-after-failure behaviour. (An in-flight `Promise`
  coalescing approach — cache the in-flight promise per region and await it — is an
  accepted alternative, but the synchronous-guard above is the **prescribed** one;
  implement that unless there is a concrete reason not to.) The `setRegion()`
  behaviour (region write → catalog load → prune) is otherwise unchanged.
- `SettingsPage.ngOnInit()` — the eager `void this.service.loadProviderCatalog();`
  line is **removed** (now redundant and racy). It still calls
  `void this.service.load();` and `void this.plexLink.loadState();`.
- `SettingsPage` gains an **internal** `providersExpanded = signal(false)` field
  and a `toggleProviders(): void` method (both `protected`, template-facing only).

## UI / Stitch screen refs

Stitch project `projects/13590348714018893783`. Two screens define the contract;
both were fetched (raw `htmlCode.downloadUrl` GET + screenshot) this session per
the CLAUDE.md recipe:

- **Collapsed (default) — screen `7daf6b0bf7d44447bae3217b36dbcb49`**
  ("Settings - Collapsible Providers Variant 1"). Verified markup + screenshot.
- **Expanded — screen `cebdfd02c7d44023b0e0019dd4907d48`**
  ("Settings - My Providers - Vultus"), the existing full chip grid.

Tokens are the repo's `--vultus-*` / `--ion-*` vars wired into `shared/ui-kit`
`theme.scss` (authoritative token set: `docs/design/vultus-design-system.md`) —
**no hard-coded hex** (the Tailwind class names in the fetched markup are how those
vars read in Stitch). Inter is already loaded app-wide (spec 0010) — no new font.
The app is Ionic/Angular using **ionicons**, so map Stitch's Material glyph
`expand_more` to an ionicon.

This is the same `.settings-card` the app already renders (spec 0060/0061) — the
only structural change is turning the static header into a disclosure control and
gating the grid. Pin these:

### Card & header (disclosure control)

- **Card:** unchanged — `.settings-card` (`--vultus-surface-container` fill,
  `--vultus-radius-md`, 1px `--vultus-outline-variant` @20% border). Do **not**
  add `overflow: hidden` in a way that clips the focus ring.
- **Header** is the existing `.settings-row.settings-row--header` (icon tile +
  title + subtitle). It becomes a **tappable disclosure `<button>`** spanning the
  full header width:
  - Left: the existing **40×40** `.settings-row__icon` tile (`--vultus-radius`,
    `surface-container-highest` @50%) with the repo's existing **`albums-outline`**
    glyph in `--ion-color-primary` — **keep the repo icon** (Stitch shows
    `subscriptions`; do not swap it).
  - Body: `.settings-row__title` "My Providers" (**type role: `body-lg` / 600**,
    `--vultus-on-surface`) over `.settings-row__helper--tight` "Subscriptions used
    to check availability" (**`body-md` / 400**, `--vultus-on-surface-variant`).
  - Right (trailing): a **chevron** `ion-icon`. Stitch uses Material `expand_more`
    in `text-on-surface-variant`. **Map to ionicons `chevron-down-outline`**
    (the glyph the title-detail season header already uses), colour
    `--vultus-on-surface-variant`, `font-size: 22px` to match the sibling
    `.settings-row` / `.plex-connect-row` trailing chevrons.
- The button carries **no default browser chrome**: `background: transparent`,
  `border: 0`, full width, `text-align: left`, `cursor: pointer`. Header layout
  (`.settings-row` flex, 16px icon↔body gap, `align-items: center`) is preserved.

### Chevron rotation (animation)

- Replicate the title-detail season chevron idiom: base chevron points **down**
  (collapsed); a `.expanded` class applies `transform: rotate(180deg)` to point
  **up** when expanded, with `transition: transform 200ms ease`. Bind
  `[class.expanded]="providersExpanded()"`.

### Grid gating (collapsed vs expanded)

- Collapsed: the `.provider-grid` (TMDB chips **and** the in-grid Plex chip) is
  **not rendered** — gate with `@if (providersExpanded()) { … }`. Do **not** merely
  `sr-only` / `display:none` it (Stitch used `sr-only`; in Angular gate it out).
- Expanded: the existing grid renders unchanged (`.provider-chip` footprint —
  96px wide, 48×48 logo tile, selected = 2px primary border + `checkmark-circle`
  badge + full opacity; unselected = 1px outline-variant @20% + 60% opacity; the
  Plex chip's "Manual" caption). No chip-level change.
- The `catalogLoading()` spinner branch (`.providers-loading`, "Loading
  providers…") is preserved and takes precedence: while loading, show the spinner;
  the grid gate applies only in the `@else` (loaded) branch.

### Summary footer (always visible once loaded)

- The `.provider-footer` — exact text
  `{{ myProviderIds().length }} of {{ providerCatalog().length }} selected · Region: {{ region() }}`
  — renders in **both** collapsed and expanded states, gated only by
  `!catalogLoading()` (so it never shows a stale "of 0" while the catalog is still
  fetching; the spinner shows instead). Concretely: the footer sits **outside**
  the `@if (providersExpanded())` grid gate but **inside** the `@else`
  (not-loading) branch.
- **Collapse the footer `<p>` onto one line (B3).** The current template
  (`settings.page.html:158-162`) splits the three interpolations across four
  indented lines, so the rendered `textContent` carries interior newlines/spaces
  (`"\n          1 of 3 selected · Region: NL\n        "`). T2 must rewrite the
  `<p class="provider-footer">…</p>` so its interpolations sit on a **single line
  with no interior template whitespace**, i.e. the rendered `textContent` is
  exactly `1 of 3 selected · Region: NL` (modulo the element's own
  leading/trailing template whitespace, which a single `.trim()` sheds). This is
  what lets the F3 exact-string assertion pass; **no `\s+`→space normalization**
  (that would mask a stray double-space between tokens). Type role: `label-sm`
  (`--vultus-text-label-sm-*`),
  `--vultus-on-surface-variant`; spacing agrees with the loaded card (`var(--vultus-space-md)`
  top margin, aligned to the card's content left edge — the existing
  `.provider-footer` rule).

### a11y

- Header `<button>` has `type="button"` and
  `[attr.aria-expanded]="providersExpanded()"` (`"true"`/`"false"`). The chevron
  `ion-icon` is `aria-hidden="true"`. **No `aria-controls`** (and no
  `id="my-providers-grid"` on the grid): because the grid is gated out of the DOM
  with `@if (providersExpanded())`, an `aria-controls` on the header would
  reference a non-existent element while collapsed. This matches the in-slice
  idiom this spec replicates — the title-detail season header uses
  `aria-expanded` only, no `aria-controls` (`title-detail.page.html:318-323`).

### Interactive-state contract (tick each)

- **default (collapsed):** chevron points down; grid absent; footer visible;
  `aria-expanded="false"`.
- **hover:** header background tints to `surface-variant`/highest @~30%
  (`color-mix(in srgb, var(--vultus-surface-container-highest) 30%, transparent)`,
  matching `.plex-connect-row:hover`); chevron may nudge — keep consistent with
  the sibling nav rows; `transition: background-color 150ms ease-in-out`.
- **focus-visible:** 2px `--ion-color-primary` outline (matches `.provider-chip`
  and `.plex-connect-row` focus rings); use `outline-offset: -2px` so the ring
  hugs the card edge like `.plex-connect-row`.
- **active/press:** subtle primary-tint press feedback consistent with
  `.settings-card:active` / `.plex-connect-row:active`
  (`color-mix(in srgb, var(--ion-color-primary) 5%, var(--vultus-surface-container))`).
- **expanded:** chevron rotated 180° (`.expanded`); grid visible; footer visible;
  `aria-expanded="true"`.

**Verification note:** `mobile:serve-mock` is the correct surface to eyeball the
#166 collapse (the mock pre-seeds a loaded catalog + region, so the card renders;
toggling the header exercises the collapse). It is **not** a valid surface for
#165 (see Test plan / Risks).

## Implementation task graph

Single slice; T1 and T2 both touch `settings.page.ts` (and their tests overlap the
same page/service files), so they are **sequential** — no parallel file-manifest
split. Both tasks → `frontend-engineer`.

- **T1 [sequential] — #165 load-on-entry fix.**
  - `settings.service.ts`: at the end of `load()`'s success branch (after
    `_loaded.set(true)`), add `void this.loadProviderCatalog();`.
  - `settings.service.ts`: make `loadProviderCatalog()`'s guard **concurrency-safe**
    (B1) — claim the region synchronously **before** the
    `await getWatchProviders(region)` (`this.loadedCatalogRegion = region;` up
    front) so a same-region caller entering while the first fetch is in flight
    short-circuits and does **not** double-fetch; **reset the guard to `null` in a
    `catch`** (and re-throw) so a failed fetch stays retryable, keeping the
    existing `finally { catalogLoading.set(false) }`. Without this, the un-awaited
    `load()`-chained call races the post-await guard and the "no double-fetch"
    claim is false.
  - `settings.page.ts`: remove the eager `void this.service.loadProviderCatalog();`
    line from `ngOnInit()`.
  - `settings.service.spec.ts`: add the #165 regression test (below). **With the
    synchronous in-flight guard, the existing
    `loadProviderCatalog calls the thunk once per region and populates the signal`
    test (`settings.service.spec.ts:697-721`) stays green unchanged** — the
    `load()`-chained call claims `'NL'` synchronously, so the two explicit
    `await service.loadProviderCatalog()` calls no-op and
    `getWatchProvidersMock` is still called exactly once; **verify it still asserts
    a single thunk call.** (If the implementer instead keeps the post-await guard,
    they MUST update that test to drain microtasks after `await service.load()` so
    the chained call settles first — but the synchronous-guard approach is
    preferred precisely because it needs no test change.)
  - **File manifest:** `libs/mobile/settings/src/lib/settings.service.ts`
    (both the `load()` chain **and** the `loadProviderCatalog()` guard-timing
    change), `libs/mobile/settings/src/lib/settings.page.ts`,
    `libs/mobile/settings/src/lib/settings.service.spec.ts` (new #165 test; the
    existing `once per region` test is verified green unchanged).

- **T2 [sequential, after T1] — #166 collapsible card.**
  - `settings.page.ts`: add `protected readonly providersExpanded = signal(false);`
    and `protected toggleProviders(): void { this.providersExpanded.update(v => !v); }`;
    register the chevron glyph (`chevronDownOutline`) in the `addIcons({ … })` call.
  - `settings.page.html`: convert the My Providers `.settings-row--header` to a
    disclosure `<button>` (`(click)="toggleProviders()"`,
    `[attr.aria-expanded]`); add the trailing chevron
    `ion-icon` with `[class.expanded]="providersExpanded()"`; wrap `.provider-grid`
    in `@if (providersExpanded()) { … }`; keep `.provider-footer` in the loaded
    (`@else` of `catalogLoading()`) branch but **outside** the expanded gate.
    **Collapse the `.provider-footer` `<p>` and its interpolations onto a single
    line with no interior template whitespace** (B3) so its rendered `textContent`
    is exactly `… of … selected · Region: …` (today it splits across four indented
    lines at `settings.page.html:158-162`) — required for the F3 exact-string
    assertion.
  - `settings.page.scss`: chevron `transition: transform 200ms ease` + `.expanded`
    → `rotate(180deg)`; disclosure-header (`button.settings-row--header`)
    transparent/border-0 reset + hover/focus-visible/active states per the UI
    contract.
  - `settings.page.spec.ts`: add the #166 component tests and reconcile the
    existing init test (below).
  - `libs/mobile/settings/README.md`: document the load-on-entry catalog trigger
    (Behaviour section) and the collapsible "My Providers" card + its ephemeral,
    collapsed-by-default state.
  - `apps/mobile-e2e/src/provider-preferences.spec.ts`: **courtesy edit only** (N2)
    — update the skipped `test.fixme` body (`:139`) to expand the "My Providers"
    card (tap the disclosure header) before clicking a `.provider-chip`, since the
    grid is now collapsed by default. Inert (still `fixme`-skipped); **not** a DoD
    gate.
  - **File manifest:** `libs/mobile/settings/src/lib/settings.page.ts`,
    `libs/mobile/settings/src/lib/settings.page.html`,
    `libs/mobile/settings/src/lib/settings.page.scss`,
    `libs/mobile/settings/src/lib/settings.page.spec.ts`,
    `libs/mobile/settings/README.md`,
    `apps/mobile-e2e/src/provider-preferences.spec.ts`.

## Test plan

Per the PLAN §5 pyramid. Unit (Vitest) on the real `SettingsService`; component
(Vitest + Analog TestBed) on `SettingsPage`.

### Unit — `settings.service.spec.ts` (#165 regression guard)

- **New test:** with a resolved uid and a user doc carrying a `region` (e.g.
  `'NL'`) + a non-empty `myProviderIds`, after `await service.load()` resolves:
  - `getWatchProvidersMock` was called **exactly once** and with the loaded region
    (`'NL'`), **without any `setRegion` call**;
  - `service.providerCatalog()` is populated (equals the thunk's resolved catalog);
  - `service.catalogLoading()` is `false`.

  This directly encodes "entering Settings loads the catalog without a region
  switch" and fails against the current code (where the catalog only loads on a
  region change). `load()` awaits `getDoc` and then kicks
  `loadProviderCatalog()` (not awaited inside `load()`), so the test must drain
  microtasks after `await service.load()` (e.g. two `await Promise.resolve()`, as
  the existing `flushEffectsAndMicrotasks` helper does) before asserting the thunk
  ran.

- **Existing service tests stay green (reconciliation).** With the synchronous
  in-flight guard (B1), the existing
  `loadProviderCatalog calls the thunk once per region and populates the signal`
  test (`settings.service.spec.ts:697-721`) stays green **unchanged**: after
  `await service.load()` the chained call has already claimed `'NL'` synchronously,
  so the two subsequent explicit `await service.loadProviderCatalog()` calls
  no-op and `expect(getWatchProvidersMock).toHaveBeenCalledTimes(1)` still holds.
  T1 must **verify this test still asserts a single thunk call** rather than
  editing it. (Only if the implementer keeps the post-await guard would that test
  need a microtask-drain after `await service.load()`; the prescribed guard needs
  no change.) The existing `loadProviderCatalog no-ops when no region resolved yet`
  test also stays green — it proves the pre-region guard still holds.

### Component — `settings.page.spec.ts` (#166)

- **Default collapsed:** after `setup(true)` (catalog + region seeded, not
  loading), assert the `.provider-grid` is **absent** (`el.querySelector('.provider-grid')`
  is falsy) and the disclosure header (the My Providers `button.settings-row--header`)
  has `aria-expanded="false"`. Assert the footer text renders **exactly**
  `1 of 3 selected · Region: NL` (see F3 below).
- **Toggle expands:** click the disclosure header, `fixture.detectChanges()`,
  then assert `.provider-grid` is **present**, the header `aria-expanded="true"`,
  and the chevron `ion-icon` has the `expanded` class
  (`classList.contains('expanded')`).
- **Footer visible in both states:** assert `.provider-footer` exists both before
  and after the toggle (it is gated only by `!catalogLoading()`, not by expand).
- **Reconcile the existing test** `it('calls loadProviderCatalog() on init')`
  (currently ~line 297): T1 removes the eager `ngOnInit` catalog call, so the page
  no longer calls `service.loadProviderCatalog()` directly (the component test
  mocks the service, so the service-side chain does not run here). **Delete this
  test** (the page's remaining init responsibility — `load()` — is already
  covered by `it('calls load() on init')`, and the real catalog-on-load trigger is
  now covered by the #165 **unit** test on `SettingsService`). Called out here so
  the reviewer/implementer expect this removal rather than a broken expectation.
  The `it('calls load() on init')` and `it('loads the Plex link state on init')`
  tests remain unchanged.

### F3 — exact-string assertions

- **Rendered text:** assert the footer's rendered text with the **exact string**
  `1 of 3 selected · Region: NL`. For this to pass, T2 must first **collapse the
  `.provider-footer` `<p>` and its interpolations onto a single line with no
  interior template whitespace** (see UI section) so the rendered `textContent` is
  exactly that string. A single `.trim()` to shed the element's own
  leading/trailing template whitespace is acceptable; **no interior
  `.replace(/\s+/g, ' ')` normalization** — that masks a stray double-space between
  tokens and is exactly what F3 forbids. The existing footer test at ~line 336
  currently uses `.replace(/\s+/g, ' ').trim()` before asserting; **update that
  assertion (and any new footer assertion) to compare the exact rendered string
  with at most a single `.trim()`.** Collapse state itself is asserted structurally
  (grid presence/absence, `aria-expanded`, chevron class), not via text.

### e2e

- **No new e2e flow.** Neither issue adds or substantially changes a primary
  navigation route or a critical action — #165 is a load-timing fix on an existing
  page, #166 is an in-card presentation toggle with ephemeral state. No named
  Playwright flow is added, un-skipped, or `fixme`-gated. (Recorded so no DoD
  checkbox orphans an e2e task.)
- **Deferred fixme housekeeping (inert; not a DoD gate).** The existing skipped
  `test.fixme('toggling a provider chip in Settings flips the watchlist pill')`
  (`apps/mobile-e2e/src/provider-preferences.spec.ts:139`) clicks a Settings
  `.provider-chip` directly. After #166 the "My Providers" grid is **collapsed by
  default**, so that chip is not in the DOM until the disclosure header is tapped.
  T2 should update **that fixme's body** to first expand the "My Providers" card
  (tap the disclosure header) before interacting with a provider chip, so whoever
  un-skips it later isn't surprised. This is inert today (the test is `fixme`-skipped
  and cannot run until the Functions emulator gap is closed) — it is **not** a DoD
  gate, just a courtesy edit within T2's scope.

## Definition of done

Tailored PLAN §5 checklist — every item maps to a task in the graph above:

- [ ] **Typecheck** green (`nx affected -t typecheck --base=main`). — T1/T2
- [ ] **Lint + Sheriff** green (`nx affected -t lint`); no new cross-slice import
      edge (the collapse idiom is replicated in-slice, not imported from
      `slice:title-detail`). — T1/T2
- [ ] **Unit** — `settings.service.spec.ts` includes the #165 regression guard and
      passes; the existing
      `loadProviderCatalog calls the thunk once per region` test (`:697-721`) is
      **verified green unchanged** under the synchronous in-flight guard (B1), and
      all other service tests stay green. — T1
- [ ] **Component** — `settings.page.spec.ts` covers #166 (default collapsed,
      toggle expands, footer visible both states) with the exact-string footer
      assertion; the obsolete `calls loadProviderCatalog() on init` test is
      removed; all other page tests stay green. — T2
- [ ] **Build** green (`nx build mobile`). — T1/T2
- [ ] **e2e** — none affected/added (see Test plan). No e2e task.
- [ ] **Slice README** updated: `libs/mobile/settings/README.md` documents the
      load-on-entry catalog trigger and the collapsible, collapsed-by-default,
      ephemeral "My Providers" card. — T2
- [ ] **UI fidelity** — #166 collapse eyeballed on `mobile:serve-mock` against the
      collapsed/expanded Stitch screens (or explicitly flagged unverified for a
      human); all interactive states (default/hover/focus/active/expanded) present.
      — T2
- [ ] **No data-model change** — no `firestore.rules`, `firestore.indexes.json`,
      rules-tests, `shared/domain`, or `shared/firestore-schema` change (F1
      orphan check: none of these are in the DoD, so none are orphaned).

## Risks

- **#165 cannot be reproduced or verified on `mobile:serve-mock`.** The mock
  (`settings.providers.mock.ts` `MockSettingsServiceImpl`) pre-seeds `region = 'NL'`,
  a full `providerCatalog`, and `loaded = true`, so the null-region race never
  occurs there. The #165 fix is proven **only** by the unit test on the real
  `SettingsService` (catalog loads after `load()` resolves, no `setRegion` call).
  Do **not** claim serve-mock verifies #165; serve-mock verifies #166 only.
- **Effect-based alternative to the #165 fix (rejected; documented so the
  implementer doesn't reintroduce it).** A service `effect` on `_region` that calls
  `loadProviderCatalog()` when non-null mirrors the existing constructor effect but
  adds a second trigger that can fire alongside `setRegion()`'s explicit call on a
  region change. With the B1 synchronous in-flight guard the double-fetch is now
  prevented regardless of trigger count, but the effect still adds an extra,
  harder-to-reason-about trigger for no benefit over the single `load()`-chained
  call recommended here. If the implementer nonetheless chooses the effect, the B1
  guard (claim-before-await, reset-on-failure) remains **mandatory** — it is what
  makes any additional trigger safe.
- **Collapse hides the in-grid Plex chip.** Because the spec-0061 Plex chip lives
  inside `.provider-grid`, collapsing the card hides that chip too. This is
  accepted (decision): the dedicated spec-0073 "Plex Server" card below remains
  visible, so Plex connection/sync stays reachable while "My Providers" is
  collapsed.
