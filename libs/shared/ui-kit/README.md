# shared-ui-kit

`@vultus/shared/ui-kit` is Vultus's shared UI foundation. It carries two things:
the **global theming contract** — the "Vultus Design System" tokens as SCSS / CSS
custom properties — and a small set of **standalone Angular atom components** for
the empty / loading / error states that all mobile slices share. The
**authoritative token values live at `docs/design/vultus-design-system.md`**
(exported from the Stitch project); this lib's `theme.scss` is the runtime wiring
of that doc. When the design system changes, update the doc and re-map
`theme.scss` from it — never edit a hex here from memory. Atom components live
here only once the same atom is needed by **3+ slices** (CLAUDE.md / PLAN §3 — no
premature extraction; duplication inside a slice is fine); the state atoms below
qualify (watchlist, search, title-detail).

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
  - **Error** (design-doc `error` family) → `--vultus-error` `#ffb4ab`,
    `--vultus-on-error` `#690005`, `--vultus-error-container` `#93000a`,
    `--vultus-on-error-container` `#ffdad6` (consumed by error-state UI such as
    `VultusErrorState`).
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
  (documenting the SCSS entrypoint) plus the four state atom components below:
  `VultusSkeletonCard`, `VultusSkeletonHero`, `VultusEmptyState`,
  `VultusErrorState`.

## Components

All four are **standalone**, `OnPush`, prefixed `vultus-`, and style themselves
purely from the `--vultus-*` theme tokens (no hardcoded colors/radii). Import the
class from `@vultus/shared/ui-kit` and add it to the host component's `imports`.

- **`VultusSkeletonCard`** — `<vultus-skeleton-card [count]="N" />`. Renders
  `count` (default `1`) shimmering placeholder rows mimicking a watchlist / search
  result list item (poster + title + meta + status-badge skeletons). Use while a
  list is loading.
- **`VultusSkeletonHero`** — `<vultus-skeleton-hero />`. No inputs. A full-bleed
  hero placeholder plus title / meta / three overview lines / card block,
  mimicking the title-detail screen while it loads.
- **`VultusEmptyState`** — `<vultus-empty-state icon="film-outline" title="…"
[subtitle]="…" />`. Centered icon + title with optional subtitle (hidden when
  empty). `icon` and `title` are **required** inputs. The **consumer registers the
  Ionicon** it passes (call `addIcons({ … })` in the host) — this component does
  not register icons.
- **`VultusErrorState`** — `<vultus-error-state [message]="…" (retry)="…" />`.
  Centered error icon + message (default `'Something went wrong'`) + a "Try again"
  outline button that emits the `retry` output. **Registers its own icons**
  (`alertCircleOutline`, `refreshOutline`) — consumers need not.

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

Run `nx test shared-ui-kit` (Vitest + Analog). The state atom components are
covered by co-located `*.component.spec.ts` files using `@analogjs/testing`'s
`render` against a zoneless TestBed (`src/test-setup.ts`).
