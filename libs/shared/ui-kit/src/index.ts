// @vultus/shared/ui-kit — Vultus Stitch design-system theming (PLAN §2, §3).
//
// The public theming surface of this lib is the SCSS token file
// `./lib/theme.scss` (Stitch tokens as CSS custom properties + Ionic theme
// variables). It is consumed by `apps/mobile`'s global styles, NOT imported as
// TypeScript — global styles cannot `@import` a .ts barrel, so the .scss file is
// the entrypoint:
//
//   @import '@vultus/shared/ui-kit/src/lib/theme.scss';
//
// Shared Ionic atom components will be added to this barrel ONLY when the same
// atom is needed by 3+ slices (CLAUDE.md / PLAN §3 — no premature extraction).
// Until then this constant documents the SCSS theming entrypoint and keeps the
// barrel non-empty and lint-clean.
//
// SHERIFF: scope:shared — importable by anyone.
export const SHARED_UI_KIT_THEME_PATH =
  '@vultus/shared/ui-kit/src/lib/theme.scss';
