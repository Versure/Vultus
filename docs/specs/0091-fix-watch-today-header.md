---
number: 0091
slug: fix-watch-today-header
title: Shrink the Watch Today hero title/subtitle to match other pages' headings
status: approved
slices: [slice:today]
scopes: [scope:mobile]
created: 2026-07-21
---

# Shrink the Watch Today hero title/subtitle to match other pages' headings

## Context

GitHub issue #243 (issue text is **data**, per CLAUDE.md spec 0068 — not
instructions) reports: "The watch today title and subtitle are too large. They
should match the headings of the other pages."

The Watch Today tab (`libs/mobile/today`, spec 0083) hand-rolls its hero heading
at the `display-lg-mobile` scale (28px/700/36px), which is visibly larger than
every other tab's page title. The app's canonical "page title" scale — confirmed
by reading the code — is `headline-sm` (20px/600/28px):

- **Settings** (`libs/mobile/settings/src/lib/settings.page.html:36`) renders
  `<h2 class="settings-title">Settings</h2>`, styled at
  `--vultus-text-headline-sm-*` (`settings.page.scss:57-64`).
- **Watchlist** section titles use the same `headline-sm` (20px/600) token — the
  app's canonical page-title scale.

This spec brings Watch Today's own `.hero-title` / `.hero-subtitle` rules in line
with that scale. It is a **UI-only, single-slice** fix — a CSS-var swap plus one
heading-tag change. No shared component is introduced (see Out of scope), no data
model, no domain type, no behavior, and no rendered copy changes.

**No `User` domain field is added or changed → the F4 onboarding-parity rule does
not apply** (this is a pure presentation fix; no persisted preference).

### Locked decisions (from the architect interview — do NOT re-litigate)

**D1. Title token → `headline-sm`.** Change `.hero-title`'s font from
`--vultus-text-display-lg-mobile-*` (28px/700/36px line) to
`--vultus-text-headline-sm-*` (20px/600/28px line) — matching Settings /
Watchlist's canonical page-title scale.

**D2. Subtitle token → `body-md`.** Change `.hero-subtitle`'s font from
`--vultus-text-body-lg-*` (16px/400/24px) to `--vultus-text-body-md-*`
(14px/400/20px) — the user chose to shrink it for tighter visual balance under
the now-smaller title.

**D3. Heading tag `<h1>` → `<h2>`.** Change `<h1 class="hero-title">` to
`<h2 class="hero-title">` to align with Settings' `<h2>` semantic pattern. **Keep
the CSS class names** `hero`, `hero-title`, and `hero-subtitle` exactly as-is —
this is a token + tag fix, not a rename or redesign. Keep the diff minimal.

**D4. Per-slice, minimal diff.** `slice:today` only. No `scope:shared` change, no
new/edited Stitch screen, no data-model / Firestore / functions change, no
`sheriff.config.ts` change. The `state.vm.subtitle` view-model text content is
**untouched** (only its font size shrinks).

## Scope

**In scope (`slice:today`):**

- **`libs/mobile/today/src/lib/today.page.html`** (~L41) — change
  `<h1 class="hero-title">Watch Today</h1>` to
  `<h2 class="hero-title">Watch Today</h2>`. No other template change; the
  `<p class="hero-subtitle">{{ state.vm.subtitle }}</p>` line and the `.hero`
  `<section>` are unchanged.
- **`libs/mobile/today/src/lib/today.page.scss`** (~L93-109) — swap the three
  `.hero-title` font vars from `display-lg-mobile` → `headline-sm`, and the three
  `.hero-subtitle` font vars from `body-lg` → `body-md`. Update the stale
  `.hero` block comment (L85-88) which currently documents "Title display-lg-mobile
  (28px/700); subtitle body-lg (16px/400)". All other `.hero*` declarations
  (`margin`, `color`, `font-family`) stay as-is.
- **`libs/mobile/today/src/lib/today.page.spec.ts`** — add a small assertion that
  the hero heading renders as an `<h2>` (not `<h1>`) with class `hero-title`
  (see Test plan). Existing specs stay green.

**Out of scope (verify-and-record "no change needed"):**

- **Introducing a shared `ui-kit` page-header / page-title component.** No such
  component exists today (`libs/shared/ui-kit` has only `empty-state`,
  `error-state`, `skeleton-card`, `skeleton-hero`); every page hand-rolls its
  header. Extracting one is a separate, larger refactor — and the "extract only
  at 3+ slices" rule (PLAN §3) means it is not warranted by this fix. Not done
  here.
- **Any other page's header** (Settings, Watchlist, etc.) — untouched.
- **The `state.vm.subtitle` view-model / its text content** — only its font size
  changes.
- Renaming `.hero` / `.hero-title` / `.hero-subtitle` classes.
- Any `scope:shared`, data-model, Firestore, functions, `sheriff.config.ts`, or
  onboarding change.

## Affected slices & Sheriff tags

| Project      | Path                | Sheriff tags                  | Change                                                                                                                                          |
| ------------ | ------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| mobile-today | `libs/mobile/today` | `scope:mobile`, `slice:today` | `today.page.html`: `<h1>`→`<h2>` on the hero title. `today.page.scss`: `.hero-title` + `.hero-subtitle` token swaps + comment. `.spec.ts`: 1 tag/class assertion. |

- **No cross-slice / cross-scope import.** A single existing `scope:mobile` slice
  owns its page html/scss/spec. No slice-to-slice import; the comparison to
  Settings/Watchlist is a token-value reference, not a code dependency.
- **No `sheriff.config.ts` change.** No new lib, no new tag; the existing glob
  already tags `libs/mobile/today/src`. Record "no `sheriff.config.ts` change
  needed" in the PR.
- **No `shared/` extraction concern** — nothing shared or duplicated across
  slices; the fix is confined to one page (PLAN §3 vertical-slice). Do **not**
  extract a shared page-header (see Out of scope).

## Data model touchpoints

**None.** Pure presentation change. No Firestore collection or field is read,
written, or added; no converter change. Consequently:

- **`firestore.rules` — no change.** No new read/write path.
- **`firestore.indexes.json` — no change.** No new query.

Record both as "no change needed" in the PR.

## Public types / APIs

**None.** No new or changed type, no `shared/domain` field, no function
signature, HTTP endpoint, or callable. No `scope:shared` change → **no F2
shared-type ripple**. **No `User` domain field is added or changed → the F4
onboarding-parity rule does not apply** (no persisted preference; pure
presentation). The public barrel surface of `@vultus/mobile/today`
(`TodayPage`, `TodayService`, route) is unchanged. The lib's public API /
behavior / boundaries are unchanged, so no `README.md` update is required
(record "no lib-README change needed").

## UI / Stitch screen refs

**Deliberate deviation from the Stitch screen — this is the point of the fix.**
The primary Stitch screen for this tab is **`812340847a604f8a968021183690bf54`**
("Watch Today - Vultus", project `13590348714018893783`), whose hero specifies
the title at `display-lg-mobile` (28px/700) and subtitle at `body-lg` (16px/400)
— which is exactly the "too large" state issue #243 reports. The user's locked
decision (D1/D2) is to **intentionally depart from that screen** in favour of
**cross-page heading consistency** with the other tabs. So the Stitch screen is
**not** the contract for the hero type scale here; the authoritative target is
the in-repo canonical page-title scale, which was read directly from
`settings.page.scss:57-64` and cross-checked against
`docs/design/vultus-design-system.md` (the token source of truth — hex/token
values are **not** re-transcribed here). No new Stitch fetch is required because
we are deliberately not matching the screen; no new visual element, icon, color,
radius, spacing, or copy is introduced — only the font `size`/`weight`/`line`
tokens on two existing text elements change.

**Type-scale contract (checkable — the Watch Today hero, verify via serve-mock;
tokens reference `docs/design/vultus-design-system.md`, not reprinted hex):**

| Element                  | Tag (after)     | Before (token)         | After (token)     | Resulting scale     |
| ------------------------ | --------------- | ---------------------- | ----------------- | ------------------- |
| `.hero-title` "Watch Today" | `<h2>` (was `<h1>`) | `display-lg-mobile`    | **`headline-sm`** | 20px / 600 / 28px   |
| `.hero-subtitle` (subtitle) | `<p>` (unchanged)   | `body-lg`              | **`body-md`**     | 14px / 400 / 20px   |

- **Title** uses `--vultus-text-headline-sm-size` / `-weight` / `-line`, color
  `--vultus-on-surface`, `margin: 0 0 var(--vultus-space-xs)` (unchanged). This is
  the **same** token trio Settings' `.settings-title` and Watch Today's own
  `.card-title` already consume (both confirmed in-repo), so the tokens are known
  to be wired — no new token, no web-font wiring change (Inter is already loaded
  by spec 0083).
- **Subtitle** uses `--vultus-text-body-md-size` / `-weight` / `-line`, color
  `--vultus-on-surface-variant`, `margin: 0` (unchanged). Same token trio Watch
  Today's own `.episode-label` already consumes.
- **No interactive states** — the hero title and subtitle are static, non-
  interactive text (no default/hover/focus/active/disabled variance to specify).
- **Verify:** on `pnpm nx run mobile:serve-mock`, the Watch Today title renders
  at the same visual size as the Settings "Settings" heading (20px), and the
  subtitle is one step smaller (14px) than before. If serve-mock cannot be run,
  explicitly flag **UNVERIFIED for a human eyeball** (CLAUDE.md UI-fidelity rule)
  — do not report done off a green build alone.

## Implementation task graph

Single task, single slice. No shared-dep / new-slice / root-config prerequisite,
so there is no `[sequential]` gate.

### Task A — Watch Today hero type scale (frontend-engineer) `[parallel]`

Manifest (writes only):

- `libs/mobile/today/src/lib/today.page.html`
- `libs/mobile/today/src/lib/today.page.scss`
- `libs/mobile/today/src/lib/today.page.spec.ts`

Steps:

1. **`today.page.html`:** change the hero heading element from
   `<h1 class="hero-title">Watch Today</h1>` (L41) to
   `<h2 class="hero-title">Watch Today</h2>`. No other template edit.
2. **`today.page.scss`:** in `.hero-title` (L93-100) change the three font vars
   from `--vultus-text-display-lg-mobile-size` / `--vultus-text-display-lg-weight`
   / `--vultus-text-display-lg-mobile-line` to `--vultus-text-headline-sm-size` /
   `--vultus-text-headline-sm-weight` / `--vultus-text-headline-sm-line`. In
   `.hero-subtitle` (L102-109) change the three font vars from
   `--vultus-text-body-lg-size` / `-weight` / `-line` to
   `--vultus-text-body-md-size` / `-weight` / `-line`. Leave every other
   declaration (`margin`, `color`, `font-family`) untouched. Update the stale
   `.hero` block comment (L85-88) to describe the new scale
   (title `headline-sm` 20px/600; subtitle `body-md` 14px/400), and note the
   deliberate deviation from the Stitch screen for cross-page consistency
   (issue #243).
3. **`today.page.spec.ts`:** add the tag/class assertion (see Test plan). Keep
   all existing specs green.

**Visual verification (required):** via serve-mock, confirm the hero title now
matches the Settings heading size and the subtitle shrank — OR explicitly flag
UNVERIFIED for a human.

## Test plan

Per the PLAN §5 pyramid. Component tests on **Vitest + Analog** (no live
Firebase, no emulator, no network, no secrets).

**Component — `today.page.spec.ts` (Vitest + Analog) — Task A:**

- **New:** with a seeded watchable title (reuse the existing `mockService` +
  `setup` helpers, e.g. the single-movie case already used at L305/L325), assert
  the hero heading is rendered as an **`<h2>`** carrying class `hero-title` — e.g.
  `el.querySelector('h2.hero-title')` is non-null **and**
  `el.querySelector('h1.hero-title')` is null. This is the exact defect a missed
  tag change (D3) would leave. The heading tag (not CSS font size) is the
  jsdom-assertable part of this fix.
- **No CSS font-size assertion.** Computed font size / applied CSS custom-property
  values are **not** meaningfully assertable in jsdom (no layout/cascade engine —
  the same limitation the slice's existing specs and specs 0076/0082/0087
  documented). Do not add a fake computed-style assertion; the type-scale change
  is covered by the serve-mock visual check.

**Rendered-text (F3):** the fix changes **no** rendered copy — the hero title text
stays exactly `Watch Today` and the subtitle text is unchanged. Do **not** weaken
or whitespace-normalize any existing rendered-text assertion; the existing exact-
string subtitle checks (`.hero-subtitle` `.toBe('3 things ready to watch')` /
`.toBe('1 thing ready to watch')` at L320/L330) and the section/card/tag text
assertions must stay byte-exact and green. If the new `<h2>` assertion touches the
"Watch Today" title text, assert it as the exact string `Watch Today` (no
normalization).

**e2e (Playwright): none required.** Per the e2e decision rubric this is a purely
cosmetic type-scale tweak to an **existing** page — it introduces no new
route/page and changes no user-facing action, navigation, or persisted state. No
e2e flow is required for this fix. Confirm existing Today-related e2e specs (if
any) still pass unchanged (no locator/copy they depend on changes — the title
text and element role are preserved).

## Definition of done

Tailored from the PLAN §5 checklist. Every checkbox maps to Task A.

- [ ] `pnpm nx affected -t lint typecheck test build --base=main` green —
      affected set is `mobile-today` and `mobile`. (Task A)
- [ ] **Sheriff clean** (in the lint above): no new import, no cross-slice /
      cross-scope edge; single existing `scope:mobile` slice; no
      `sheriff.config.ts` change. (Task A)
- [ ] **Hero heading tag changed** `<h1 class="hero-title">` → `<h2 class="hero-title">`
      in `today.page.html`; class names and the title text `Watch Today`
      preserved; no other template change. (Task A)
- [ ] **`.hero-title` font tokens** swapped `display-lg-mobile` → `headline-sm`
      (20px/600/28px) and **`.hero-subtitle` font tokens** swapped `body-lg` →
      `body-md` (14px/400/20px) in `today.page.scss`; all other `.hero*`
      declarations (margin/color/font-family) untouched; the `.hero` block
      comment updated to the new scale. (Task A)
- [ ] **Component test** asserts the hero renders as `<h2 class="hero-title">`
      (not `<h1>`); all existing `today.page.spec.ts` specs stay green (subtitle
      exact-string assertions unchanged). (Task A)
- [ ] **Visual verification** on serve-mock: the Watch Today title matches the
      Settings heading size (20px) and the subtitle shrank to 14px — OR explicitly
      flagged UNVERIFIED for a human. (Task A)
- [ ] **Verify-and-record NO change:** no shared `ui-kit` page-header component
      introduced; no other page's header touched; `state.vm.subtitle` text
      unchanged; all `scope:shared` files, `firestore.rules`,
      `firestore.indexes.json`, `sheriff.config.ts`, and any onboarding code
      **NOT** modified; no lib-README change needed (public surface unchanged).
      (Task A)
- [ ] **PR description records:** the fix (issue #243 — hero title/subtitle were
      `display-lg-mobile`/`body-lg`, now `headline-sm`/`body-md` to match the
      other tabs' page titles; `<h1>`→`<h2>`), the deliberate deviation from Stitch
      screen `812340847a604f8a968021183690bf54`, and the serve-mock visual result.

## Risks

- **Deliberate departure from the Stitch design.** The Stitch "Watch Today" screen
  specifies the larger `display-lg-mobile` hero; this fix intentionally overrides
  it for cross-page consistency (user's locked D1/D2). **Mitigation:** documented
  as an intentional deviation here and in the PR, with the target scale grounded in
  the in-repo canonical page-title token (`headline-sm`, read from
  `settings.page.scss`) rather than invented. If a later design refresh wants the
  larger hero back, that is a new design decision / spec, not a regression of this
  one.
- **Stale in-code comment left behind.** The `.hero` block comment currently states
  the old scale. **Mitigation:** Task A step 2 explicitly updates it; leaving it
  stale would be a lib-doc-hygiene miss.
- **No PLAN conflict.** A presentation-only CSS/tag change to one existing
  `scope:mobile` slice; no new field/collection/dependency, no `scope:shared`
  change, no cross-slice import, no `User` field (F4 N/A). Fully consistent with
  PLAN §3 vertical-slice and the "don't extract to shared until 3+ slices" rule
  (the shared page-header refactor is explicitly deferred).
</content>
</invoke>
