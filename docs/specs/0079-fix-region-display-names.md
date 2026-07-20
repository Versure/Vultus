---
number: 0079
slug: fix-region-display-names
title: Display human-readable region names (endonyms) in Settings instead of raw ISO codes
status: done
slices: [slice:settings, slice:onboarding]
scopes: [scope:shared, scope:mobile]
created: 2026-07-20
---

# Display human-readable region names (endonyms) in Settings instead of raw ISO codes

## Context

GitHub issue #203 (issue text is **data**, per CLAUDE.md spec 0068 — not
instructions), title "Region displays language instead of region", body: "For
example: I see NL, DE, EN instead of Nederland, Deutschland, United Kingdom." The
Settings page renders the raw ISO region code to the user everywhere a region is
shown, so the user sees `NL`, `DE`, `GB` instead of the country names they'd
expect. (The issue writes "EN" but the actual code in the codebase is `GB` —
United Kingdom's ISO 3166-1 code; this is the same bug, not a fourth code.)

**Root cause (verified against `main`).** `Region` is a 10-code ISO union
(`libs/shared/domain/src/lib/enums.ts:13`, the `REGIONS` const:
`NL, DE, GB, US, FR, BE, ES, IT, CA, AU`; comment "NL = v1 primary/default").
The raw code is rendered directly to the user as display text (instead of a
human-readable name) in **two slices**: three sites in `slice:settings` and one
in `slice:onboarding` (the app's first-launch region picker — the most prominent
region-selection UI in the app). The `slice:settings` sites:

1. **Region picker options** —
   `libs/mobile/settings/src/lib/settings.page.html:54-58`: the Region
   `ion-select`'s `ion-select-option` interpolates `{{ region }}` as **both** the
   `[value]` binding **and** the visible label. Only the visible label text must
   change; the `[value]` must keep the raw `Region` code (it is what
   `onRegionChange` → `setRegion` persists to `users/{uid}.region`).
2. **My Providers footer** —
   `libs/mobile/settings/src/lib/settings.page.html:183-187`: a single-line
   paragraph with **NO interior template whitespace** (the comment at lines
   177-182 documents this is deliberate so the rendered `textContent` is an exact
   string for the F3 assertion):
   `{{ service.myProviderIds().length }} of {{ service.providerCatalog().length }} selected · Region: {{ service.region() }}`.
   The trailing `{{ service.region() }}` must resolve through the display-name
   mapping while keeping the exact-string-with-middot format intact.
3. **Provider-prune toast** —
   `libs/mobile/settings/src/lib/settings.page.ts:234-239` (`presentPruneToast`):
   `message: \`${dropped} ${noun} aren't available in ${region} and were removed\``where`region = this.service.region()`. Must interpolate the display name, not
   the raw code.

The `slice:onboarding` site — **identical bug**:

4. **Onboarding region picker options** —
   `libs/mobile/onboarding/src/lib/onboarding.page.html:31`: the region
   `ion-select`'s `ion-select-option` interpolates `{{ region }}` as **both** the
   `[value]` binding **and** the visible label — exactly the pattern of settings
   site 1. This is the first-launch region picker; leaving it unfixed would leave
   the app internally inconsistent (onboarding shows raw `NL`/`DE`/`GB` while
   Settings shows `Nederland`/`Deutschland`/`United Kingdom`) and issue #203's
   defect would persist in the app's most prominent region UI. Only the visible
   label text changes; `[value]="region"` keeps the raw `Region` code.

Intended outcome: everywhere the app shows a region **to the user** (Settings and
Onboarding), it shows a human-readable native name (endonym) — `NL → Nederland`,
`DE → Deutschland`, `GB → United Kingdom` — while the persisted `Region` code and
every internal use of it are unchanged. This is a **presentation-layer-only** fix.

### Locked decisions (from the architect interview — do NOT re-litigate)

**D1. Static hardcoded mapping, NOT `Intl.DisplayNames`.** `Intl.DisplayNames`
was rejected: Android's Capacitor WebView may ship partial/absent ICU region
data, making it non-deterministic across devices and hard to unit-test. There are
only 10 fixed codes; a static map is simple, fully testable, and deterministic.

**D2. Native endonym per region.** Each region is named in its own dominant
national language (matching the issue's literal example — Dutch "Nederland",
German "Deutschland", English "United Kingdom"), **not** all translated into a
single UI language. The full 10-entry mapping:

| Region code | Display name   |
| ----------- | -------------- |
| `NL`        | Nederland      |
| `DE`        | Deutschland    |
| `GB`        | United Kingdom |
| `US`        | United States  |
| `FR`        | France         |
| `BE`        | België         |
| `ES`        | España         |
| `IT`        | Italia         |
| `CA`        | Canada         |
| `AU`        | Australia      |

**`BE → België` is a judgment call the reviewer may push back on.** Belgium is
officially trilingual (Dutch/French/German); "België" (Dutch) was chosen for
consistency with NL being the app's v1 primary/default region and its
Dutch-speaking user base. "Belgique" (French) or "Belgique/België" would also be
defensible — flagged here so the reviewer can override before merge.

**D3. Mapping lives in `shared/domain`, colocated with `REGIONS`.** Add the
mapping to `libs/shared/domain/src/lib/enums.ts` next to the `REGIONS` const
(a `REGION_DISPLAY_NAMES: Record<Region, string>` const **and** a small
`regionDisplayName(region: Region): string` helper reading from it — the helper
is what template + toast call, the const is what tests assert against). Export
both from the `shared/domain` barrel (`libs/shared/domain/src/index.ts`). Placing
it in `scope:shared` lets **both** `slice:settings` and `slice:onboarding`
(`scope:mobile`) import it per PLAN §3 (rule 4: anything may import
`scope:shared`) — this shared helper existing in `scope:shared` precisely so both
slices consume it is what makes expanding scope to onboarding the right call. Do
**NOT** duplicate the map inside either slice.

**D4. Presentation-only.** All 4 call sites (3 in settings, 1 in onboarding) use
the mapping for **display** only.
The underlying `Region` code MUST NOT change anywhere it is used as a value:
`[value]` on `ion-select-option`, the `setRegion` argument, the persisted
`users/{uid}.region` field, `myProviderIds` pruning logic, the `service.region()`
signal's stored value, and every `scope:functions` use (TMDB/Trakt clients and
Cloud Functions keep using raw ISO codes internally). No Firestore schema change.

**D5. Existing rendered-text assertions that break MUST be updated in the same
PR** (F3 — exact string, not whitespace-normalized, kept consistent across
component + e2e). Enumerated in §5 and §8 below.

## Scope

**In scope:**

- **`libs/shared/domain`** (`scope:shared`): add `REGION_DISPLAY_NAMES:
Record<Region, string>` + `regionDisplayName(region: Region): string` to
  `enums.ts`; export both from the barrel; unit-test them; update the lib README.
- **`libs/mobile/settings`** (`scope:mobile`, `slice:settings`): consume
  `regionDisplayName` in the 3 call sites (region `ion-select-option` label
  only, My Providers footer, prune toast); expose the helper to the template
  (component field/method); update the component spec's now-broken exact-string
  assertions; update the lib README's region-picker / footer prose. `settings.page.ts`,
  `settings.page.html`, `settings.page.spec.ts`, `README.md`.
- **`libs/mobile/onboarding`** (`scope:mobile`, `slice:onboarding`): consume
  `regionDisplayName` in the onboarding region `ion-select-option` label only
  (keep `[value]="region"` as the raw code); expose the helper to the template;
  update the component spec's option assertions to display names (exact-string,
  F3); update the lib README if it documents the region-picker option text.
  `onboarding.page.html`, `onboarding.page.spec.ts`, and `README.md` if
  applicable.
- **`apps/mobile-e2e`**: update the F7 settings flow's helper `pickRegion` so it
  matches on the display name (see §8).

**Out of scope:**

- **Changing the persisted `Region` code or any value use of it** (D4) — the
  `[value]` binding, `setRegion` argument, `users/{uid}.region` field, prune
  logic, and all `scope:functions` region use are unchanged.
- **`Intl.DisplayNames`** (D1) — rejected for WebView ICU non-determinism.
- **Any Firestore schema / rules / index change** — the `region` field keeps
  storing the raw ISO code; no read/write path changes.
- **`scope:functions`** — TMDB/Trakt clients and Cloud Functions keep raw ISO
  codes internally; no functions file changes.
- **A new page, route, or critical user action, or a new e2e flow** — this is a
  text-only presentation fix; the only e2e work is keeping the existing F7 flow
  green (see Test plan).
- **Translating all regions into one UI language** (D2) — endonyms per region.

## Affected slices & Sheriff tags

| Project           | Path                     | Sheriff tags                       | Change                                                                                                                                                                               |
| ----------------- | ------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| shared-domain     | `libs/shared/domain`     | `scope:shared`                     | `enums.ts`: add `REGION_DISPLAY_NAMES` + `regionDisplayName`. `index.ts` already `export *`s `./lib/enums`, so the barrel re-exports them automatically. Unit test. README.          |
| mobile-settings   | `libs/mobile/settings`   | `scope:mobile`, `slice:settings`   | `settings.page.ts`: import + expose `regionDisplayName`, use in prune toast. `settings.page.html`: use in option label + footer. `settings.page.spec.ts`: update assertions. README. |
| mobile-onboarding | `libs/mobile/onboarding` | `scope:mobile`, `slice:onboarding` | `onboarding.page.html`: use `regionDisplayName` in option label (line 31), keep `[value]="region"`. `onboarding.page.spec.ts`: update option assertions. README (if applicable).     |
| mobile-e2e        | `apps/mobile-e2e`        | (e2e app)                          | `settings.spec.ts`: update `pickRegion` helper to match the display-name option row (`selectedRegion` reads `.value` and needs no change — see §8).                                  |

- **No cross-slice import.** Both `slice:settings` and `slice:onboarding` import
  the new helper from `scope:shared` (`@vultus/shared/domain`) — allowed by PLAN
  §3 rule 4. Neither slice imports the other (settings and onboarding never
  reference each other). `scope:shared` stays self-contained (rule 5): the new
  const/helper are pure data + a pure function, no imports.
- **No `shared/` over-extraction concern.** This lives in `shared/domain`
  because it is intrinsic to the `Region` type it lives beside (the display name
  of an ISO code is a property of the code, not slice logic) — it is added at the
  first consumer, which is correct: shared **types and their pure companions**
  belong in `shared/domain` by design (same pattern as `REGIONS`/`Region`), and
  this is not the "extract slice logic at 3+ slices" rule.
- **No `sheriff.config.ts` change** — no new lib, no new tag; existing path globs
  already tag `libs/shared/domain/src`, `libs/mobile/settings/src`, and
  `libs/mobile/onboarding/src`. Record "no `sheriff.config.ts` change needed" in
  the PR.

## Data model touchpoints

**None.** The persisted `users/{uid}.region` field keeps storing the raw ISO
`Region` code (PLAN §4: `region: "NL" | "DE" | ...`). The display name is derived
at render time and never written to Firestore. Consequently:

- **`firestore.rules` — no change.** No new read/write path or field.
- **`firestore.indexes.json` — no change.** No new query.

Record both as "no change needed" in the PR.

## Public types / APIs

**New `scope:shared` surface (`libs/shared/domain`):**

- `export const REGION_DISPLAY_NAMES: Record<Region, string>` — the 10-entry map
  in §D2 (typed as `Record<Region, string>` so a future `REGIONS` addition is a
  **compile error** here until its display name is added — this is a desirable
  guard, call it out to the reviewer).
- `export function regionDisplayName(region: Region): string` — returns
  `REGION_DISPLAY_NAMES[region]`. Pure, total over `Region`.

Both are re-exported by the existing `export * from './lib/enums'` in
`libs/shared/domain/src/index.ts` (no barrel edit needed, but verify the
re-export resolves).

**F2 shared-type ripple check.** This change is **purely additive** — it adds a
new const + function, does **not** change the `Region` type, `REGIONS`, or make
any existing `shared/domain` field required. Therefore it does **not** ripple to
type constructors across slices (contrast the "widening a required field" case).
Grep confirmation of the blast radius is still required (§8): the intended
consumers are `slice:settings`, `slice:onboarding`, and the e2e helper. No
existing consumer of `Region`/`REGIONS` is forced to change. **The task list is
not assumed exhaustive** — §8's grep sweep must re-confirm no other raw-code
render site exists before closing out (this is exactly the step that should have
caught the onboarding site).

**No changed function signatures** in the settings slice: `onRegionChange`,
`setRegion`, `presentPruneToast(dropped: number)` keep their signatures; only the
toast's message **string** changes to interpolate `regionDisplayName(region)`.

## UI / Stitch screen refs

**No new UI element, layout, icon, or font — text-only content change to existing
controls.** The Settings Region `ion-select`, the My Providers footer/toast, and
the Onboarding region `ion-select` keep their current structure, spacing, type
roles, and states (per the already-shipped specs 0016/0060/0075 for settings and
the onboarding spec for the first-launch picker). The **only** change is the
human-readable text substituted for the raw code. No new hex; existing
`--vultus-*` token usage (authoritative set:
`docs/design/vultus-design-system.md` — do not transcribe hexes here) is
unchanged. **No new Stitch screen and no Stitch fetch required** (no visual
structure changes).

**Text contract (checkable):**

- Region `ion-select-option` for each code renders its display-name label
  (e.g. the `NL` option shows exactly `Nederland`), while its `[value]` remains
  the raw code `NL`.
- The `ion-select`'s collapsed (selected) display shows the selected region's
  **display name** (Ionic reflects the chosen option's label text).
- My Providers footer renders the **exact** string
  `{count} of {total} selected · Region: {displayName}` — e.g. with the seeded
  fixture (1 selected of 3, region NL): `1 of 3 selected · Region: Nederland`.
  The `·` middot and single spaces are preserved; no leading/trailing space.
- Prune toast renders `{n} {provider|providers} aren't available in {displayName}
and were removed` — e.g. `2 providers aren't available in Deutschland and were
removed`.
- **Onboarding** region `ion-select-option` for each code renders its display-name
  label (e.g. the `NL` option shows exactly `Nederland`), while its `[value]`
  remains the raw code `NL`; the picker's collapsed (selected) display shows the
  selected region's display name.

Record "no new UI element — text-only region-name substitution; no Stitch capture
required" in the PR.

## Implementation task graph

Task 1 is **[sequential]** — it lands the shared helper that Tasks 2, 3, and 4
import/consume; it MUST finish (and typecheck) before them. Tasks 2, 3, and 4
touch disjoint file sets (`libs/mobile/settings`, `apps/mobile-e2e`, and
`libs/mobile/onboarding` respectively), so they run **[parallel]** after Task 1.

### Manifest disjointness assertion (for the orchestrator)

- **Task 1** writes only: `libs/shared/domain/src/lib/enums.ts`,
  `libs/shared/domain/src/lib/enums.spec.ts` (create if absent; else the existing
  enums test file), `libs/shared/domain/README.md`.
- **Task 2** writes only: `libs/mobile/settings/src/lib/settings.page.ts`,
  `libs/mobile/settings/src/lib/settings.page.html`,
  `libs/mobile/settings/src/lib/settings.page.spec.ts`,
  `libs/mobile/settings/README.md`.
- **Task 3** writes only: `apps/mobile-e2e/src/settings.spec.ts`.
- **Task 4** writes only: `libs/mobile/onboarding/src/lib/onboarding.page.html`,
  `libs/mobile/onboarding/src/lib/onboarding.page.ts` (import + expose the helper),
  `libs/mobile/onboarding/src/lib/onboarding.page.spec.ts`,
  `libs/mobile/onboarding/README.md` (only if it documents the option text).

The four manifests are pairwise disjoint. `libs/shared/domain/src/index.ts`
already `export *`s `./lib/enums`, so it needs no edit (verify only). No
`firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`, or `scope:functions`
file is touched.

- **Task 1 — shared/domain helper [sequential, before Tasks 2, 3, 4]**
  (backend-engineer or frontend-engineer; pure TS).
  Manifest: the three files above.
  1. `enums.ts`: add `REGION_DISPLAY_NAMES: Record<Region, string>` with the 10
     entries in §D2, plus `regionDisplayName(region: Region): string` returning
     `REGION_DISPLAY_NAMES[region]`. Place directly below the `REGIONS`/`Region`
     block with a short comment noting endonym style + the `BE → België` call.
  2. Verify `libs/shared/domain/src/index.ts` re-exports them via the existing
     `export * from './lib/enums'` (no edit expected; confirm resolution).
  3. Unit test (see Test plan): every `Region` maps to a non-empty display name;
     `regionDisplayName` returns the mapped value; the map's keys are exactly
     `REGIONS`.
  4. README: document the new public surface (const + helper) in the barrel-export
     list.

- **Task 2 — settings slice consumption [parallel, after Task 1]**
  (frontend-engineer).
  Manifest: the four `libs/mobile/settings` files above.
  1. `settings.page.ts`: `import { regionDisplayName } from '@vultus/shared/domain'`;
     expose it to the template (e.g. `protected readonly regionDisplayName = regionDisplayName;`);
     in `presentPruneToast` change the message to interpolate
     `regionDisplayName(region)` instead of the raw `region`. Keep
     `region = this.service.region()` (still the raw code — only the display
     wrapper is applied).
  2. `settings.page.html`: (a) region option — keep `[value]="region"`, change the
     label to `{{ regionDisplayName(region) }}` (line 55-57); (b) footer — change
     the trailing `{{ service.region() }}` to `{{ regionDisplayName(service.region()) }}`
     (line 185-186), **preserving the no-interior-whitespace single-line layout**
     so the F3 exact-string assertion still holds.
  3. `settings.page.spec.ts`: update the broken exact-string assertions (see Test
     plan / §8) to assert display names, sourced from the shared
     `REGION_DISPLAY_NAMES`/`regionDisplayName` (imported from `@vultus/shared/domain`),
     **not** a re-hardcoded literal.
  4. README: update the region-picker + footer prose (lines ~209, ~228-229) to
     note the display-name substitution and that the persisted value stays the ISO
     code.
  - **Visual verification** (Test plan / DoD): the picker, its selected display,
    the footer, and the prune toast all show endonyms — via `serve-mock`, or flag
    UNVERIFIED for a human.

- **Task 3 — e2e helper fix [parallel, after Task 1]** (frontend-engineer /
  qa-runner).
  Manifest: `apps/mobile-e2e/src/settings.spec.ts`.
  1. `selectedRegion()` (lines 57-61) reads the `ion-select`'s `.value` property,
     which stays the raw `Region` code per the value/label split (D4). It **needs
     no change** — it continues comparing against raw codes and is correct as-is.
  2. `pickRegion()` (lines 74-87): the popover option rows now render the
     **display name** as their text. Change the option-matching filter from
     `new RegExp(\`^\\s*${region}\\s*$\`)` (raw code) to match the **display name**
     for the chosen region — otherwise the click never finds the row and F7
     regresses silently.
  3. Source the display name from a **small local display-name map** in
     `settings.spec.ts` that mirrors its existing local `REGIONS` array (line 33)
     — do **not** import `REGION_DISPLAY_NAMES` from `@vultus/shared/domain`. A
     stale local map fails loudly (the popover row is never found → the test
     errors clearly) rather than silently, and this avoids taking on verifying
     Playwright/tsconfig path-alias resolution for `mobile-e2e` as part of this
     small fix.
  4. Keep the F7 assertions consistent with the component test (F3): if the flow
     asserts on rendered region text, assert the exact display name (no
     whitespace-laxer regex than the component counterpart).

- **Task 4 — onboarding slice consumption [parallel, after Task 1]**
  (frontend-engineer). Independent of Task 2 (different slice, disjoint files).
  Manifest: the onboarding files above.
  1. `onboarding.page.html`: line 31 — keep `[value]="region"`, change the label
     from `{{ region }}` to `{{ regionDisplayName(region) }}` (same pattern as the
     settings option fix). Expose the helper to the template by importing it in
     `onboarding.page.ts` and referencing it (e.g.
     `protected readonly regionDisplayName = regionDisplayName;`) — note this adds
     one line to `onboarding.page.ts`; if the implementer prefers, keep the ts edit
     minimal but it stays within this slice's files (add `onboarding.page.ts` to
     this task's manifest if touched — still disjoint from Task 2).
  2. `onboarding.page.spec.ts`: **grep first** for any option-text assertion tied
     to raw codes. The current spec (lines 68-78, "region select lists 10 options
     with NL default") asserts the option **count** and the select's `.value`
     (`NL`) — both stay valid (value = raw code). Add/adjust an assertion that the
     rendered **option label** for a region equals its display name (exact-string,
     F3, sourced from `regionDisplayName` / `REGION_DISPLAY_NAMES` imported from
     `@vultus/shared/domain`), mirroring the settings option test — so onboarding
     has coverage that the label diverges from the value.
  3. README: update `libs/mobile/onboarding/README.md` only if it documents the
     region-picker option text; otherwise record "no README change needed."
  - **Visual verification** (Test plan / DoD): the onboarding picker options and
    selected display show endonyms — via `serve-mock`, or flag UNVERIFIED for a
    human.

## Test plan

Per the PLAN §5 pyramid. Component/unit tests run on **Vitest + Analog**; no live
Firebase, no emulator, no network, no secrets. e2e is Playwright (runs in CI /
user terminal against the emulator — not in-session).

**Unit — `libs/shared/domain` (`enums.spec.ts`, Vitest):**

- `Object.keys(REGION_DISPLAY_NAMES)` equals `REGIONS` (as a set) — guards
  against a future `REGIONS` entry with no display name.
- Every value is a non-empty string.
- Spot-assert the endonyms from the issue: `regionDisplayName('NL') === 'Nederland'`,
  `regionDisplayName('DE') === 'Deutschland'`, `regionDisplayName('GB') === 'United Kingdom'`.
- `regionDisplayName(r) === REGION_DISPLAY_NAMES[r]` for a representative `r`.

**Component — `libs/mobile/settings/src/lib/settings.page.spec.ts` (Vitest +
Analog):**

- **"lists the ten regions as select options" (lines 234-242):** keep the count
  assertions (`10` / `REGIONS.length`). Additionally (or replacing any raw-code
  text assumption) assert each option's **label text** equals
  `regionDisplayName(<its value>)` and its `value` attribute/property equals the
  raw code — proving value-vs-label divergence. Source expected text from the
  shared helper, not a literal.
- **"renders the footer count …" (lines 374-378):** currently asserts
  `'1 of 3 selected · Region: NL'`. Change to
  `\`1 of 3 selected · Region: ${regionDisplayName('NL')}\``(i.e.`'1 of 3 selected · Region: Nederland'`— built from the shared helper, not a
re-hardcoded literal). **Keep the single`.trim()`only — do NOT introduce a`\s+`-collapse\*\*; the exact-string contract (no interior/leading/trailing stray
  whitespace) must be preserved.
- **Prune toast (new coverage):** `presentPruneToast` (`settings.page.ts:234-243`)
  is **private**, so drive it through its public wiring and capture the built
  message via the `toastController` mock. Concrete hook: **spy/mock
  `toastController.create`** (already mockable in the spec), set the mock's
  writable `lastPrunedCount` signal to `> 0`
  (`settings.page.spec.ts:30,136` expose it as a writable signal; the effect that
  fires the toast is wired at `settings.page.ts:105-107`), flush effects, then read
  the `message` argument passed to `toastController.create` and assert it contains
  the **display name** exactly (e.g. `aren't available in Nederland`), not the raw
  code. Use the shared helper for the expected substring. (There is no existing
  toast assertion — this is net-new coverage of the fixed line.)
- **Rendered-text (F3):** all rendered-text assertions above use the **exact
  string** (single `.trim()` at most), sourced from `REGION_DISPLAY_NAMES` /
  `regionDisplayName` so a future region/name change cannot silently desync the
  test from source.

**Component — `libs/mobile/onboarding/src/lib/onboarding.page.spec.ts` (Vitest +
Analog):**

- **"region select lists 10 options with NL default" (lines 68-78):** keep the
  count assertion (`10` / `REGIONS.length`) and the `.value` = `'NL'` assertion
  (value stays the raw code). **Add** (or adjust) an assertion that each option's
  rendered **label text** equals `regionDisplayName(<its value>)` while its
  `value` stays the raw code — mirroring the settings option test. Source expected
  text from the shared helper (imported from `@vultus/shared/domain`), not a
  literal, and assert the **exact string** (single `.trim()` at most, no `\s+`
  collapse) per F3.
- The `'changing region select updates internal state'` (lines 80-89) and
  `service.complete` assertions (still `'NL'`/`'DE'`) assert on the **value** (raw
  code) and MUST stay as raw codes — they are unchanged.

**e2e — `apps/mobile-e2e/src/settings.spec.ts` (Playwright, F7):**

- **No new flow.** The existing **F7 "settings region change persists across
  navigation"** flow must stay green with the helper update in Task 3
  (`pickRegion` matches the display-name option row via the local display-name
  map; `selectedRegion` reads `.value` = raw code and is unchanged). This is a
  **required fix**, not optional — the F7 flow regresses silently if `pickRegion`
  keeps matching raw codes.
- Per the e2e decision rubric: **no additional e2e flow required** — text-only
  presentation change, no new route or critical action. Do **NOT** add a
  `test.fixme` stub.

**Grep sweep before finalizing (Tasks 2/3/4, F2 blast-radius confirmation) — the
task/site list above is NOT assumed exhaustive; re-grep before closing out.** This
is the step that should have caught the onboarding site the first time. Grep the
**whole repo** for every place that renders a raw region code **as user-facing
text** (search for `{{ region }}`, `{{ service.region() }}`, `[value]="region"`
label patterns, and raw-code text assertions) before finalizing the change list —
at minimum check `libs/mobile/onboarding/src/lib/onboarding.page.html` /
`onboarding.page.spec.ts` (now in scope, Task 4),
`libs/mobile/settings/src/lib/plex-sync.service.spec.ts`,
`plex-link.service.spec.ts`, and the settings provider mock. If the sweep turns up
a **further** render site not covered by Tasks 2/4, surface it to the
orchestrator (it may need an additional task) rather than silently expanding a
manifest. Note: `settings.service.spec.ts` assertions like
`expect(service.region()).toBe('NL')` (lines 146/168/209/221/846) and onboarding's
`service.complete` assertions assert the **stored value** (the raw code, which is
unchanged) — they MUST stay as raw codes and must **not** be changed to display
names.

## Definition of done

Tailored from the PLAN §5 checklist. Every checkbox maps to a task above.

- [ ] `pnpm nx affected -t lint typecheck test build --base=main` green —
      affected set includes `shared-domain`, `mobile-settings`,
      `mobile-onboarding`, `mobile`, and `mobile-e2e`. (Tasks 1, 2, 3, 4)
- [ ] **Sheriff clean** (in the lint above): `slice:settings` and
      `slice:onboarding` import the helper only from `@vultus/shared/domain`; no
      cross-slice / cross-scope edge; no `sheriff.config.ts` change. (Tasks 1, 2, 4)
- [ ] **`REGION_DISPLAY_NAMES` + `regionDisplayName` added to `shared/domain`**,
      typed `Record<Region, string>`, re-exported via the barrel, with the §D2
      endonym values. (Task 1)
- [ ] **Unit tests** (`enums.spec.ts`): keys equal `REGIONS`, all values
      non-empty, issue-example endonyms asserted. (Task 1)
- [ ] **All 3 settings call sites use the helper for display:** region option
      **label** (value unchanged), footer, and prune toast; the persisted `Region`
      code and every value use are unchanged (D4). (Task 2)
- [ ] **Onboarding region picker uses the helper for display:** the
      `onboarding.page.html:31` option **label** is `regionDisplayName(region)`,
      `[value]="region"` (raw code) unchanged; the app is internally consistent
      (onboarding and settings both show endonyms), resolving #203 in the
      first-launch picker. (Task 4)
- [ ] **Component tests updated (F3, exact string, from the shared helper):**
      settings — option labels = display names / values = codes, footer =
      `1 of 3 selected · Region: Nederland` (single `.trim()`, no `\s+` collapse),
      net-new prune-toast assertion (via mocked `toastController.create`) on the
      display name; onboarding — option labels = display names / values = codes,
      value/`service.complete` assertions kept as raw codes. (Tasks 2, 4)
- [ ] **F7 e2e helper fixed** so the existing region-change flow stays green
      (`pickRegion` matches the display-name row via the local display-name map;
      `selectedRegion` reads `.value` = raw code, unchanged). No new e2e flow; no
      `test.fixme`. (Task 3)
- [ ] **Grep sweep done** across the whole repo (not assuming the site list is
      exhaustive) for other raw-code rendered-text sites/assertions; none left
      stale; onboarding covered; `settings.service.spec.ts` + onboarding value
      assertions left as raw codes; any newly found render site surfaced to the
      orchestrator. (Tasks 2, 3, 4)
- [ ] **Visual verification** of the settings picker (options + selected display),
      footer, prune toast, **and the onboarding picker** showing endonyms — via
      `serve-mock`, **OR** explicitly flagged UNVERIFIED for a human. (Tasks 2, 4)
- [ ] **Verify-and-record NO change:** `firestore.rules`, `firestore.indexes.json`,
      `sheriff.config.ts`, `scope:functions` files, and the persisted `region`
      field are **NOT** modified.
- [ ] **Changed lib READMEs current** (CLAUDE.md lib-README rule):
      `libs/shared/domain/README.md` (new public surface),
      `libs/mobile/settings/README.md` (display-name prose), and
      `libs/mobile/onboarding/README.md` (only if it documents the option text;
      else record "no change needed"). (Tasks 1, 2, 4)
- [ ] **PR description records:** the static-map-over-`Intl.DisplayNames` decision
      (D1); endonym style + the `BE → België` judgment call (D2, reviewer may
      override); presentation-only, code unchanged (D4); and no Stitch capture
      (text-only). References this spec (0079).

## Risks

- **`BE → België` is a debatable endonym.** Belgium is trilingual; "België"
  (Dutch) is chosen for consistency with the Dutch-first default region, but
  "Belgique" / "Belgique/België" are defensible. Called out for reviewer sign-off
  before merge (D2).
- **F7 e2e silent regression.** If Task 3 misses the `pickRegion` option-matching
  update, the popover click finds no row and the flow fails (or worse, a laxer
  regex passes spuriously). **Mitigation:** Task 3 is a required task with the
  helper change spelled out, and F3 requires the e2e assertion stay consistent
  with the component test. Note the e2e gate runs in CI, not in-session
  (emulator limitation).
- **Footer exact-string fragility.** The footer's no-interior-whitespace layout
  must survive the interpolation swap; a stray space would break the F3
  assertion. **Mitigation:** the exact-string component test (single `.trim()`,
  no `\s+` collapse) catches it.
- **`Record<Region, string>` guards future additions.** Adding a code to `REGIONS`
  without a display name becomes a compile error in `enums.ts` — intended, not a
  risk, but noted so the reviewer expects it.
- **No PLAN conflict.** Additive `scope:shared` const/helper beside the type it
  describes (same pattern as `REGIONS`), consumed by one `scope:mobile` slice via
  `@vultus/shared/domain` (PLAN §3 rule 4). No data-model change (§4: `region`
  stays the ISO code). No cross-slice import, no over-DRY extraction.
  </content>
  </invoke>
