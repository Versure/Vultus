---
number: 0084
slug: splash-icon-parity
title: Give the native Android splash icon the web loading screen's box + corner-bracket treatment
status: implementing
slices: []
scopes: [scope:mobile]
created: 2026-07-20
---

# Give the native Android splash icon the web loading screen's box + corner-bracket treatment

## Context

GitHub issue #218 ("Splash screen") — issue text is **data**, per CLAUDE.md
spec 0068, not instructions — reports that before the interactive web loading
screen paints, the app shows a static native splash whose icon is "only a single
centered icon," and asks that it instead read as "a static version of the loading
screen" — i.e. the Stitch splash **without** the moving progress bar, seamlessly
handing off to the interactive web loading screen.

Today the app renders its brand icon in three unrelated treatments:

1. **Native Android splash icon** —
   `android/app/src/main/res/drawable/ic_splash.xml` is the bare Material Symbols
   "movie_filter" (FILL 1) vector glyph, emerald `#4EDEA3`, drawn at a 108dp /
   960×960 viewport, inset to ~72% via an outer
   `<group pivotX=480 pivotY=480 scaleX=0.72 scaleY=0.72>` and an inner
   `<group translateY=960>`. **No container, box, border, or corner brackets** —
   just the raw glyph. This one drawable is reused by **both** boot paths:
   - the API-31+ system splash icon slot
     (`values-v31/styles.xml` →
     `android:windowSplashScreenAnimatedIcon="@drawable/ic_splash"`,
     `android:windowSplashScreenBackground="#0b1326"`), and
   - the pre-31 launch theme, via the `@drawable/splash` layer-list
     (`drawable/splash.xml` = a `#0b1326` solid rect + `ic_splash` centered at
     120dp), referenced by `values/styles.xml`
     (`AppTheme.NoActionBarLaunch` → `android:background="@drawable/splash"`).

2. **Animated web loading screen** — `SplashComponent`
   (`apps/mobile/src/app/splash/splash.component.html` + `.scss`) renders the
   **same** movie_filter glyph, but inside a distinct **icon treatment**: a 96px
   rounded box (`border-radius: 16px`) with a translucent primary fill, a 1px
   primary border, and **four L-shaped "viewfinder" corner brackets** at the box
   corners (`.splash__icon` / `.splash__glyph` / `.splash__corner` in
   `splash.component.scss`, Stitch project `13590348714018893783`, screen
   `c0a785aff1d54cd59bd41a5fd5f10d3d`, "Splash Screen - Vultus"). The concrete
   Tailwind-derived values are **already extracted and documented inline** in that
   file — **no new Stitch MCP fetch is needed for this spec** (see §"UI / Stitch
   screen refs"). This overlay also has backdrop stills, a vignette, a "Vultus"
   wordmark, a tagline, an animated progress bar, and cycling status text — **all
   out of scope** (see Non-goals).

3. **Header/toolbar icon** — the page headers use a _third_, unrelated icon
   (Ionicons `film-outline`). **Explicitly out of scope** — separate future work,
   already flagged elsewhere; do not fold it in.

The gap the user is describing is #1 vs #2: the native splash shows a bare glyph,
the web loading screen shows the glyph **inside a box with corner brackets**, so
the boot sequence flashes two different-looking icons instead of one continuous
splash.

**Intended outcome.** Make the native Android splash icon (#1) visually match the
**icon treatment** of the web loading screen (#2): bake the rounded box + border +
four corner brackets into `ic_splash.xml` around the existing glyph, so the native
splash reads as "a static frame of the loading screen's icon" and the native→web
handoff reads as one splash. Because the single `ic_splash.xml` drawable is shared
by both the API-31+ system splash and the pre-31 layer-list, **one drawable edit
fixes both boot paths** — no other file changes.

### Locked decisions (from the architect interview — do NOT re-litigate)

**D1. Only `ic_splash.xml`'s internal content changes.** Redesign
`android/app/src/main/res/drawable/ic_splash.xml` (a `<vector>`) so it contains,
composited in one drawable: (a) a rounded-rect box (fill = primary @ 10%), (b) a
1px-equivalent border/stroke (primary @ 20%), (c) four L-shaped corner-bracket
paths (primary @ 40%) at the box corners, and (d) the existing movie_filter glyph
path (primary, opaque), scaled/positioned inside the box at the same proportion as
the web version (glyph ≈ 58% of the box: 56 / 96). **The exact target file is
pinned in §"UI / Stitch screen refs" below — the implementer copies it, they do
not re-derive the geometry.**

**D2. No changes to the surrounding native config.** `drawable/splash.xml`
(layer-list), `values/styles.xml`, and `values-v31/styles.xml` already reference
`@drawable/ic_splash` / `@drawable/splash` correctly and use the correct `#0b1326`
background (fixed by issue #196). They stay **byte-for-byte unchanged** —
verify-and-record only. Do **not** re-open the `Theme.SplashScreen` /
`windowSplashScreen*` contract that #196 settled. The `#0b1326` splash background
and the icon placement are **not** changed.

**D3. No web-side change.** Do **not** touch `apps/mobile/src/app/splash/*`
(`SplashComponent`, its `.html`/`.scss`/`.ts`/spec). The user explicitly rejected
adding any web-side "static hold" phase or retiming the progress bar / status
text ("I do not want to add new static hold — just change the native splash
screen"). This spec **reads** `splash.component.scss` as the design source only.

**D4. Accepted, permanent visual deltas (not defects, do not track as bugs).**
Android `<vector>` / layer-list drawables have **no blur primitive**, so the web
icon's `backdrop-filter: blur(4px)` and its `box-shadow` glow
(`0 0 40px primary@15%`) are **NOT** replicated on the native icon. This is a
known, accepted, permanent delta versus the web version — call it out plainly,
do not invent a workaround (e.g. a fake gradient "glow"), and do not open a
follow-up for it.

**D5. Native-resource change only — no test file.** This is a pure Android
resource (`.xml` vector drawable) change: **no Angular / TypeScript / Firestore /
shared-domain code**, nothing importable or renderable in Vitest, no route, no
callable. **Do NOT invent a unit/component/e2e test** for it. Verification is
build + native sync gates plus a **human visual check** (see Test plan) — the
native splash cannot be rendered/screenshotted headlessly in an agent session (no
Android emulator in-session; same class of environment limitation as the Firestore
emulator).

## Scope

**In scope:**

- **`android/app/src/main/res/drawable/ic_splash.xml`** — replace its internal
  content with the box + border + four corner brackets + glyph composition pinned
  in §"UI / Stitch screen refs". This is the **only** file changed.

**Out of scope / Non-goals (state plainly in the PR):**

- **`apps/mobile/src/app/splash/*` (`SplashComponent`)** — no new "static hold"
  phase, no progress-bar / status-text retiming, no web-side change of any kind
  (D3).
- **Backdrop stills, vignette, "Vultus" wordmark, tagline, progress bar, status
  text** — none of the web overlay's chrome is replicated natively; **only** the
  icon's box/border/corner-bracket container is matched (D1).
- **Box-shadow glow and backdrop blur** on the native icon — impossible in an
  Android vector/layer-list drawable; accepted permanent delta, not tracked (D4).
- **The header `film-outline` icon** (treatment #3) — separate future work,
  already flagged elsewhere; not touched here.
- **`drawable/splash.xml`, `values/styles.xml`, `values-v31/styles.xml`** — no
  change; the `#0b1326` background, the layer-list structure, and the
  `Theme.SplashScreen` contract (issue #196) stay as-is (D2; verify-and-record).
- **Disabling / reworking the OS-managed `Theme.SplashScreen`** — stay within its
  icon + background-color contract (D2).
- **Any Angular slice, `scope:shared`, `shared/domain`, Firestore, functions,
  `firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`,
  `.github/workflows/*`, `firebase.json`, `capacitor.config.ts`, dependency
  change** — none touched (verify-and-record).

## Affected slices & Sheriff tags

**No Nx lib / no Sheriff slice is touched.** The only file is under `android/`
(the Capacitor Android platform), which is native-resource content, not a
Sheriff-tagged lib — hence `slices: []` in the frontmatter, `scopes: [scope:mobile]`
(it is the mobile app's Android platform, per PLAN §3's `android/` entry).

| Area                    | Path                                              | Sheriff tag                          | Change                                                                        |
| ----------------------- | ------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| Android native resource | `android/app/src/main/res/drawable/ic_splash.xml` | none (native res, not a Sheriff lib) | Replace internal `<vector>` content with box + border + brackets + glyph (D1) |

- **No cross-slice / cross-scope import** — there is no import at all; this is a
  static XML resource, not code. No `sheriff.config.ts` change (no new lib/tag).
  Record "no Sheriff change needed" in the PR.
- **No `shared/` extraction concern** — the box/bracket geometry is _derived from_
  (not imported from) `splash.component.scss`; the values are transcribed into the
  native drawable. There is no shared runtime code and Android XML cannot import
  the SCSS anyway (`scope:mobile` web vs. native platform). This is not a DRY
  violation — it is the native-asset mirror of a web treatment (PLAN §3).
- **No new lib → no lib README** (CLAUDE.md's lib-README rule applies to
  `libs/**`; `android/` is not a lib). Verify-and-record.

## Data model touchpoints

**None.** No Firestore collection or field is read, written, or added; no
converter, no query. Consequently:

- **`firestore.rules` — no change.** No new read/write path.
- **`firestore.indexes.json` — no change.** No new query.

Record both as "no change needed" in the PR.

## Public types / APIs

**None.** No new or changed type, no `shared/domain` field, no function signature,
no HTTP endpoint, no callable. No `scope:shared` change → **no shared-type
ripple**. The only change is the internal drawing content of one native vector
drawable.

## UI / Stitch screen refs

**Design source (no new Stitch fetch — D1):** the box/border/corner-bracket
geometry is taken from the **already-extracted, inline-documented** values in
`apps/mobile/src/app/splash/splash.component.scss` (`.splash__icon`,
`.splash__glyph`, `.splash__corner*`), whose provenance comment cites Stitch
project `13590348714018893783`, screen `c0a785aff1d54cd59bd41a5fd5f10d3d`
("Splash Screen - Vultus"). Per CLAUDE.md, this is the correct, non-stale source
for this spec — the SCSS is the checked-in, wired-up transcription of that
screen — so **no live Stitch MCP fetch is required or wanted here**. Colors are
the `--vultus-primary` emerald `#4EDEA3` (authoritative token set:
`docs/design/vultus-design-system.md` — do not hand-transcribe any other hex).

### Web treatment being matched (source of truth for the ratios)

From `splash.component.scss` (values relative to the **96px** `.splash__icon` box):

| Web element           | Web value                                                 | Ratio to 96px box |
| --------------------- | --------------------------------------------------------- | ----------------- |
| box size              | `96px` (`.splash__icon` w/h)                              | 1.000             |
| box radius            | `16px` (`border-radius`)                                  | 0.1667            |
| box fill              | `color-mix(primary 10%, transparent)`                     | primary @ 10%     |
| box border            | `1px` `color-mix(primary 20%, transparent)`               | 0.0104            |
| glyph size            | `56px` (`.splash__glyph`, `color: var(--vultus-primary)`) | 0.5833            |
| corner-bracket size   | `8px` (`.splash__corner` w/h)                             | 0.0833            |
| corner-bracket inset  | `8px` from the box edge (`top/left/right/bottom: 8px`)    | 0.0833            |
| corner-bracket stroke | `2px` (the two `border-*-width` arms)                     | 0.0208            |
| corner-bracket color  | `color-mix(primary 40%, transparent)`                     | primary @ 40%     |

### CSS → Android vector-drawable translation (chosen, pinned approach)

The drawable stays a single `<vector>` at **108dp / 960×960 viewport** (unchanged
size). Because `<vector>` has **no `<shape>`/`<corners>` primitive** (that is a
`<shape>`-drawable / layer-list feature), the box is a **`<path>`** with a
rounded-rect `pathData` carrying **both** `android:fillColor` (primary @ 10%) and
`android:strokeColor` (primary @ 20%) + `android:strokeWidth` (border). The four
corner brackets are four stroked L-shaped `<path>`s (primary @ 40%). The glyph is
the existing path, verbatim.

The whole treatment (box + brackets + glyph) is wrapped in the **existing outer
`<group pivotX=480 pivotY=480 scaleX=0.72 scaleY=0.72>`** — reusing the proven ~72%
inset the current file uses to sit correctly in the system-splash icon slot — so
the box occupies ~72% of the drawable, and the glyph sits inside the box at
`scaleX/Y = 0.5833` (= 56 / 96), i.e. ≈58% of the box, matching the web.

**Stroke-model note:** `android:strokeWidth` centers the stroke on the path
(straddles the ideal line by ±half-width), whereas the web's `border-width` /
`border-*-width` draw inside the element's edge. At this scale the visual
difference is negligible, but if the human check reads the box border or corner
brackets as very slightly heavier than the web version, that is this stroke-model
difference, not a transcription error — do not "fix" it by shrinking the
`strokeWidth`.

**Alpha hex (ARGB `#AARRGGBB`, over primary `4EDEA3`):** 10% → `#1A4EDEA3`,
20% → `#334EDEA3`, 40% → `#664EDEA3`.

**Units (960 viewport, box inset 12px from the viewport edge so the stroke is not
clipped; box = (12,12)→(948,948) = 936×936):** radius `156` (0.1667 × 936),
box stroke `10` (0.0104 × 936 ≈ 9.75), bracket size / inset `78` each
(0.0833 × 936), bracket stroke `20` (0.0208 × 936 ≈ 19.5). Corner-bracket outer
corners therefore sit 78 units inside each box corner: TL (90,90), TR (870,90),
BL (90,858), BR (870,858), with 78-unit arms.

### Pinned target file (copy verbatim into `ic_splash.xml`)

```xml
<?xml version="1.0" encoding="utf-8"?>
<!--
  Boot-splash icon — the animated web splash's ICON TREATMENT baked native (spec
  0084, issue #218): the Material Symbols "movie_filter" (FILL 1) glyph inside the
  loading screen's rounded box + 1px border + four viewfinder corner brackets, so
  the native boot splash reads as a static frame of the web SplashComponent, not a
  bare glyph. Shared by the Android 12+ system splash
  (windowSplashScreenAnimatedIcon, values-v31/styles.xml) and the pre-31 layer-list
  (@drawable/splash), so one edit fixes both boot paths.

  Geometry transcribed from apps/mobile/src/app/splash/splash.component.scss
  (.splash__icon / .splash__glyph / .splash__corner), whose provenance is Stitch
  project 13590348714018893783, screen c0a785aff1d54cd59bd41a5fd5f10d3d ("Splash
  Screen - Vultus"). Colours are the vultus-primary emerald #4EDEA3
  (docs/design/vultus-design-system.md) at the design's alpha steps: box fill 10%
  (#1A…), border 20% (#33…), corner brackets 40% (#66…). Ratios vs the web 96px
  box: radius 16/96, border 1/96, glyph 56/96, bracket size/inset 8/96, bracket
  stroke 2/96 — expressed in the 960 viewport against a 936-unit box inset 12 from
  the edge (so the stroke is not clipped).

  DELTA (accepted, permanent — NOT a bug, do not "fix"): the web icon's
  backdrop-blur and box-shadow glow have no Android vector/layer-list primitive and
  are intentionally omitted. Do not fake them.

  The outer group's 0.72 inset (pivot 480,480) is retained from the previous
  drawable — it keeps the treatment inside the system-splash icon slot; the inner
  0.5833 group sizes the glyph to ~58% of the box (56/96), matching the web.

  NOTE: `@capacitor/assets` would regenerate raster icons and could clobber this —
  re-apply this drawable if that generator is ever re-run (same caveat as splash.xml).
-->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="960"
    android:viewportHeight="960">
    <group
        android:pivotX="480"
        android:pivotY="480"
        android:scaleX="0.72"
        android:scaleY="0.72">

        <!-- Box: rounded rect, fill primary@10% + 1px-equiv border primary@20%. -->
        <path
            android:fillColor="#1A4EDEA3"
            android:strokeColor="#334EDEA3"
            android:strokeWidth="10"
            android:pathData="M168,12 H792 A156,156 0 0 1 948,168 V792 A156,156 0 0 1 792,948 H168 A156,156 0 0 1 12,792 V168 A156,156 0 0 1 168,12 Z" />

        <!-- Four viewfinder corner brackets, stroked L-shapes, primary@40%. -->
        <path
            android:strokeColor="#664EDEA3"
            android:strokeWidth="20"
            android:strokeLineCap="butt"
            android:strokeLineJoin="miter"
            android:pathData="M90,168 L90,90 L168,90" />
        <path
            android:strokeColor="#664EDEA3"
            android:strokeWidth="20"
            android:strokeLineCap="butt"
            android:strokeLineJoin="miter"
            android:pathData="M792,90 L870,90 L870,168" />
        <path
            android:strokeColor="#664EDEA3"
            android:strokeWidth="20"
            android:strokeLineCap="butt"
            android:strokeLineJoin="miter"
            android:pathData="M90,780 L90,858 L168,858" />
        <path
            android:strokeColor="#664EDEA3"
            android:strokeWidth="20"
            android:strokeLineCap="butt"
            android:strokeLineJoin="miter"
            android:pathData="M792,858 L870,858 L870,780" />

        <!-- Glyph: existing movie_filter path, verbatim, scaled to ~58% of the box. -->
        <group
            android:pivotX="480"
            android:pivotY="480"
            android:scaleX="0.5833"
            android:scaleY="0.5833">
            <group android:translateY="960">
                <path
                    android:fillColor="#4EDEA3"
                    android:pathData="m366-518-34 78-78 34 78 34 34 78 34-78 78-34-78-34-34-78Zm266-12-25 54-54 25 54 25 25 54 25-54 54-25-54-25-25-54ZM140-800l74 152h130l-74-152h89l74 152h130l-74-152h89l74 152h130l-74-152h112q24 0 42 18t18 42v520q0 24-18 42t-42 18H140q-24 0-42-18t-18-42v-520q0-24 18-42t42-18Z" />
            </group>
        </group>
    </group>
</vector>
```

### Checkable visual contract (native splash icon vs. web `.splash__icon`)

Tick these on a real device / Android Studio preview (see Test plan):

- **Box:** rounded rectangle around the glyph; corner rounding reads the same as
  the web `rounded-2xl` (16/96 of the box); fill is a faint primary tint over the
  `#0b1326` background; a thin primary border traces the box edge.
- **Corner brackets:** four L-shaped brackets, one at each box corner, inset from
  the edge, arms ≈ the web `8px` length, ~2× the box-border thickness, in a
  brighter primary than the border (40% vs 20%). **All four fully visible and not
  clipped** on both boot paths (see Risks — the API-31 mask check).
- **Glyph:** the movie_filter glyph centered in the box at ≈58% of the box width,
  opaque primary emerald — same glyph the web loading screen shows. (Note: the raw
  glyph `pathData` is marginally off geometric center — roughly 1.5–2% up-and-left
  — inherited unchanged from the current shipped drawable, issue #196. Eyeball
  "optically centered," don't expect pixel-perfect symmetry.)
- **Background:** `#0b1326`, unchanged (issue #196).
- **Accepted delta:** no blur / no glow behind the native box (D4) — this is
  expected, not a mismatch to file.
- **Continuity:** the native splash icon and the web loading screen's icon read as
  the same element across the native→web handoff.

## Implementation task graph

A **single** native-resource task, routed to **infrastructure-engineer** (per the
agent roster, infrastructure-engineer owns Capacitor Android build / native
assets — this is not an Angular-slice task, so **no** frontend-engineer task and
**no** fan-out). One task, one file → no `[parallel]`/`[sequential]` split and no
orphan-requirement risk (every DoD item maps to this one task).

### Manifest assertion (for the orchestrator)

- **Task A** writes only: `android/app/src/main/res/drawable/ic_splash.xml`.

No `android/app/src/main/res/drawable/splash.xml`,
`android/app/src/main/res/values/styles.xml`,
`android/app/src/main/res/values-v31/styles.xml`, no `apps/mobile/src/app/splash/**`,
no `libs/**`, no `firestore.rules`, no `firestore.indexes.json`, no
`sheriff.config.ts`, no `capacitor.config.ts`, and no `firebase.json` is touched.

- **Task A — native splash icon [sequential, and only task]** (infrastructure-engineer).
  Manifest: `android/app/src/main/res/drawable/ic_splash.xml`.
  1. Replace the file's content with the **pinned target file** in §"UI / Stitch
     screen refs" **verbatim** (it already carries the explanatory comment). Do
     **not** change the outer `0.72` inset group, the glyph `pathData`, or the
     `108dp` / `960×960` viewport beyond wrapping the glyph in the `0.5833` group
     as shown.
  2. Do **NOT** touch `drawable/splash.xml`, `values/styles.xml`, or
     `values-v31/styles.xml` — confirm (read only) they still reference
     `@drawable/ic_splash` / `@drawable/splash` and keep `#0b1326` (D2); record the
     confirmation in the PR.
  3. **Gates:** `pnpm nx build mobile` succeeds; `pnpm exec cap sync android`
     succeeds (build the web app first, per CLAUDE.md E1); `pnpm nx lint` green.
     Run `pnpm exec prettier --write` is **not** applicable to Android XML (not in
     the Prettier glob) — but ensure the file is saved **LF** (CLAUDE.md E2), since
     the Edit/Write tools can emit CRLF.
  4. **Human visual verification (needs-human, REQUIRED — see Test plan):** the
     agent cannot render a native splash headlessly; it must flag the visual check
     `needs-human` and not self-certify off a green build (CLAUDE.md UI-fidelity
     rule, D5).

## Test plan

Per PLAN §5, tailored to a **native Android resource change**.

**Unit / component (Vitest + Analog): none — and none invented (D5).** There is no
importable/renderable TypeScript, Angular component, or logic in this change; the
only artifact is a static Android XML drawable. **Do NOT create a test file** or a
token/spec assertion for it — there is nothing Vitest can meaningfully assert about
a native vector drawable. State this explicitly in the PR.

**Rendered-text (exact-string) assertions: not applicable** — no rendered UI copy
is added or changed (native drawable, no text).

**Build / sync gates (must pass):**

- `pnpm nx build mobile` — green.
- `pnpm exec cap sync android` — green (web app built first).
- `pnpm nx lint` — green (no Sheriff change; no lib touched).
- The Android resource still compiles into the app (the `cap sync` + a local
  Android build / install step below exercises AAPT2 parsing of the drawable —
  a malformed `pathData`/attribute would fail the Android build).

**Human visual verification (`needs-human`, REQUIRED — a green build does NOT
prove UI fidelity, per CLAUDE.md):** because no Android emulator/device is
available in an agent session (environment limitation, same class as the Firestore
emulator), the implementer **must flag the visual check `needs-human`** and NOT
report the UI as done off the build/sync gates alone. The human check (on a real
device or Android Studio's emulator / layout preview, ideally on **both** a
pre-API-31 target — exercising `@drawable/splash` — **and** an API-31+ target —
exercising `windowSplashScreenAnimatedIcon`) confirms the §"UI / Stitch screen
refs" checkable contract: box + border + four corner brackets + centered glyph on
`#0b1326`, matching the web `.splash__icon`, with **all four corner brackets
visible and not clipped** (see Risks), and the accepted no-glow/no-blur delta
(D4). Suggested path: check **Android Studio's drawable Preview / layout
inspector first** (fastest, needs no secrets, good enough for the box/border/
bracket geometry) and use `pnpm nx run mobile:android-usb` (on-device, needs a
populated `.env.local` per CLAUDE.md) for the full pre-31 + API-31+ boot-path
confirmation.

**e2e (Playwright):** **No e2e flow required — native Android resource / boot-asset
change only** (per the e2e decision rubric: no web route, no user-facing Angular
navigation or action changes; the native boot splash is outside the Playwright
web-served surface, and the emulator-backed e2e gate runs in CI / the user's
terminal, not in-session). **Do NOT add a `test.fixme` stub.** Confirm existing
e2e specs (incl. `app.boot`) are unaffected — this touches no web route, locator,
or copy.

## Definition of done

Tailored from the PLAN §5 checklist. Every checkbox maps to **Task A**.

- [ ] **`ic_splash.xml` replaced** with the pinned target file (box + 1px-equiv
      border + four corner brackets + glyph at ≈58% of the box), colours at the
      primary 10% / 20% / 40% alpha steps, `#0b1326` background untouched, outer
      `0.72` inset and glyph `pathData` preserved. (Task A)
- [ ] `pnpm nx build mobile` green. (Task A)
- [ ] `pnpm exec cap sync android` green (web built first). (Task A)
- [ ] `pnpm nx lint` green — no Sheriff / no lib change; `ic_splash.xml` is the
      only file changed. (Task A)
- [ ] File saved **LF** (no CRLF from the editor tools; CLAUDE.md E2). (Task A)
- [ ] **Human visual verification flagged `needs-human`** and, when performed,
      confirms the §"UI / Stitch screen refs" checkable contract on a device /
      Android Studio preview (pre-31 and API-31+ if available), including **all
      four corner brackets visible & not clipped**; NOT self-certified off a green
      build (D5, CLAUDE.md UI-fidelity rule). (Task A)
- [ ] **Verify-and-record NO change:** `drawable/splash.xml`,
      `values/styles.xml`, `values-v31/styles.xml`, `apps/mobile/src/app/splash/**`
      (`SplashComponent`), all `libs/**`, `firestore.rules`,
      `firestore.indexes.json`, `sheriff.config.ts`, `capacitor.config.ts`, and
      `firebase.json` are **NOT** modified — recorded in the PR. (Task A)
- [ ] **No test file invented** — recorded in the PR that a native XML drawable
      has nothing to assert in Vitest, and no e2e flow / `test.fixme` is added
      (native boot-asset change). (Task A)
- [ ] **PR description records:** the one-drawable fix covering both boot paths
      (API-31+ system splash + pre-31 layer-list); the CSS→vector translation and
      the ratios it preserves (16/96, 1/96, 56/96, 8/96, 2/96); the accepted,
      permanent no-glow/no-blur delta (D4); and references spec 0084 / issue #218.

## Risks

- **API-31+ splash icon masking could clip the box corners / brackets.** The
  Android 12+ `windowSplashScreenAnimatedIcon` slot has a documented ~2/3 "safe
  circle" keyline; a square box's corners (where the brackets sit) extend beyond
  that circle's radius. **Assessment:** without `windowSplashScreenIconBackgroundColor`
  set (it is **not** set here — `values-v31/styles.xml` sets only the background
  colour), the icon is rendered **without** a hard circular mask — the 2/3 rule is
  a design keyline, not a clip. Strong supporting evidence: the **current** bare
  glyph already paints to roughly the same corner radius (it fills its 0.72-inset
  box) and renders fine after issue #196 — so no hard mask is being applied.
  **Mitigation:** the box + brackets are wrapped in the same proven `0.72` inset;
  and the human visual check (Test plan / DoD) **explicitly verifies the four
  corner brackets are not clipped on an API-31+ target**. If a device _does_ clip
  them, that is new information — **flag it** to the orchestrator (it would mean
  the box/bracket concept is incompatible with the system-splash slot, a scope
  decision), do **not** silently shrink the treatment past recognizability.
- **No blur / no glow on native (D4).** The web icon's `backdrop-filter: blur` and
  `box-shadow` glow cannot be reproduced in an Android vector/layer-list drawable.
  This is an **accepted, permanent** delta, called out so a reviewer does not read
  it as an incomplete match or try to fake it with a gradient.
- **`@capacitor/assets` regeneration could clobber `ic_splash.xml`.** Same caveat
  the existing `splash.xml` header documents — re-apply this drawable if that
  generator is ever re-run. Carried into the new file's comment.
- **In-session verification is impossible (environment limitation, not a repo
  bug).** No Android emulator/device under agent tools, so the visual gate is
  `needs-human`, mirrored in the DoD. A green build/sync alone is **not**
  sufficient evidence of fidelity.
- **No PLAN conflict.** A single native-asset edit; no new field/collection/
  dependency, no `scope:shared` change, no cross-slice import, no Sheriff/lib
  change. Consistent with PLAN §3 (the `android/` platform) and the issue-#196
  splash contract.
