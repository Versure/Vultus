# shared-ui-kit

`@vultus/shared/ui-kit` is Vultus's shared UI foundation. Today it carries the
**global theming contract** — the "Vultus Design System" Stitch tokens (PLAN §2)
as SCSS / CSS custom properties. Future **truly-shared Ionic atom components**
will live here too, but only once the same atom is needed by **3+ slices**
(CLAUDE.md / PLAN §3 — no premature extraction; duplication inside a slice is
fine).

## Public surface

- **`src/lib/theme.scss`** — the design-system token file (the consumable
  theming surface). Defines, under `:root`, the Stitch tokens as CSS custom
  properties and the Ionic theme variables they map onto:
  - **Primary** Emerald `#10B981` → `--ion-color-primary` (+ `-rgb` / `-shade` /
    `-tint` / `-contrast`).
  - **Surfaces** navy-slate → `--ion-background-color` `#0F172A`,
    `--vultus-surface-elevated` `#1E293B`, plus `--vultus-surface-overlay`,
    `--vultus-border`, and text tokens (`--ion-text-color`, `--vultus-text-muted`).
  - **Typography** Inter-first stack → `--vultus-font-family` / `--ion-font-family`
    (family stack only — no web-font `@import`/CDN).
  - **Spacing** 8px grid → `--vultus-space-1`…`--vultus-space-6`.
  - **Radius** 0.5rem default → `--vultus-radius` (+ `-sm` / `-md` / `-lg` /
    `-pill`).
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
