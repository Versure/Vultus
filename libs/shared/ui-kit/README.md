# shared-ui-kit

`@vultus/shared/ui-kit` is Vultus's shared UI foundation. Today it carries the
**global theming contract** — the "Vultus Design System" tokens as SCSS / CSS
custom properties. The **authoritative token values live at
`docs/design/vultus-design-system.md`** (exported from the Stitch project); this
lib's `theme.scss` is the runtime wiring of that doc. When the design system
changes, update the doc and re-map `theme.scss` from it — never edit a hex here
from memory. Future **truly-shared Ionic atom components** will live here too, but
only once the same atom is needed by **3+ slices** (CLAUDE.md / PLAN §3 — no
premature extraction; duplication inside a slice is fine).

## Public surface

- **`src/lib/theme.scss`** — the design-system token file (the consumable
  theming surface). Defines, under `:root`, the design tokens as CSS custom
  properties and the Ionic theme variables they map onto:
  - **Primary** Emerald `#4edea3` → `--ion-color-primary` / `--vultus-primary`
    (+ `-rgb` / `-shade` / `-tint` / `-contrast` = `on-primary` `#003824`). Note:
    `#10B981` is `--vultus-primary-container`, **not** primary.
  - **Surfaces** deep-navy **tonal ramp** → `--ion-background-color` /
    `--vultus-surface` `#0b1326`, then `--vultus-surface-container-low` `#131b2e`,
    `--vultus-surface-container` `#171f33`, `--vultus-surface-container-high`
    `#222a3d`, `--vultus-surface-container-highest` `#2d3449`. Back-compat aliases
    `--vultus-surface-elevated` (→ container), `--vultus-surface-overlay` (→
    highest), `--vultus-border` (→ `outline-variant` `#3c4a42`) are kept.
  - **Text** → `--ion-text-color` / `--vultus-on-surface` `#dae2fd`,
    `--vultus-on-surface-variant` / `--vultus-text-muted` `#bbcabf`.
  - **Typography** Inter-first stack → `--vultus-font-family` / `--ion-font-family`
    (the web-font itself is loaded by the Google Fonts link in
    `apps/mobile/src/index.html`), plus a type scale `--vultus-text-*`
    (`label-sm` 11/500 … `display-lg` 32/700) mirroring the design doc.
  - **Spacing** 8px grid → named `--vultus-space-{xs,sm,md,lg,xl}` and the
    legacy `--vultus-space-1`…`--vultus-space-6` scale.
  - **Radius** 0.5rem default → `--vultus-radius` (+ `-sm` / `-md` / `-lg` /
    `-xl` / `-pill`).
  - **Semantic watchlist status colors** → `--vultus-status-watching` `#3B82F6`,
    `--vultus-status-completed` `#10B981`, `--vultus-status-dropped` `#EF4444`,
    `--vultus-status-planned` `#94A3B8` (the watchlist `status` field maps to
    these; later slices consume them).
- **`src/index.ts`** — the TS barrel. Exports `SHARED_UI_KIT_THEME_PATH`
  documenting the SCSS entrypoint and keeping the barrel non-empty/lint-clean.
  Shared atom components will be added here when the 3+-slice rule is met.

## Usage

The theme is **dark-first** and is applied app-wide. It is registered as a
separate entry in the `styles` array of `apps/mobile/project.json`:

```json
"styles": [
  "apps/mobile/src/styles.scss",
  "libs/shared/ui-kit/src/lib/theme.scss"
]
```

Loading it as a second Angular styles entry (rather than via a Sass `@use`/`@import`
inside `styles.scss`) keeps the Ionic core imports free of Sass deprecation warnings
and guarantees `theme.scss` is compiled **after** the Ionic dark palette, so its
`:root` custom properties win any cascade conflicts on shared Ionic variables.

Slice components reference the `--vultus-*` / `--ion-*` variables directly in their
own SCSS — they do **not** re-declare tokens.

## Sheriff scope

`scope:shared` — importable by **anyone** (`scope:mobile`, `scope:functions`,
other shared libs). It imports nothing else. The theme is plain CSS variables,
so no TypeScript cross-scope boundary is crossed.

## Running unit tests

Run `nx test shared-ui-kit` (Vitest). The lib is theming-only today, so the
suite passes with no tests (`passWithNoTests`).
