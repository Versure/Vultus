---
number: 0017
slug: settings-design-alignment
title: Align settings page visual design to Stitch
status: approved
slices: [slice:settings]
scopes: [scope:mobile]
created: 2026-06-23
---

# Align settings page visual design to Stitch

## Context

Spec 0011 (PLAN §6 item 16) delivered the **functional** settings slice: a region
picker, a global notifications toggle, eager `users/{uid}` initialisation, and a
`SettingsService` that reads/creates/updates the user document via the shared
converters. That spec's UI section was explicitly minimal — it placed a stock
`IonList` with an `IonSelect` and an `IonToggle` and relied on the spec-0010
theme tokens, without pulling and matching the actual **Stitch Settings screen**.
The result works but does **not** match the Vultus visual design (GitHub issue
[#35](https://github.com/Versure/Vultus/issues/35)).

This spec is a **UI-fidelity-only** follow-up. It brings `libs/mobile/settings`
into full visual alignment with the Stitch Settings screen: layout, section
grouping, typography roles, color/surface usage, spacing, control shapes, and
every interactive state. **No business logic changes** — `SettingsService`, its
signals, its Firestore reads/writes, and the region/notifications semantics from
spec 0011 are untouched. The only files that change are the page **template**,
the page **SCSS**, the **component test** (only if restructuring changes the
selectors it queries), and the lib **README** (if its public-surface description
shifts).

Intended outcome: with the app served under `--configuration=mock` (or rendered
with a mocked `SettingsService`), the Settings tab visually matches the Stitch
Settings screen — verified by a screenshot compare against the screen's exported
`screenshot.downloadUrl` — while behaving exactly as spec 0011 specified.

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **UI fidelity only.** Spec 0011's logic stays as-is. Only the visual
   presentation (template, SCSS, and the choice of which Ionic components render
   the form) changes to match Stitch.
2. **Broad visual overhaul.** The entire page is re-aligned — layout, typography,
   colors, spacing, and component shapes all match the Stitch Settings screen.
   This is not a one-control tweak.
3. **Acceptance bar = screenshot matches Stitch.** The implementer **must** fetch
   the Stitch Settings screen, serve/render the app, take a screenshot, and do a
   visual comparison against the Stitch `screenshot.downloadUrl`. This step is a
   hard gate in the Definition of done — a green typecheck/lint/test/build does
   **not** prove the UI is correct (CLAUDE.md).
4. **No functional changes.** `SettingsService` (`settings.service.ts`), its
   signals, its Firestore calls, the read-or-create defaults, the
   region-update / all-three-`notificationPrefs` write semantics, and the global
   notifications projection are **untouched**. Only `settings.page.html`,
   `settings.page.scss`, optionally `settings.page.ts` (template-binding wiring
   only — no new logic), `settings.page.spec.ts` (selectors only), and the README
   may change.
5. **Design source = Stitch + `docs/design/vultus-design-system.md`.** Pin the
   layout/structure to the **fetched raw Stitch HTML** (see UI section for the
   exact recipe and project ID); pin the **palette/typography/radius/spacing
   tokens** to `docs/design/vultus-design-system.md`, consumed via the
   `--vultus-*` / `--ion-*` vars that `libs/shared/ui-kit/src/lib/theme.scss`
   exposes. **Never hand-transcribe a hex** — primary is `#4edea3`, **not**
   `#10B981` (which is `primary-container`).
6. **No new shared surface.** No changes to `shared/domain`,
   `shared/firestore-schema`, or `shared/ui-kit`. If a genuinely missing token is
   discovered in `shared/ui-kit`/`theme.scss`, **flag it to the reviewer** as an
   open item — do **not** invent ad-hoc CSS custom properties or inline hex in the
   slice SCSS.
7. **Update the component test** (`settings.page.spec.ts`) **only if** the
   template restructuring changes the element selectors it queries
   (`ion-select`, `ion-toggle`, `ion-select-option`, `ion-spinner`). The
   behavioural assertions (calls `load()` on init, lists ten regions, persists on
   change, render-gates before `load()` resolves) must stay green; do not weaken
   them.

## Scope

In scope:

- Rewrite `libs/mobile/settings/src/lib/settings.page.html` to match the Stitch
  Settings screen's structure (header, section grouping, label/control layout,
  helper/descriptive text placement, any avatar/account block the screen shows).
- Rewrite/extend `libs/mobile/settings/src/lib/settings.page.scss` to pin the
  screen's spacing, surface usage, radii, and typography roles — consuming the
  `--vultus-*` / `--ion-*` theme vars only (no hard-coded hex).
- Adjust `settings.page.ts` **template-binding wiring only** if the new structure
  needs different `imports` (e.g. additional Ionic components) or event bindings —
  **no new methods, no new state, no service-shape changes**.
- Keep the **render-gate** (spinner / `@if (service.loaded())`) behaviour from
  spec 0011; restyle it to match the screen if the screen depicts a loading state.
- Update `settings.page.spec.ts` selectors only if the restructure renames/moves
  the queried elements (decision 7).
- Update `libs/mobile/settings/README.md` **only if** the public surface
  description changes (it should not — this is UI-only).
- The **visual verification** step (fetch Stitch screen → serve/render →
  screenshot → compare), recorded in the PR.

Out of scope (do **not** touch):

- **`SettingsService` and all business logic** (decision 4) — region list,
  read-or-create, write semantics, signals, the notifications projection.
- **`shared/domain`, `shared/firestore-schema`, `shared/ui-kit`** (decision 6) —
  no new types, converters, tokens, or theme changes (flag a missing token, don't
  add one).
- **`sheriff.config.ts`, `firestore.rules`, `firestore.indexes.json`,
  `apps/mobile` shell, routing** — none change.
- **New functional features** (per-type notification toggles, account/logout,
  theme switcher, etc.) — even if the Stitch screen depicts controls beyond the
  region picker + notifications toggle, do **not** wire new behaviour. Render
  only the spec-0011 controls; if the screen shows additional control rows,
  see the UI section's reconciliation note (render them as **non-functional
  visual placeholders only if the screen's layout depends on them**, and flag
  each as a deferred feature — preferred is to omit purely-decorative extras and
  match the screen's *styling* of the two real controls).
- **Emulator-backed e2e** — descoped (consistent with spec 0011 decision 5 and
  project memory: the emulator can't run under Claude Code tools here). No
  `ci.yml` / `playwright.config.ts` change.

## Affected slices & Sheriff tags

| Project         | Path                   | Sheriff tags                     | Change                                                                 |
| --------------- | ---------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| mobile-settings | `libs/mobile/settings` | `scope:mobile`, `slice:settings` | rewrite page template + SCSS for visual fidelity; test selectors; README if surface shifts |

- **Single slice, single scope.** No new project, no new dependency edge. The
  slice already imports `@vultus/shared/domain` and
  `@vultus/shared/firestore-schema` (both `scope:shared`) and Ionic/AngularFire
  (third-party, not policed by Sheriff). This spec adds **no new import** outside
  those, and adds **no cross-slice import** (no `slice:search` / `slice:watchlist`
  / `slice:title-detail`).
- **No `shared/` extraction.** This is pure slice-local presentation; the 3+-slice
  extraction rule (CLAUDE.md / PLAN §3) does not apply. Theme tokens are consumed
  from the already-existing `shared/ui-kit` — not duplicated.
- **`sheriff.config.ts` is NOT edited** — the existing path-glob tags already
  cover `libs/mobile/settings`.
- **No `scope:functions` file is touched.**

## Data model touchpoints

**None.** This spec changes presentation only. `SettingsService` continues to
read/create/update `users/{uid}` exactly as spec 0011 / PLAN §4 define
(`region: Region`, `notificationPrefs: { episodeAired, movieAvailable,
cameToPlatform }`, `fcmTokens: []`) via the shared `userPath` / `userToData` /
`dataToUser` converters. **No collection, field, converter, or security rule is
added or changed.** `firestore.rules` and `firestore.indexes.json` are **not**
modified.

## Public types / APIs

**No new or changed public types or APIs.** `SettingsService`'s surface
(`regions`, `region`, `notificationsEnabled`, `loaded`, `load`, `setRegion`,
`setNotificationsEnabled`) is unchanged. `SettingsPage` stays exported from
`libs/mobile/settings/src/index.ts`. If `settings.page.ts` gains additional Ionic
component `imports` for the new layout, that is an internal component-metadata
change, not a public-API change. The slice barrel export set does **not** change.

## UI / Stitch screen refs

This is a mobile slice and the **whole point** of this spec is UI fidelity, so the
Stitch Settings screen is the binding visual contract. The authoritative **tokens**
(palette, type scale, radius, spacing) live at
`docs/design/vultus-design-system.md` and are wired into
`libs/shared/ui-kit/src/lib/theme.scss` as `--vultus-*` / `--ion-*` CSS variables —
**consume those vars; do not reprint or hand-transcribe hex** (primary is
`#4edea3`; `#10B981` is `primary-container`).

### BLOCKING OPEN ITEM — Stitch Settings screen NOT captured

The spec-author could **not** reach the `stitch` MCP in its session, so the
Settings screen's **screen ID, raw HTML, and screenshot were NOT captured** and
the concrete per-element values below are pinned from the **design-system tokens
only**, not from the screen markup. Per CLAUDE.md and project memory
(`stitch-mcp-reachable.md`), **the Stitch MCP is reachable from the implementer /
orchestrator context — a failed call there is a retry, not a reason to ship
token-only UI.** Therefore the implementer **MUST**, as the first task, capture
the screen and record its ID in the PR. This is a hard gate.

**Fetch recipe (exact):**

1. List screens in project **`projects/13590348714018893783`** ("Vultus Android
   App Design") via the `stitch` MCP (`list_screens`) and locate the **Settings**
   screen. **Retry on MCP failure** before concluding it is unreachable.
2. `get_screen` on that screen. It returns **metadata + download URLs, not
   rendered markup**. Record the **screen ID** (the
   `projects/13590348714018893783/screens/<id>` value) for the PR.
3. Fetch `htmlCode.downloadUrl` with a **plain HTTP GET** (PowerShell
   `Invoke-WebRequest`), **NOT** `WebFetch` (WebFetch summarises away the CSS).
   Read the embedded **Tailwind config** (`colors` / `fontSize` / `spacing` /
   `borderRadius`) and the **element markup** for the concrete structure and
   values.
4. Fetch `screenshot.downloadUrl` (plain GET) for the **visual compare** target.
5. If, after retries, the screen HTML genuinely cannot be read, treat the UI task
   as **blocked / `needs-human`** and report it — do **not** "fall back to tokens
   and proceed."

### Structure (from the screen — confirm/correct against the fetched markup)

Pin the page structure to what the **fetched Settings screen** actually draws. Do
**not** assume the current spec-0011 `IonList`/`IonListHeader`/`IonItem` markup
maps 1:1 to the screen — the screen may group settings into titled sections,
use a different label/control arrangement, show descriptive helper text, or an
account/header block. Match the screen's grouping and arrangement. **The only two
interactive controls that carry behaviour are the region picker and the
notifications toggle** (decision 4 / Out of scope) — render them with the screen's
styling; do not wire any extra controls the screen may depict.

### Token contract (authoritative — from `docs/design/vultus-design-system.md`)

Pin these via the theme vars; verify the fetched screen's Tailwind config matches
(if it diverges, the design-system tokens win — note any divergence in the PR):

- **Surfaces (tonal ramp, dark-first):** page background `surface` / `background`
  `#0b1326`; grouped section containers / cards step up the ramp —
  `surface-container-low #131b2e`, `surface-container #171f33`,
  `surface-container-high #222a3d`. Elevation = a step up the ramp, **not** a
  heavy shadow. Section/row dividers, if any, use `outline-variant #3c4a42` at 1px.
- **Text roles (type scale):** section/group titles = `headline-sm` (20/600) or
  `label-md` (12/600, +0.05em) per the screen's hierarchy; primary row labels
  (e.g. "Region", "Notifications") = `body-lg` (16/400); helper/description text
  (e.g. "Content availability is based on this region.") = `body-md` (14/400) in
  `on-surface-variant #bbcabf`. Pin each text element to a **named role** matching
  the screen — do not eyeball font sizes.
- **Accent:** the active toggle track / selected select value uses `primary`
  `#4edea3` (Ionic `--ion-color-primary`), on-color `on-primary #003824`.
- **Radius:** rows/cards/inputs `rounded.DEFAULT` 0.5rem (cards may use `md`
  0.75rem if the screen shows it); any pill/badge uses `full` 9999px.
- **Spacing (8px grid):** 16px (`md`) side margins (`margin-mobile`) and the gap
  between sections/cards; 8px (`sm`) for internal row spacing (label→helper).
  **Sibling rows must share the same horizontal inset** — the region row, the
  notifications row, and any helper text align to the same left edge. Pin the
  control/row **height** (do not say "taller") to the screen's value.
- **Font loading:** Inter must be **loaded as a web-font** (the Google Fonts link
  in `apps/mobile/src/index.html`, already present per the design-system note) —
  named-in-stack alone silently falls back to system-ui. Confirm Inter actually
  renders (the screenshot compare catches a fallback).

### Per-state acceptance contract (tick each off in review against the fetched screen + screenshot)

For **each** interactive element, verify all states:

- **Region picker (`ion-select`, or the screen's equivalent control):**
  - default: shows the current region value, `body-lg`, on `surface-container`
    fill, 0.5rem radius;
  - focus/open: the popover/sheet matches the screen (interface choice —
    `popover` today; match the screen); focus ring/border transitions to
    `primary #4edea3` if the screen shows a focus treatment;
  - active/pressed: subtle primary-tinted overlay (5% emerald) per the
    design-system "Interactions" note, not a physical lift;
  - disabled: not applicable (control is always enabled once loaded), but if the
    screen depicts a disabled style, pin it.
- **Notifications toggle (`ion-toggle`):**
  - off (default-when-not-all-prefs): track `surface-container-high #222a3d` /
    neutral, knob neutral;
  - on: track `primary #4edea3`, knob `on-primary`/white per the screen;
  - focus: focus ring per the screen if shown;
  - pressed: the standard Ionic toggle press transition (confirm it matches —
    don't introduce a custom animation the screen doesn't have);
  - disabled: n/a unless the screen shows it.
- **Section containers / rows:** default surface step per the ramp; pressed (if
  the row is tappable to open the select) uses the 5%-emerald overlay, not a lift.
- **Loading (render-gate):** before `service.loaded()` resolves, the form is not
  shown; the spinner/skeleton is centered and styled to the screen (or the
  existing centered `ion-spinner` if the screen shows no loading state). Match the
  screen's background while loading.
- **Transitions/animations:** any color/opacity transition (toggle, focus, press
  overlay) matches the screen's timing; if the screen shows none, do not add one.

If the screen depicts controls beyond the region picker + notifications toggle,
**do not wire them** (decision 4 / Out of scope) — match the *styling* of the two
real controls and flag the extras as deferred features in the PR.

## Implementation task graph

Single-slice, single-scope, presentation-only — a flat sequential chain (the
tasks all write within `libs/mobile/settings/**` and share the page composition,
so they are **not** parallelisable). No shared dep precedes them; task 1 is the
screen-capture gate.

1. **[sequential] Capture the Stitch Settings screen (the BLOCKING open item).**
   frontend-engineer.
   - Follow the UI-section fetch recipe against project
     `projects/13590348714018893783`: `list_screens` → find Settings →
     `get_screen` → **record the screen ID** → plain-GET `htmlCode.downloadUrl`
     (raw HTML + Tailwind config) → plain-GET `screenshot.downloadUrl`. **Retry on
     MCP failure.** If genuinely unreachable after retries, **stop and report
     `needs-human`** — do not proceed token-only.
   - Output: the screen ID (for the PR) and the concrete pinned values (structure,
     dimensions, spacing, type roles, states) reconciled against the design-system
     tokens.
   - Files: none written (capture/analysis step).

2. **[sequential] Rewrite the page template + SCSS to match the screen. Depends on
   task 1.** frontend-engineer.
   - Rewrite `settings.page.html` to the screen's structure (section grouping,
     label/control layout, helper text, render-gate), wiring **only** the existing
     `service.region()` / `service.regions` / `service.notificationsEnabled()` /
     `service.loaded()` bindings and the existing `onRegionChange` /
     `onNotificationsChange` handlers.
   - Rewrite/extend `settings.page.scss` to pin the screen's spacing, surface
     steps, radii, and type roles using only `--vultus-*` / `--ion-*` theme vars
     (no hard-coded hex; flag any missing token instead of inventing one).
   - Adjust `settings.page.ts` `imports` / template-binding only if the new
     structure needs additional Ionic components — **no new logic**.
   - Files: `libs/mobile/settings/src/lib/settings.page.html`,
     `libs/mobile/settings/src/lib/settings.page.scss`,
     `libs/mobile/settings/src/lib/settings.page.ts` (imports/bindings only),
     `libs/mobile/settings/README.md` (only if the public-surface description
     shifts — it should not).

3. **[sequential] Update the component test selectors + visually verify. Depends on
   task 2.** frontend-engineer / qa-runner.
   - Update `settings.page.spec.ts` **only** where the restructure renamed/moved a
     queried element; keep all behavioural assertions (init `load()`, ten region
     options, persist-on-change, render-gate) green. Do not weaken them.
   - **Visual verification (decision 3, hard gate):** serve the app under
     `--configuration=mock` (or render the page with the mocked `SettingsService`),
     take a screenshot, and compare it against the Stitch
     `screenshot.downloadUrl`. Record the result + the screen ID in the PR. If the
     mock serve target cannot run under the available tooling, render via the
     component test harness/screenshot or **explicitly flag the UI as unverified
     for a human eyeball** — never report fidelity done off a green build alone.
   - Files: `libs/mobile/settings/src/lib/settings.page.spec.ts`.

(All work lives under `libs/mobile/settings/**`. No `apps/mobile`,
`sheriff.config.ts`, `firestore.rules`, `firestore.indexes.json`, `shared/**`, or
`scope:functions` file is touched. No `[parallel]` tasks — hence no file
manifests to deduplicate.)

## Test plan

Presentation-only change, so the test surface is the existing **component** test
plus the **visual verification** gate; **no new unit logic** (the service is
untouched) and **no e2e** (descoped, consistent with spec 0011 decision 5).

**Component (`settings.page.spec.ts`, Angular TestBed + Ionic test setup,
`SettingsService` mocked — as today):**

- Existing assertions stay green (update **selectors only** if the restructure
  moved/renamed elements): calls `load()` on init; renders the region control and
  notifications toggle once loaded; lists the ten regions; changing the region
  calls `setRegion` with the chosen `Region`; toggling calls
  `setNotificationsEnabled` with the new boolean; render-gates (no form, shows the
  loading state) before `load()` resolves.
- If the restructure changes which element fires `setRegion` / the region option
  count rendering, adapt the query but keep the **behaviour** asserted.

**Unit:** none added — `settings.service.spec.ts` is unchanged (the service is not
touched). Confirm it still passes (the slice's existing unit suite must stay
green).

**Visual (the acceptance gate, decision 3):** serve `--configuration=mock` (or
render with the mocked service) → screenshot → compare to the Stitch Settings
`screenshot.downloadUrl`. This is **manual/agent visual verification**, recorded in
the PR, not an automated assertion.

**e2e:** none — descoped to PLAN §6 item 20 / the e2e-setup spec. No
`apps/mobile-e2e`, `playwright.config.ts`, or `ci.yml` change.

## Definition of done

Tailored from PLAN §5 / CLAUDE.md. Green gate is **lint + unit + component +
build** (what `ci.yml` runs), **plus the visual-fidelity gate** (decision 3) — a
green build alone does NOT close this spec.

- [ ] `pnpm nx run-many -t lint test -p mobile-settings` passes **with Sheriff
      active**: the slice still imports only `@vultus/shared/domain`,
      `@vultus/shared/firestore-schema`, and Ionic/AngularFire (third-party) — **no
      new cross-slice import, no `apps/mobile` deep import, no `scope:functions`
      import**. The component test (and the untouched service unit test) are green.
- [ ] `pnpm nx typecheck mobile-settings` passes — the restyled page and any added
      Ionic `imports` compile.
- [ ] `pnpm nx build mobile` passes (production configuration) — the restyled slice
      lazy-loads cleanly into the shell and stays within the existing bundle
      budgets.
- [ ] `pnpm nx affected -t lint test build --base=main` is green — mirrors CI. The
      affected set is `mobile-settings` and `mobile`.
- [ ] **Stitch Settings screen captured:** the PR records the **screen ID**
      (`projects/13590348714018893783/screens/<id>`), confirming the BLOCKING open
      item was resolved (the screen was fetched via the `stitch` MCP, raw HTML +
      screenshot pulled via plain GET). If the MCP was genuinely unreachable after
      retries, the UI task is `needs-human` and this box stays **unchecked** with an
      explicit note — it is **not** silently passed token-only.
- [ ] **Visual fidelity verified (decision 3, hard gate):** the page was served
      `--configuration=mock` (or rendered with the mocked `SettingsService`),
      screenshotted, and **compared against the Stitch `screenshot.downloadUrl`**;
      the per-state acceptance contract (region picker + notifications toggle
      default/focus/active/disabled, section surfaces, loading state,
      transitions) is ticked. If serve/render couldn't run under the tooling, the
      UI is **explicitly flagged unverified for a human eyeball** — never reported
      done off a green build alone.
- [ ] **No hard-coded hex / ad-hoc CSS var:** the SCSS consumes only `--vultus-*`
      / `--ion-*` theme vars; any genuinely missing token is **flagged to the
      reviewer**, not invented in the slice.
- [ ] **Logic-untouched guardrail (review-checked):** `settings.service.ts` is
      **byte-for-byte unchanged**; `settings.page.ts` gained **no new methods,
      state, or service-shape changes** (only `imports` / template bindings);
      no new functional control was wired (region picker + notifications toggle
      are the only behavioural controls); the read-or-create defaults and
      write semantics from spec 0011 are intact.
- [ ] **`shared/domain`, `shared/firestore-schema`, `shared/ui-kit`,
      `sheriff.config.ts`, `firestore.rules`, `firestore.indexes.json`,
      `apps/mobile`, `ci.yml`, `playwright.config.ts` are NOT modified.**
- [ ] `libs/mobile/settings/README.md` reflects reality — no stub/scaffold text;
      updated only if the public surface description shifted (it should not).
- [ ] **No secret read/written** — no `.env.local`, no new config; the slice uses
      the shell's already-initialised AngularFire.
- [ ] PR description records: the **Stitch screen ID**, the exact verification
      commands, the **visual compare** result (or the unverified-for-human flag),
      the **logic-untouched** confirmation (`settings.service.ts` unchanged, no new
      controls wired), the no-hard-coded-hex confirmation, and that **e2e is
      descoped** to PLAN §6 item 20.

## Risks

- **Stitch Settings screen NOT captured by the spec-author (BLOCKING until the
  implementer fetches it).** The `stitch` MCP was unavailable in the spec-author's
  session, so this spec pins **token-derived** values (palette, type scale,
  radius, spacing) authoritatively from `docs/design/vultus-design-system.md` but
  **could not pin the screen's structure** (section grouping, exact control
  arrangement, dimensions, any account/header block). Per project memory
  (`stitch-mcp-reachable.md`) the MCP **is** reachable from the implementer /
  orchestrator context, so this is a **retry-and-fetch** for the implementer, not a
  reason to ship token-only. Task 1 + the DoD make the fetch a hard gate; if it
  genuinely cannot be read after retries, the UI task is **`needs-human`**.

- **The screen may depict controls beyond the two real ones (region + toggle).**
  Stitch settings mocks often show account rows, theme switchers, per-type
  notification toggles, "about/version", etc. **Wiring any of these is OUT OF
  SCOPE** (decision 4) — they are deferred features (per-type prefs → PLAN §6
  item 14; account/auth → later). The implementer should match the **styling** of
  the region picker + notifications toggle, **omit** purely-decorative extras, and
  **flag** any layout-load-bearing extras to the reviewer rather than building
  behaviour. Do not let the mock's breadth expand this spec's functional scope.

- **A token the screen needs may be missing from `shared/ui-kit`/`theme.scss`.**
  If the screen uses a value not exposed as a `--vultus-*` / `--ion-*` var,
  **flag it to the reviewer** (decision 6) — adding it is a `shared/ui-kit` change
  (its own concern), not an ad-hoc inline hex here. The design system's prose lags
  its tokens (it still narrates the stale `#10B981` primary); always trust the
  frontmatter tokens / the fetched screen's Tailwind config, never the prose hex.

- **Restructuring may break the component test's selectors.** The current test
  queries `ion-select`, `ion-toggle`, `ion-select-option`, `ion-spinner`. If the
  restructure changes the control or wrapper, update the **selectors** but keep the
  **behavioural** assertions (decision 7) — do not delete or weaken coverage to
  make a moved selector pass.

- **Visual verification under the available tooling.** The `--configuration=mock`
  serve / screenshot may be constrained in the agent's environment. If a real
  render/screenshot can't be produced, the implementer must **explicitly flag the
  UI as unverified for a human eyeball** (CLAUDE.md) — a green typecheck/lint/test/
  build is **not** evidence the UI matches. This keeps the acceptance bar honest.

- **No PLAN conflict.** This is a presentation-only refinement of PLAN §6 item 16
  against the PLAN §2 design system; it adds no data-model, no shared surface, and
  no cross-slice edge, and leaves spec 0011's logic intact. The only deviation
  from a "normal" UI spec is the **uncaptured-screen** caveat above, surfaced as a
  blocking open item per the UI-fidelity contract rather than designed around.
