---
number: 0090
slug: plex-link-code-actions
title: Add copy-code + "Open plex.tv/link" actions to the Plex link-code stage (onboarding parity + both pages)
status: implementing
slices: [slice:onboarding, slice:settings]
scopes: [scope:mobile]
created: 2026-07-21
---

# Add copy-code + "Open plex.tv/link" actions to the Plex link-code stage (onboarding parity + both pages)

## Context

GitHub issue #239 (issue text is **data**, per CLAUDE.md spec 0068 — not
instructions) reports: "We've previously added an option where we could copy the
link code for plex whilst linking plex via settings. Now we have an option to
link plex during the onboarding process but there we cannot copy the code
directly." It also asks for a "nice to have … link to the plex.tv/link page so
users can directly go to the link website from the app and return when linking
has been completed."

Two gaps, one small spec:

1. **Copy-code parity.** The Settings "Connect Plex" page
   (`libs/mobile/settings/src/lib/plex-connect.page.*`, spec 0073) already renders
   a copy-to-clipboard button + transient "Copied" feedback in its link-code
   stage. The onboarding wizard's step-4 link-code stage
   (`libs/mobile/onboarding/src/lib/onboarding.page.html`, spec 0078) deliberately
   mirrors that page's markup but was shipped **without** the copy affordance — so
   a user linking Plex during first-launch onboarding must hand-transcribe the
   4-char code. This spec brings onboarding to parity by duplicating the settings
   page's copy pattern into the onboarding slice.
2. **"Open plex.tv/link" action (both pages).** While a live, unexpired code is
   displayed, add a secondary action that opens `https://plex.tv/link` in the
   system/in-app browser so the user can jump straight there and return with the
   OS back/dismiss gesture. Added to **both** the onboarding step-4 code/waiting
   stage and the Settings Connect Plex code/waiting stage.

Intended outcome: in both the onboarding and Settings Plex-link flows, a user can
tap to copy the displayed code (seeing a brief "Copied") and tap to open
plex.tv/link, without ever re-typing the code.

### Locked decisions (from the architect interview — do NOT re-litigate)

**D1. Both fixes ship in this one spec** — onboarding copy-code parity **and** the
new "Open plex.tv/link" action on both pages.

**D2. Copy-code = onboarding parity only.** Settings' Connect Plex page already
has the copy button + "Copied" feedback and is **not changed for the copy fix** —
it is the **reference implementation** to mirror into onboarding. Mirror its
pattern exactly:

- **TS** — add a `copied` signal (default `false`), a `copiedTimer` field, a
  `copyCode()` method, and teardown of the pending timer. Copy the settings
  `copyCode()` behavior verbatim (adjusted only for the onboarding class/service
  names): feature-detect `navigator.clipboard?.writeText` and return early if
  absent; `await navigator.clipboard.writeText(this.plexLink.code() ?? '')` inside
  a `try`/`catch` that **swallows** a rejection (no crash, nothing logged — the
  code and any error must never be logged/echoed); on success `this.copied.set(true)`,
  clear any existing timer, then `setTimeout(() => { this.copied.set(false); … }, 2000)`.
  `OnboardingPage` does **not** currently implement `OnDestroy` — add
  `implements OnDestroy` and an `ngOnDestroy()` that `clearTimeout`s the pending
  `copiedTimer` so no timer fires after teardown (matching
  `plex-connect.page.ts` L112-122). This is additive; keep the existing
  constructor `effect` / step logic untouched.
- **Template** — in the step-4 `@else if (plexLink.stage() === 'code' || … === 'waiting')`
  block (`onboarding.page.html` L256-281), add a trailing `.copy-button` inside the
  existing `.code-box` (mirroring `plex-connect.page.html` L37-44: `type="button"`,
  `class="copy-button"`, `aria-label="Copy code"`, `(click)="copyCode()"`, a
  `copy-outline` `ion-icon`), and add the conditional `@if (copied()) { <p
class="copied-feedback" role="status" data-test="copied-feedback">Copied</p> }`
  paragraph directly below the code box (mirroring `plex-connect.page.html`
  L46-50). The `copy-outline` icon must be registered via `addIcons({ … copyOutline })`.
- **SCSS** — mirror the settings page's `.code-box` (add `position: relative` — the
  onboarding `.code-box` at L344-356 currently lacks it), `.copy-button`
  (36×36 absolute-positioned trailing button with hover / `:active` press-scale /
  `:focus-visible` ring, `color-mix()` on `--vultus-*`/`--ion-*` tokens only), and
  `.copied-feedback` (label-sm, `--ion-color-primary`) rules from
  `plex-connect.page.scss` L119-192 into `onboarding.page.scss`. Use the shared
  `--vultus-*` / `--ion-*` theme vars only — **no hard-coded hex** (authoritative
  token set: `docs/design/vultus-design-system.md`; primary Emerald `#4edea3`
  is exposed as `--ion-color-primary`, never transcribed here).

**D3. Do NOT extract a shared clipboard helper.** Per CLAUDE.md's vertical-slice
rule, `slice:onboarding` and `slice:settings` each carrying its own ~15-line
`copyCode()` is **correct** — only 2 slices need it (below the 3+ extract-to-shared
threshold). This mirrors the existing, deliberate precedent that
`PlexLinkService` (settings) and `OnboardingPlexLinkService` (onboarding) are
already independent duplicated implementations of the same PIN-link flow (spec
0078 decision 5). **Do not** merge them or introduce a `shared/ui-kit` clipboard
service.

**D4. "Open plex.tv/link" button — BOTH pages, code/waiting stage ONLY.** Add to
the `stage-code` section of both `plex-connect.page.*` and `onboarding.page.*`
(the same block being touched for the copy fix). Do **NOT** add it to the
idle / connected / error stages — it is only useful while a live, unexpired code
is displayed.

**D5. Mechanism: `@capacitor/browser` (NEW dependency).** Add `@capacitor/browser`
and call `Browser.open({ url: 'https://plex.tv/link' })` directly from each page
component (a new `openPlexLink()` method). **No native/mock guard is needed** —
unlike `PlexBackgroundService` (native-guarded for background tasks),
`@capacitor/browser`'s **web implementation opens a new tab via `window.open`**,
so it works unmodified in `serve-mock`/web and needs **no**
`Capacitor.isNativePlatform()` branch or mock shell. The implementer must **not**
invent a native guard for this call. After `Browser.open`, **no** explicit
"return" handling is required: the OS/in-app-browser's own back/dismiss gesture
returns the user to Vultus, still showing the same code/waiting stage (or a
since-expired one) exactly as before — no new event/lifecycle wiring.

**D6. No Stitch mockup exists for the "Open plex.tv/link" button** (the issue
post-dates the locked Connect-Plex screen `398cde766832491e92e1c0c5cc09ab4e`,
spec 0073). Per CLAUDE.md's UI-fidelity rule this is **explicitly flagged as
UNVERIFIED against Stitch** rather than silently token-styled and reported as
Stitch-faithful. Style it as a **small, secondary/text-style** button that does
**not** compete with the primary "Get a new code" `.solid-button`: reuse the
existing `.text-button-muted` treatment (already used for "Cancel" in
`plex-connect.page.scss` L297-318). On the **settings** page `.text-button-muted`
already exists — reuse it. On the **onboarding** page it does **not** exist — add
an equivalent `.text-button-muted` rule (copy the settings rule) so the class name
and treatment match across both pages. Include a leading `open-outline`
Ionicon for affordance (registered via `addIcons`). Give the button
`data-test="open-plex-link"`. Placement: within the `stage-code` section, below
the code box / "Copied" feedback and the expiry line, near the "Get a new code"
solid button (implementer's call within that vertical flow), consistent with the
stage card's rhythm. See **Definition of done** for the explicit "UNVERIFIED — no
Stitch mockup; sanity-check on serve-mock" gate.

**D7. Testing = component-level only, NO new e2e** (see Test plan for rationale).

## Scope

**In scope:**

- **`libs/mobile/onboarding`** (`slice:onboarding`): copy-code parity (TS signal +
  `copyCode()` + `OnDestroy` timer teardown + `copyOutline` icon; template
  `.copy-button` + `.copied-feedback`; SCSS `.code-box position:relative` +
  `.copy-button` + `.copied-feedback`) **and** the "Open plex.tv/link" button
  (`openPlexLink()` + `Browser.open`; template button + `open-outline` icon; SCSS
  `.text-button-muted`) — code/waiting stage only. Plus component tests.
- **`libs/mobile/settings`** (`slice:settings`): the "Open plex.tv/link" button
  only (`openPlexLink()` + `Browser.open`; template button reusing existing
  `.text-button-muted`; `open-outline` icon) — code/waiting stage only. Plus a
  component test. **No copy-code change** (already present).
- **Root `package.json` + pnpm lockfile**: add the `@capacitor/browser`
  dependency.

**Out of scope (verify-and-record "no change needed"):**

- The Settings copy-code button / `copyCode()` / "Copied" feedback — already
  shipped (spec 0073); unchanged.
- Any change to the idle / connected / error stages on either page.
- Any `PlexLinkService` / `OnboardingPlexLinkService` behavior change (they are
  read-only from the pages here — `.code()` is consumed, nothing new added). No
  merge/extraction of the two services (D3).
- A shared clipboard/browser helper in `scope:shared` (D3).
- `shared/domain` / `shared/firestore-schema` (no type or `User` field change),
  `firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`,
  `firebase.json`, `apps/functions/**`, any Cloud Function.
- Any new or changed e2e flow (D7).
- Any native Android config beyond installing the plugin (`@capacitor/browser`
  self-registers via the Capacitor plugin mechanism on `cap sync`; no manual
  registration code is written by this spec).

## Affected slices & Sheriff tags

| Project           | Path                     | Sheriff tags                       | Change                                                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| mobile-onboarding | `libs/mobile/onboarding` | `scope:mobile`, `slice:onboarding` | `onboarding.page.ts`: `copied` signal + `copyCode()` + `OnDestroy` + `openPlexLink()` + icons. `onboarding.page.html`: copy button + "Copied" + "Open plex.tv/link". `onboarding.page.scss`: copy-button/feedback + text-button-muted. `onboarding.page.spec.ts`: new tests. `README.md` if API note needed. |
| mobile-settings   | `libs/mobile/settings`   | `scope:mobile`, `slice:settings`   | `plex-connect.page.ts`: `openPlexLink()` + `open-outline` icon. `plex-connect.page.html`: "Open plex.tv/link" button. `plex-connect.page.scss`: (reuses existing `.text-button-muted`; no new rule expected). `plex-connect.page.spec.ts`: new test.                                                         |
| (root)            | `package.json`, lockfile | (workspace root; not slice-tagged) | Add `@capacitor/browser`.                                                                                                                                                                                                                                                                                    |

- **No cross-slice / cross-scope import.** Each `scope:mobile` slice owns its own
  page files and its own `copyCode()`/`openPlexLink()`. `slice:onboarding`
  imports only `@vultus/shared/*` + itself + third-party (Ionic, ionicons,
  `@capacitor/browser`); likewise `slice:settings`. No `slice:onboarding` ↔
  `slice:settings` edge is introduced.
- **No `shared/` extraction** — the duplicated `copyCode()` (2 slices) and the
  duplicated `openPlexLink()` (2 slices) are both **below** the 3+-slice
  extraction threshold (PLAN §3 / D3). Duplication inside slices is correct here.
- **No `sheriff.config.ts` change** — no new lib, no new tag; the existing path
  globs already tag `libs/mobile/onboarding/src` and `libs/mobile/settings/src`.
  `@capacitor/browser` is third-party and importable by any `scope:mobile` slice.
  Record "no `sheriff.config.ts` change needed" in the PR.

## Data model touchpoints

**None.** No Firestore collection or field is read, written, or added by this
change; no converter change. The pages consume the already-exposed
`PlexLinkService.code()` / `OnboardingPlexLinkService.code()` signals only.
Consequently:

- **`firestore.rules` — no change.** No new read/write path.
- **`firestore.indexes.json` — no change.** No new query.

Record both as "no change needed" in the PR.

## Public types / APIs

**None (no `scope:shared` change).** No new or changed exported type, no
`shared/domain` field, no function signature, HTTP endpoint, or callable. The
public barrels of `@vultus/mobile/onboarding` (`OnboardingPage`, …) and
`@vultus/mobile/settings` (`PlexConnectPage`, …) keep the same exported symbols;
the new `copyCode()` / `openPlexLink()` are `protected` component members, not
barrel-exported API.

- **F2 shared-type ripple — N/A.** No `scope:shared` type is widened or made
  required; no shared object literal changes.
- **F4 onboarding/User-field parity — N/A.** No field is added to or changed on
  the `User` domain type (`@vultus/shared/domain`'s `documents.ts`); no persisted
  preference is introduced. This is a pure in-stage UI affordance (copy code /
  open a URL), so the onboarding-parity rule does not apply. (Ironically, the
  feature itself _improves_ the onboarding Plex-link step — but it persists
  nothing new.)

**New dependency:** `@capacitor/browser`. Match the exact-pin convention of the
sibling `@capacitor/*` deps in `package.json` (they are pinned exact — e.g.
`"@capacitor/app": "8.1.0"`, `"@capacitor/core": "8.4.0"` — **not** caret ranges);
add the **latest 8.x** `@capacitor/browser` compatible with the installed
Capacitor 8 core, pinned exact in the same style. `Browser.open` is called as
`Browser.open({ url: 'https://plex.tv/link' })`.

## UI / Stitch screen refs

**Two elements. One (copy button) has an existing in-repo Stitch-aligned
reference; the other ("Open plex.tv/link") has NO Stitch mockup and is flagged
UNVERIFIED.**

Reference Stitch screen: **`398cde766832491e92e1c0c5cc09ab4e`** ("Connect Plex -
Vultus", spec 0073) — the source of the Settings Connect Plex page's markup, which
the onboarding step-4 stage already mirrors. All tokens are the shared `--vultus-*`
/ `--ion-*` theme vars (authoritative set: `docs/design/vultus-design-system.md`
— **not** transcribed here; primary Emerald `#4edea3` is `--ion-color-primary`).

### Copy button + "Copied" feedback (onboarding) — Stitch-aligned via the in-repo settings reference

Mirror `plex-connect.page.{html,scss}` exactly. Per-element contract (values from
the already-shipped settings implementation, `plex-connect.page.scss` L119-201):

- **`.code-box`** — `position: relative` (anchors the copy button),
  `surface-container-high` fill, `--vultus-radius` (0.5rem), hairline
  `outline-variant` border, full width, `--vultus-space-md`/`-lg` padding. Onboarding's
  current `.code-box` (L344-356) is identical **except** it lacks `position: relative`
  — add it.
- **`.code-value`** — display-lg-mobile (28px / 700), `--ion-color-primary`,
  letter-spacing `0.15em` (unchanged; already present).
- **`.copy-button`** — **36×36**, `position: absolute; right: --vultus-space-sm;
top: 50%; transform: translateY(-50%)`, transparent background, `--vultus-radius`,
  20px icon. **States:** default icon `--vultus-on-surface-variant`; **hover** →
  background `color-mix(--vultus-surface-container-highest 50%, transparent)`, icon
  `--vultus-on-surface`; **active** → `translateY(-50%) scale(0.95)`;
  **focus-visible** → `outline: 2px solid --ion-color-primary; outline-offset: 2px`.
  Transitions: `background 150ms ease-in-out, transform 100ms ease-in-out`; icon
  `color 150ms ease-in-out`. `aria-label="Copy code"`.
- **`.copied-feedback`** — label-sm, `--ion-color-primary`; rendered only while
  `copied()` is true; `role="status"`, `data-test="copied-feedback"`; exact text
  **`Copied`**.

### "Open plex.tv/link" button (both pages) — NO STITCH MOCKUP → UNVERIFIED

- **Structure:** a `<button type="button">` (not an `ion-button`), with a leading
  `open-outline` `ion-icon` + the text **`Open plex.tv/link`**, `data-test="open-plex-link"`,
  `(click)="openPlexLink()"`.
- **Style:** reuse **`.text-button-muted`** — a text-style button, label-md,
  `--vultus-on-surface-variant`, transparent, **no** solid fill (so it does not
  compete with the primary "Get a new code" `.solid-button`). **States:** default
  `--vultus-on-surface-variant`; **hover** → `--vultus-on-surface`;
  **focus-visible** → `outline: 2px solid --ion-color-primary; outline-offset: 2px`
  (per `plex-connect.page.scss` L297-318). Settings reuses the existing class;
  onboarding adds an equivalent `.text-button-muted` rule (copy the settings rule).
  The leading icon inherits the label color (add an `ion-icon` size/margin rule if
  needed for alignment, consistent with the label-md line-height).
- **Placement:** inside the `stage-code` section, below the `.code-box` /
  `.copied-feedback` and the `.code-expiry` line, near the "Get a new code"
  `.solid-button` (implementer's call within that vertical flow).
- **UI-fidelity flag (REQUIRED, CLAUDE.md):** there is **no** Stitch screen for
  this button (issue post-dates the locked screen). Do **not** claim Stitch
  fidelity for it. Its visual placement/treatment must be **sanity-checked on
  `pnpm nx run mobile:serve-mock`** (screenshot or manual look on both the
  onboarding step-4 code stage and the Settings Connect Plex code stage) **or**
  explicitly flagged **UNVERIFIED for a human eyeball** before merge — a green
  build does not prove it looks right. This is a Definition-of-done gate.

## Implementation task graph

Four tasks. **Task 0** (dependency) is `[sequential]` — the two page tasks import
`@capacitor/browser`, which must be in `package.json`/lockfile and installed
first. **Tasks A, B** are then `[parallel]` (disjoint slice manifests). Task 0's
worktree `pnpm install` follows the CLAUDE.md worktree conventions (fresh feature
worktree has no `node_modules`; on the Windows `firebase-tools` semver bin-link
failure re-run with `--config.bin-links=false`; the lockfile is spliced, not
regenerated — CI pins pnpm 9, see memory) and is done by the feature-implementer
in the **feature** worktree at implementation time (this spec worktree needs no
install).

### Manifest assertion (for the orchestrator)

- **Task 0** writes only: `package.json`, `pnpm-lock.yaml`.
- **Task A** (onboarding) writes only:
  - `libs/mobile/onboarding/src/lib/onboarding.page.ts`
  - `libs/mobile/onboarding/src/lib/onboarding.page.html`
  - `libs/mobile/onboarding/src/lib/onboarding.page.scss`
  - `libs/mobile/onboarding/src/lib/onboarding.page.spec.ts`
  - `libs/mobile/onboarding/README.md` (only if a public-behavior note is warranted)
- **Task B** (settings) writes only:
  - `libs/mobile/settings/src/lib/plex-connect.page.ts`
  - `libs/mobile/settings/src/lib/plex-connect.page.html`
  - `libs/mobile/settings/src/lib/plex-connect.page.scss` (likely unchanged — reuses
    existing `.text-button-muted`; edit only if an icon-alignment tweak is needed)
  - `libs/mobile/settings/src/lib/plex-connect.page.spec.ts`
  - `libs/mobile/settings/README.md` (only if a public-behavior note is warranted)

Task A and Task B manifests are **pairwise disjoint** (`libs/mobile/onboarding/**`
vs `libs/mobile/settings/**`). Both depend on Task 0 (`package.json`/lockfile), so
Task 0 is `[sequential]` and must finish before A/B fan out. No `libs/shared/**`,
`firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`, or
`firebase.json` is touched by any task.

### Task 0 — add `@capacitor/browser` dependency (infrastructure/frontend) `[sequential]`

Manifest: `package.json`, `pnpm-lock.yaml`.

1. Add `@capacitor/browser` to `dependencies` in `package.json`, pinned exact at
   the latest 8.x compatible with Capacitor 8 core (match the sibling exact-pin
   style — no caret).
2. Install in the feature worktree per CLAUDE.md worktree conventions
   (`pnpm install`, `--config.bin-links=false` on the Windows semver failure;
   splice the new dep block onto the committed pnpm-9 lockfile rather than letting
   pnpm 11 reformat it — memory "pnpm version mismatch"). Validate with a clean
   `corepack pnpm@9 install --frozen-lockfile`.
3. `pnpm exec cap sync android` will self-register the native plugin at
   build/sync time (no manual registration code). No `capacitor.config` change is
   required for `@capacitor/browser`.

### Task A — onboarding copy-code parity + "Open plex.tv/link" (frontend-engineer) `[parallel]`

Manifest: the onboarding files above. Depends on Task 0.

1. **`onboarding.page.ts`:** add `implements OnDestroy` (+ `type OnDestroy`
   import); add `protected readonly copied = signal(false)` and a private
   `copiedTimer` field; add `copyCode()` mirroring `plex-connect.page.ts` L143-161
   (feature-detected, try/catch-swallowed, 2s `copied` reset, nothing logged),
   reading `this.plexLink.code() ?? ''`; add `ngOnDestroy()` clearing the pending
   timer (mirror L112-122, minus the settings-only `link.cancel()` — onboarding's
   existing skip/back already cancel the poll). Add `openPlexLink()` that calls
   `Browser.open({ url: 'https://plex.tv/link' })` (import `Browser` from
   `@capacitor/browser`; fire-and-forget with `void`, no native guard — D5).
   Register the new icons: `addIcons({ …, copyOutline, openOutline })`.
2. **`onboarding.page.html`:** in the `stage === 'code' || 'waiting'` block
   (L256-281) add the trailing `.copy-button` inside `.code-box` and the
   conditional `.copied-feedback` paragraph below it (mirror
   `plex-connect.page.html` L35-50), and add the "Open plex.tv/link"
   `.text-button-muted` button with a leading `open-outline` icon and
   `data-test="open-plex-link"` (D4/D6 placement).
3. **`onboarding.page.scss`:** add `position: relative` to `.code-box` (L344);
   add `.copy-button` and `.copied-feedback` rules (mirror `plex-connect.page.scss`
   L136-192); add a `.text-button-muted` rule (copy `plex-connect.page.scss`
   L297-318) since onboarding lacks it, plus an icon-alignment tweak if needed.
   Tokens only — no hex.
4. **`onboarding.page.spec.ts`:** add tests (see Test plan). The existing spec
   already stubs the mocked `OnboardingPlexLinkService` with a `code` signal; set
   it to a known value for the copy test and mock `@capacitor/browser`.
5. **`README.md`:** add a one-line note only if the lib's public-behavior summary
   would otherwise read as stale (the `copyCode`/`openPlexLink` are internal
   component members, so a README change may not be warranted — verify and record).

### Task B — settings "Open plex.tv/link" (frontend-engineer) `[parallel]`

Manifest: the settings files above. Depends on Task 0.

1. **`plex-connect.page.ts`:** add `openPlexLink()` calling
   `Browser.open({ url: 'https://plex.tv/link' })` (import `Browser` from
   `@capacitor/browser`; `void`, no native guard). Register `openOutline` via the
   existing `addIcons({ … })` call.
2. **`plex-connect.page.html`:** add the "Open plex.tv/link" `.text-button-muted`
   button with a leading `open-outline` icon + `data-test="open-plex-link"` inside
   the `stage-code` section (D4/D6 placement). Reuses the existing
   `.text-button-muted` class.
3. **`plex-connect.page.scss`:** likely **no change** (reuses existing
   `.text-button-muted`); edit only for a leading-icon alignment tweak if needed.
4. **`plex-connect.page.spec.ts`:** add a test for the new button (see Test plan);
   mock `@capacitor/browser`.
5. **`README.md`:** one-line note only if warranted (verify and record).

## Test plan

Per the PLAN §5 pyramid. Component/unit on **Vitest + Analog** (no live Firebase,
no emulator, no network, no secrets). **No e2e** (see rubric below).

**Mocking `@capacitor/browser`:** mirror the repo's existing Capacitor-plugin
mocking house style (as used in the Plex specs, e.g. how
`plex-background.service.spec.ts` / the page specs mock `@capacitor/*` modules) —
`vi.mock('@capacitor/browser', () => ({ Browser: { open: vi.fn() … } }))` (or the
equivalent already-used form), and assert `Browser.open` was called with
`{ url: 'https://plex.tv/link' }` on click. **Clipboard** is stubbed exactly as
in `plex-connect.page.spec.ts` L95-104 (`Object.defineProperty(navigator,
'clipboard', { value: { writeText }, configurable: true })`), fresh per test.

**Component — `onboarding.page.spec.ts` (Task A):**

- **Copy parity (mirrors `plex-connect.page.spec.ts` L142-155):** with the mocked
  `plexLink.stage` set to `'code'` and `plexLink.code` set to a known value (e.g.
  `'H7X2'`), assert `[data-test="copied-feedback"]` is absent initially; click the
  `.copy-button`; after `whenStable()` + `detectChanges()`, assert `writeText` was
  called with the exact code (`'H7X2'`) and that the feedback element's
  `.textContent` equals **`'Copied'`** — **F3: exact string, `.toBe('Copied')`,
  NOT whitespace-normalized** (match the settings spec's exactness; note the
  settings spec uses `?.textContent?.trim()` which trims only leading/trailing
  edges — mirror that exact form, do not add interior `\s+`→`' '` normalization).
- **Copy is resilient:** clicking `.copy-button` when `navigator.clipboard` is
  absent (delete the stub for one test) does not throw and does not show "Copied".
- **"Open plex.tv/link" (F3 exact-text):** with `stage === 'code'`, assert the
  `[data-test="open-plex-link"]` button renders with exact text **`Open
plex.tv/link`**; clicking it calls the mocked `Browser.open` once with
  `{ url: 'https://plex.tv/link' }`.
- **Stage-scoping:** assert the copy button and the "Open plex.tv/link" button are
  **present** in the `code`/`waiting` stage and **absent** in `idle` / `connected`
  / `error` stages (D4).
- Existing onboarding specs (wizard nav, skip, finish) stay green — the additions
  are inside step 4's code/waiting stage and do not alter step-progress copy,
  `.wizard-cta`/`.wizard-skip`/`.wizard-back`, or the existing stage `data-test`s.

**Component — `plex-connect.page.spec.ts` (Task B):**

- **"Open plex.tv/link" (F3 exact-text):** with `stage === 'code'`, assert the
  `[data-test="open-plex-link"]` button renders with exact text **`Open
plex.tv/link`**; clicking it calls the mocked `Browser.open` once with
  `{ url: 'https://plex.tv/link' }`.
- **Stage-scoping:** the button is present in `code`/`waiting` and absent in
  `idle`/`connected`/`error` (D4).
- The existing copy-code test (L142-155) and all other existing settings specs
  stay green (unchanged behavior).

**e2e (Playwright) — NONE (rubric: Not required for these flows).** Both new
buttons live **entirely inside** the Plex link-code/waiting stage, which is
**already explicitly excluded** from e2e coverage: `apps/mobile-e2e/src/onboarding.spec.ts`
(header, L26-29) documents that "the REAL Plex PIN generation + LAN server
discovery (step 4)" is device-only and NOT asserted — only navigating into step 4
and "Skip for now" is exercised. No live code is ever displayed in the browser
harness, so a copy/open-link e2e cannot reach these buttons. This is a
UI-affordance addition to an already-excluded stage, not a new primary navigation
route or critical persisted action. **No e2e task is added, and this omission is
intentional** (stated here so a reviewer does not flag it as a gap).

## Definition of done

Tailored from the PLAN §5 checklist. Every checkbox maps to a task (0 / A / B).

- [ ] `pnpm nx affected -t lint typecheck test build --base=main` green — affected
      set is `mobile-onboarding`, `mobile-settings`, and `mobile`. (Task 0, A, B)
- [ ] **Sheriff clean** (in the lint above): no new import edge, no cross-slice /
      cross-scope import; `slice:onboarding` and `slice:settings` each import only
      `@vultus/shared/*` + itself + third-party (incl. `@capacitor/browser`); no
      `sheriff.config.ts` change. (Task A, B)
- [ ] **`@capacitor/browser` added** to `package.json` (exact pin, latest 8.x
      matching sibling convention) and the pnpm lockfile updated by **splice** onto
      the committed pnpm-9 lockfile; a clean `corepack pnpm@9 install
    --frozen-lockfile` passes. `cap sync android` self-registers the plugin.
      (Task 0)
- [ ] **Onboarding copy parity:** `copied` signal + `copyCode()` (feature-detected,
      try/catch-swallowed, 2s reset, nothing logged) + `implements OnDestroy` with
      timer teardown + `copy-outline` icon registered; `.copy-button` inside
      `.code-box` (now `position: relative`) + conditional `.copied-feedback`
      paragraph; SCSS mirrors the settings page. (Task A)
- [ ] **"Open plex.tv/link" button on BOTH pages** (code/waiting stage only):
      `openPlexLink()` → `Browser.open({ url: 'https://plex.tv/link' })` with **no**
      native guard; `.text-button-muted` secondary button + leading `open-outline`
      icon + `data-test="open-plex-link"`; NOT added to idle/connected/error.
      (Task A, B)
- [ ] **Component tests** (Vitest + Analog): onboarding copy test asserts
      `writeText(code)` + feedback text **exactly** `'Copied'` (F3, edge-trim only,
      no interior normalization); onboarding + settings "Open plex.tv/link" tests
      assert exact button text `Open plex.tv/link` and `Browser.open` called once
      with `{ url: 'https://plex.tv/link' }`; stage-scoping tests (present in
      code/waiting, absent elsewhere); all existing specs on both pages stay green.
      (Task A, B)
- [ ] **No e2e change** — both buttons live inside the already-e2e-excluded Plex
      code stage; omission is intentional and recorded (Test plan). (N/A)
- [ ] **Data-model / shared — verify-and-record NO change:** no `shared/domain`
      type or `User` field (F2 & F4 N/A), no `firestore.rules`,
      `firestore.indexes.json`, `sheriff.config.ts`, `firebase.json`,
      `apps/functions/**`, or Cloud Function touched; no shared clipboard/browser
      helper introduced (D3). (Task A, B)
- [ ] **UI fidelity (CLAUDE.md):** the copy button mirrors the Stitch-aligned
      settings reference (screen `398cde766832491e92e1c0c5cc09ab4e`); the "Open
      plex.tv/link" button has **NO Stitch mockup** and is **explicitly flagged
      UNVERIFIED against Stitch** — its placement/treatment is sanity-checked on
      `pnpm nx run mobile:serve-mock` (both the onboarding step-4 code stage and
      the Settings Connect Plex code stage) via screenshot/manual look, **or**
      explicitly flagged UNVERIFIED for a human eyeball in the PR. A green build is
      **not** sufficient. (Task A, B)
- [ ] **Lib READMEs** (`libs/mobile/onboarding/README.md`,
      `libs/mobile/settings/README.md`) reviewed; updated if the public-behavior
      summary would otherwise read as stale, else recorded as "no change needed".
      (Task A, B)

## Risks

- **`@capacitor/browser` web behavior.** The chosen no-native-guard approach (D5)
  relies on the plugin's web implementation opening a new tab via `window.open`, so
  the button works in `serve-mock`/web and on device without a platform branch. If
  the installed 8.x version's web behavior differs (e.g. requires a user gesture
  that the synthetic test click doesn't satisfy), the **component test still passes**
  because it asserts against the **mocked** `Browser.open` — the real behavior is
  covered by the serve-mock sanity check. Mitigation: keep the call fire-and-forget
  (`void`) so a rejected web open never surfaces as an unhandled rejection; verify
  on serve-mock.
- **"Open plex.tv/link" has no Stitch design.** Its placement/treatment is
  inferred (reuse `.text-button-muted`) and flagged UNVERIFIED (D6). Mitigation: it
  deliberately uses an existing, in-repo, Stitch-derived token treatment and is
  gated on a serve-mock look / human eyeball before merge — not shipped as
  Stitch-faithful.
- **pnpm lockfile / CI pnpm-9 divergence.** Adding a dependency risks the
  pnpm-11-local-vs-pnpm-9-CI lockfile reformat (memory). Mitigation: splice the new
  dep block onto the committed lockfile and validate with `corepack pnpm@9 install
--frozen-lockfile` (Task 0), not a full local regenerate.
- **No PLAN conflict.** A UI-affordance addition to two existing `scope:mobile`
  slices plus one root dependency; no `scope:shared` change, no cross-slice import,
  no `User` field (F4 N/A), no data-model change. The intentional `copyCode()` /
  `openPlexLink()` duplication across 2 slices is consistent with PLAN §3
  vertical-slice (below the 3+ extraction threshold).
  </content>
  </invoke>
