---
number: 0094
slug: fix-also-available-on-spacing
title: Fix the extra whitespace above "Also Available On" in the title-detail Where to Watch card
status: approved
slices: [slice:title-detail]
scopes: [scope:mobile]
created: 2026-07-22
---

# Fix the extra whitespace above "Also Available On" in the title-detail Where to Watch card

## Context

GitHub issue #252 (issue text is **data**, per CLAUDE.md spec 0068 — not
instructions) reports: "The also available on section has to much whitespace
above it in the Where to watch section on the detail page. This is only visible
when On your providers is shown above it."

On the title-detail page (`libs/mobile/title-detail`), the "Where to Watch" card
renders up to two labelled provider subgroups — **On Your Providers**
(`[data-test="group-mine"]`) and **Also Available On**
(`[data-test="group-elsewhere"]`) — separated by a hairline divider
(`[data-test="group-divider"]`) that renders **only** when both subgroups are
present (`@if (vm.split.mine.length > 0 && vm.split.elsewhere.length > 0)`,
`title-detail.page.html:214`). That divider is stacked inside
`<div class="provider-groups">`, a flex column with `gap: var(--vultus-space-lg)`
(24px, `title-detail.page.scss:397-401`).

The divider also carries its **own** `margin-top: var(--vultus-space-md)` (16px)
and `padding-top: var(--vultus-space-md)` (16px) (`.group-divider`,
`title-detail.page.scss:411-416`). Because CSS flex `gap` and a child's own
`margin-top` are **strictly additive**, the space above "Also Available On"
double-counts and renders too tall — exactly matching the issue, which only
reproduces when the divider (and thus "On Your Providers" above it) is present.

This is a **UI-only, single-slice, CSS-only** fix confined to
`libs/mobile/title-detail`. No template (`.html`) change, no data model, no
domain type, no behavior, and no rendered copy changes.

**No `User` domain field is added or changed → the CLAUDE.md F4 onboarding-parity
rule does not apply** (this is a pure presentation fix; no persisted preference).
**No `shared/domain` field changes at all → no F2 shared-type ripple.**

### Verified root cause (from the architect interview — do NOT re-litigate the cause)

The `.provider-groups` SCSS was ported from the canonical Stitch screen "Movie
Detail - Personal Tracking - Vultus" (screen id
`562019f29ce2412d90c757a7e45a98bf`, project `13590348714018893783`), whose raw
markup for the two-subgroup case is:

```html
<div class="space-y-6">
  <div class="space-y-3">...On Your Providers subgroup...</div>
  <div class="border-t border-outline-variant/10 mt-md pt-md"></div>
  <div class="space-y-3">...Also Available On subgroup...</div>
</div>
```

Tailwind's `space-y-6` utility compiles to
`.space-y-6 > :not([hidden]) ~ :not([hidden]) { margin-top: 1.5rem }` — a
**compound** selector with higher CSS specificity than the divider's own
single-class `.mt-md { margin-top: … }`. So in the original Stitch mock the
divider's own `mt-md` is **superseded** by the higher-specificity `space-y-6`
rule: the divider effectively receives only **one** 24px top margin (from
`space-y-6`), never an additional 16px on top. Its `pt-md` (padding-top — a
different property, not overridden) does apply on top of that.

When translated to compiled SCSS using flexbox `gap` (the `gap` analogue of
`space-y-6`), that override relationship was lost. `gap` **never** overrides a
child's own margin the way a higher-specificity Tailwind rule overrides a
lower-specificity one — they are additive. So the compiled implementation
renders, above "Also Available On":

- `gap-lg` (24px, before the divider) **+** the divider's own `margin-top: md`
  (16px) **+** border (1px) **+** `padding-top: md` (16px) **+** `gap-lg` (24px,
  after the divider) = **81px**

versus the Stitch-intended **~65px** (`gap-lg` + border + `pt-md` + `gap-lg`,
since the divider's own margin-top never rendered in the original design). The
extra **16px** is a pure regression from the Tailwind → SCSS port, not an
intentional design choice.

Tokens (`libs/shared/ui-kit/src/lib/theme.scss:127-129`, cited — **not**
re-transcribed as invented values): `--vultus-space-sm: 8px`,
`--vultus-space-md: 16px`, `--vultus-space-lg: 24px`.

### IMPORTANT correction to the decision record — the plex-divider is NOT inside `.provider-groups`

The interview decision record anticipated that the sibling `.personal-tracking`
"plex-divider" (spec 0061) reuses the **same** `.group-divider` class and assumed
it "sits after `group-elsewhere`/`group-mine` **inside the same
`.provider-groups` flex parent** and has the identical double-counting bug," so
that a blanket removal of `margin-top` from `.group-divider` "applies there too
consistently … not a regression."

**Direct reading of the source contradicts that premise** and this spec corrects
it (the spec-author's duty to ground the fix in real architecture):

- The plex-divider **does** reuse the same class:
  `<div class="group-divider" data-test="plex-divider"></div>`
  (`title-detail.page.html:259`). ✔ (this part of the record holds)
- **But it is NOT inside `.provider-groups`.** The `.provider-groups` element
  closes at `title-detail.page.html:248` (inside the `@else` block that closes at
  L249). The plex-divider (L259) is a **direct block-flow child of the
  `.glass-panel` "Where to Watch" card** (`data-test="providers"`, opens L159,
  closes L299), a sibling of `.provider-groups` and `.personal-tracking`.
- **`.glass-panel` is NOT a flex-gap container** — it is a plain block with
  `padding` (`title-detail.page.scss:342-353`, no `display: flex`, no `gap`). So
  the plex-divider has **no parent flex `gap`** supplying space above it; its only
  source of top spacing is its **own** `margin-top: var(--vultus-space-md)`.

Consequences:

1. The plex-divider has **no double-counting bug** — there is only the single
   margin-top, which is exactly what it needs.
2. A **blanket** removal of `margin-top` from the shared `.group-divider` class
   would **regress** the plex-divider: "Personal Tracking" would butt directly
   against the provider rows above it. That directly violates the interview's own
   "do not touch any other card's spacing" constraint.

**Therefore the fix must be scoped to the flex-parented subgroup divider only**,
leaving the base `.group-divider` (and thus the plex-divider's spacing)
unchanged. This is strictly _less_ invasive than a blanket removal — it is not
scope creep; it is the correct way to honour both "fix the Also Available On
whitespace" and "don't touch the plex-divider." See D1.

### Locked decisions (from the architect interview + the correction above — do NOT re-litigate)

**D1. Scoped CSS fix — zero the subgroup divider's `margin-top` only.** In
`title-detail.page.scss`, add a scoped rule that zeroes `margin-top` for the
divider **when it is a child of `.provider-groups`** (the subgroup divider), e.g.:

```scss
// Issue #252: the subgroup divider is a flex child of `.provider-groups`
// (gap: lg), which already supplies the `space-y-6` rhythm above it — matching
// the Stitch mock, whose higher-specificity `space-y-6` rule superseded the
// divider's own `mt-md`. Its own margin-top double-counts, so zero it here.
// (The plex-divider reuses `.group-divider` but is a block-flow child of
// `.glass-panel` with no flex-gap sibling, so it KEEPS the base margin-top.)
.provider-groups > .group-divider {
  margin-top: 0;
}
```

- Keep the base `.group-divider { border-top … ; margin-top:
var(--vultus-space-md); padding-top: var(--vultus-space-md); }`
  (`title-detail.page.scss:411-416`) **exactly as-is** — the plex-divider depends
  on that base `margin-top` (see the correction above). Keep the subgroup
  divider's `border-top` and `padding-top` (both still render in the Stitch mock)
  **unchanged**; only its `margin-top` is zeroed.
- **Do NOT** change the `.provider-groups` `gap` value, the `--vultus-space-*`
  token definitions, or any other card's spacing.
- **Net effect:** spacing above "Also Available On" drops from **81px → 65px**
  (removing exactly the redundant 16px), matching the canonical Stitch screen's
  actual rendered rhythm. The plex-divider's spacing is **unchanged**.

Implementation note: `.provider-groups > .group-divider { margin-top: 0 }` is the
minimal, additive, CSS-only form. An equivalent nesting under `.provider-groups`
(child selector) is acceptable; the invariant that review checks is that **only
the divider that is a child of `.provider-groups` loses its margin-top** and the
base `.group-divider` rule (plex-divider) is untouched. **No `!important`.**

**D2. No template change.** The `@if` gating for the divider and both subgroups
(`title-detail.page.html:176/214/219`) is already correct; only the subgroup
divider's own spacing declaration is wrong. Do **not** restructure the template's
`@if` branching, rename classes, or change `data-test` hooks.

**D3. Per-slice, minimal diff.** `slice:title-detail` only. No `scope:shared`
change, no `shared/ui-kit` token change (the `--vultus-space-*` tokens are correct
and unchanged; only how the subgroup divider _composes_ them changes), no
data-model / Firestore / functions change, no `sheriff.config.ts` change.

## Scope

**In scope (`slice:title-detail`):**

- **`libs/mobile/title-detail/src/lib/title-detail.page.scss`** — add the D1
  scoped rule `.provider-groups > .group-divider { margin-top: 0; }` with the
  explanatory comment. Update the stale `.group-divider` block comment
  (L409-410) which currently documents the "mt-md/pt-md rhythm" so it notes the
  subgroup divider's margin-top is now supplied by the parent flex `gap` (issue
  #252), while the plex-divider keeps the base margin-top. Leave the base
  `.group-divider` declarations, `.provider-groups`, and every other rule
  untouched.
- **`libs/mobile/title-detail/src/lib/title-detail.page.spec.ts`** — extend the
  existing two-subgroup test (L429-456, "mixed mine + elsewhere → both groups
  render, mine first, divider between") with a **structural** assertion that the
  rendered `[data-test="group-divider"]` is a **direct child of
  `.provider-groups`** (the precondition that makes the scoped `>` selector
  target it), and — in a case where both the two-subgroup split **and** the plex
  section render — that `[data-test="plex-divider"]` is **NOT** a child of
  `.provider-groups` (proving the fix does not touch it). See Test plan for why a
  jsdom computed-style assertion is not used.

**Out of scope (verify-and-record "no change needed"):**

- **The plex-divider / `.personal-tracking` section's spacing** — deliberately
  **unchanged** (see the Context correction: it is a block-flow `.glass-panel`
  child and legitimately keeps the base `.group-divider` margin-top). The fix must
  NOT regress it.
- **`.provider-groups` `gap` value, the `--vultus-space-*` token definitions in
  `theme.scss`, and any other card's spacing** — untouched (D1/D3).
- Renaming `.group-divider` / `.provider-groups` classes or any `data-test` hook;
  restructuring the `@if` branching (D2).
- Any `scope:shared`, `shared/ui-kit`, data-model, Firestore, functions,
  `sheriff.config.ts`, or onboarding change.

## Affected slices & Sheriff tags

| Project             | Path                       | Sheriff tags                         | Change                                                                                                                                                                       |
| ------------------- | -------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mobile-title-detail | `libs/mobile/title-detail` | `scope:mobile`, `slice:title-detail` | `title-detail.page.scss`: add one scoped `.provider-groups > .group-divider { margin-top: 0 }` rule + comment update. `title-detail.page.spec.ts`: extend one existing test. |

- **No cross-slice / cross-scope import.** A single existing `scope:mobile` slice
  owns its page scss/spec. The comparison to the Stitch mock and to the
  `--vultus-space-*` tokens is a value reference, not a code dependency.
- **No `sheriff.config.ts` change.** No new lib, no new tag; the existing glob
  already tags `libs/mobile/title-detail/src`. Record "no `sheriff.config.ts`
  change needed" in the PR.
- **No `shared/` extraction concern** — nothing shared or duplicated across
  slices; the fix is confined to one page (PLAN §3 vertical-slice). The
  `--vultus-space-*` tokens already live in `shared/ui-kit` and are unchanged.

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
presentation). The public barrel surface of `@vultus/mobile/title-detail` is
unchanged, and the lib's public API / behavior / boundaries are unchanged, so **no
`README.md` update is required** (record "no lib-README change needed").

## UI / Stitch screen refs

**Canonical Stitch screen: `562019f29ce2412d90c757a7e45a98bf` ("Movie Detail -
Personal Tracking - Vultus", project `13590348714018893783`).** The screen's raw
`.space-y-6` / divider markup was **already re-fetched raw during the architect
interview** and is quoted verbatim in the Context "Verified root cause" section
above (the `space-y-6` → higher-specificity `mt-md` override is the whole basis
of the fix), so the implementer does **not** need to re-fetch the markup to
determine the target rhythm. Per CLAUDE.md ("UI fidelity is a contract"), the
implementer **is** still expected to grab `screenshot.downloadUrl` for this screen
and do a visual compare during implementation (see Test plan / DoD).

This fix introduces **no new visual element, icon, color, radius, font, or copy**
— it removes 16px of redundant vertical spacing so the compiled rhythm matches
what the Stitch mock actually renders. Tokens reference
`docs/design/vultus-design-system.md` and `theme.scss`; no hex is reprinted here.

**Spacing contract (checkable — the "Where to Watch" card's two-subgroup case;
verify via serve-mock screenshot-compare against screen
`562019f29ce2412d90c757a7e45a98bf`):**

| Region                                                                                                         | Before (buggy) | After (this fix)     | Composition (after)                                                                           |
| -------------------------------------------------------------------------------------------------------------- | -------------- | -------------------- | --------------------------------------------------------------------------------------------- |
| Above **Also Available On** (i.e. from the last "On Your Providers" row down to the "Also Available On" label) | **81px**       | **65px** (−16px)     | `gap-lg` (24) + divider `border-top` (1) + divider `padding-top: md` (16) + `gap-lg` (24)     |
| Subgroup divider's own `margin-top`                                                                            | 16px           | **0**                | Supplied instead by the `.provider-groups` flex `gap` above it                                |
| Plex-divider (`[data-test="plex-divider"]`) `margin-top`                                                       | 16px           | **16px (UNCHANGED)** | Block-flow child of `.glass-panel`; keeps base `.group-divider` margin-top — must NOT regress |

- **No interactive states** — the divider is a static, non-interactive hairline
  (no default/hover/focus/active/disabled variance to specify). Provider rows'
  existing hover affordance is untouched.
- **Verify:** on `pnpm nx run mobile:serve-mock`, navigate to a title with **both**
  subgroups populated ("On Your Providers" and "Also Available On" both visible)
  and screenshot-compare the space above "Also Available On" against the Stitch
  screenshot for screen `562019f29ce2412d90c757a7e45a98bf`. Also confirm the plex
  "Personal Tracking" divider spacing is visually **unchanged** on a Plex-user,
  tracked title. **If `mobile:serve-mock` cannot be run in the implementing
  session, explicitly flag UNVERIFIED for a human eyeball** (CLAUDE.md UI-fidelity
  rule — this is a real, expected fallback path, not hypothetical) — do **not**
  report done off a green build alone.

## Implementation task graph

Single task, single slice. No shared-dep / new-slice / root-config prerequisite,
so there is no `[sequential]` gate.

### Task A — subgroup divider spacing fix (frontend-engineer) `[parallel]`

Manifest (writes only):

- `libs/mobile/title-detail/src/lib/title-detail.page.scss`
- `libs/mobile/title-detail/src/lib/title-detail.page.spec.ts`

Steps:

1. **`title-detail.page.scss`:** add the D1 scoped rule
   `.provider-groups > .group-divider { margin-top: 0; }` with the explanatory
   comment (issue #252; the parent flex `gap` supplies the rhythm; the plex-divider
   keeps the base margin-top). Update the stale `.group-divider` block comment
   (L409-410) to reflect that the subgroup divider's top spacing now comes from the
   parent flex `gap`. Leave the base `.group-divider` declarations,
   `.provider-groups`, `theme.scss` tokens, and every other rule untouched. No
   `!important`.
2. **`title-detail.page.spec.ts`:** extend the existing two-subgroup test
   (L429-456) with the structural assertions (see Test plan). If a fixture that
   renders **both** the two-subgroup split and the Plex "Personal Tracking" section
   exists, reuse it for the plex-divider-not-a-child assertion; otherwise add a
   minimal case seeding both `split.mine`/`split.elsewhere` and the Plex/tracked
   state. Keep all existing specs green.

**Visual verification (required):** via serve-mock, screenshot-compare the
"Also Available On" top spacing against Stitch screen
`562019f29ce2412d90c757a7e45a98bf` and confirm the plex-divider spacing is
unchanged — OR explicitly flag UNVERIFIED for a human.

## Test plan

Per the PLAN §5 pyramid. Component tests on **Vitest + Analog** (no live Firebase,
no emulator, no network, no secrets).

**Component — `title-detail.page.spec.ts` (Vitest + Analog) — Task A:**

- **Extend the existing** "mixed mine + elsewhere" test (L429-456): after
  asserting `[data-test="group-divider"]` is truthy, assert it is a **direct child
  of `.provider-groups`** — e.g.
  `el.querySelector('.provider-groups > [data-test="group-divider"]')` is
  non-null (equivalently, `dividerEl.parentElement.classList.contains('provider-groups')`).
  This is the exact structural precondition the scoped `>` selector relies on; if a
  future refactor moved the divider out of `.provider-groups`, the fix would
  silently stop applying and this test would catch it.
- **New / extended case for the plex-divider guard:** in a fixture where **both**
  the two-subgroup split **and** the Plex "Personal Tracking" section render
  (`vm.hasPlex && vm.tracked !== null`), assert `[data-test="plex-divider"]` is
  present **and is NOT a child of `.provider-groups`** (it is a block-flow child of
  the `.glass-panel` "Where to Watch" card) — proving the scoped fix does not touch
  the plex-divider. This encodes the Context correction as a regression guard.
- **No CSS computed-style / margin assertion.** Computed style and applied CSS
  custom-property / stylesheet-cascade values are **not** meaningfully assertable
  in jsdom (no layout/cascade engine — the same limitation specs 0076/0082/0087/0091
  documented; `getComputedStyle(dividerEl).marginTop` will **not** resolve a
  stylesheet rule in this Analog+Vitest jsdom environment). Do **not** add a fake
  computed-style assertion; the actual 81px → 65px spacing change is covered by the
  serve-mock visual check (and flagged UNVERIFIED for a human if serve-mock cannot
  run). This deliberately supersedes the interview's suggested
  `getComputedStyle(...).marginTop === '0px'` assertion, which is not viable in
  jsdom.

**Rendered-text (F3): not applicable.** The fix changes **no** rendered copy — no
rendered-text assertion is added or changed (this is a computed-style/spacing
concern, asserted structurally, not a text-content concern). Do **not** weaken or
whitespace-normalize any existing rendered-text assertion in the spec file; the
existing provider-name / label exact-string checks (e.g. `toContain('Netflix')`,
`toContain('Prime Video')`) stay as-is and green.

**e2e (Playwright): none required.** Per the e2e decision rubric this is a purely
cosmetic vertical-spacing tweak to an **existing** page — it introduces no new
route/page and changes no user-facing action, navigation, or persisted state. The
e2e-probe was **considered and intentionally not added** (not skipped by
omission). Confirm any existing title-detail e2e specs still pass unchanged (no
locator / `data-test` / copy they depend on changes — the template is untouched).

## Definition of done

Tailored from the PLAN §5 checklist. Every checkbox maps to Task A.

- [ ] `pnpm nx affected -t lint typecheck test build --base=main` green —
      affected set is `mobile-title-detail` and `mobile`. (Task A)
- [ ] **Sheriff clean** (in the lint above): no new import, no cross-slice /
      cross-scope edge; single existing `scope:mobile` slice; no
      `sheriff.config.ts` change. (Task A)
- [ ] **Scoped SCSS rule added:** `.provider-groups > .group-divider {
    margin-top: 0; }` (with the issue-#252 comment) in `title-detail.page.scss`;
      the base `.group-divider` `border-top` / `margin-top` / `padding-top`
      declarations, `.provider-groups`, the `--vultus-space-*` tokens, and every
      other rule are untouched; **no `!important`**; the stale `.group-divider`
      block comment updated. (Task A)
- [ ] **Plex-divider NOT regressed:** the plex-divider (`[data-test="plex-divider"]`)
      still uses the base `.group-divider` `margin-top: var(--vultus-space-md)`;
      "Personal Tracking" spacing is visually unchanged (serve-mock check below).
      (Task A)
- [ ] **Component tests** assert (a) `[data-test="group-divider"]` is a direct
      child of `.provider-groups`, and (b) `[data-test="plex-divider"]` is present
      but NOT a child of `.provider-groups`; no fake jsdom computed-style
      assertion; all existing `title-detail.page.spec.ts` specs stay green. (Task A)
- [ ] **Visual verification** on serve-mock: the space above "Also Available On"
      dropped from ~81px to ~65px matching Stitch screen
      `562019f29ce2412d90c757a7e45a98bf`, **and** the plex "Personal Tracking"
      divider spacing is unchanged — OR explicitly flagged UNVERIFIED for a human.
      (Task A)
- [ ] **Verify-and-record NO change:** `.provider-groups` `gap`, the
      `--vultus-space-*` tokens (`theme.scss`), any other card's spacing, the
      `.html` template / `@if` branching / `data-test` hooks, all `scope:shared` /
      `shared/ui-kit` files, `firestore.rules`, `firestore.indexes.json`,
      `sheriff.config.ts`, and any onboarding code are **NOT** modified; no
      lib-README change needed (public surface unchanged). (Task A)
- [ ] **PR description records:** the fix (issue #252 — the subgroup divider's own
      `margin-top: md` double-counted on top of the `.provider-groups` flex `gap`,
      an artifact of the Tailwind `space-y-6` → SCSS `gap` port losing the
      specificity override; now scoped to `.provider-groups > .group-divider`,
      81px → 65px); the **correction** that the plex-divider is a block-flow
      `.glass-panel` child and is deliberately left unchanged; and the serve-mock
      visual result (or UNVERIFIED flag).

## Risks

- **The interview premise about the plex-divider was factually wrong.** The
  decision record assumed the plex-divider sits inside `.provider-groups` and
  should also lose its margin-top. Reading the source shows it is a block-flow
  child of `.glass-panel` (not flex-gapped) and relies on its own margin-top; a
  blanket `.group-divider` margin-top removal would **regress** it. **Mitigation:**
  D1 scopes the fix to `.provider-groups > .group-divider` and the component test
  guards that the plex-divider is not a `.provider-groups` child. This is
  documented here and in the PR so the narrower scope is understood as intentional,
  not an oversight.
- **jsdom cannot assert the actual spacing.** The 81px → 65px change is a rendered
  layout property, not assertable in the Analog+Vitest jsdom (no cascade/layout
  engine). **Mitigation:** the component test asserts the DOM **structure** the fix
  depends on (divider parentage), and the pixel result is verified via serve-mock
  screenshot-compare against the Stitch screen — with an explicit UNVERIFIED flag
  path if serve-mock cannot run in-session (CLAUDE.md UI-fidelity rule).
- **No PLAN conflict.** A presentation-only CSS change to one existing
  `scope:mobile` slice; no new field/collection/dependency, no `scope:shared`
  change, no cross-slice import, no `User` field (F4 N/A), no shared-type ripple
  (F2 N/A). Fully consistent with PLAN §3 vertical-slice and the "don't extract to
  shared until 3+ slices" rule (the `--vultus-space-*` tokens already live in
  `shared/ui-kit` and are unchanged).
