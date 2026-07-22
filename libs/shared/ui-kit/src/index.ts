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
// This constant documents the SCSS theming entrypoint and keeps the SCSS
// surface discoverable from TS.
//
// SHERIFF: scope:shared — importable by anyone.
export const SHARED_UI_KIT_THEME_PATH =
  '@vultus/shared/ui-kit/src/lib/theme.scss';

// Shared empty / loading / error state atoms (used by 3+ mobile slices —
// watchlist, search, title-detail). See each component's doc comment + README.
export { VultusSkeletonCard } from './lib/skeleton-card/vultus-skeleton-card.component';
export { VultusSkeletonHero } from './lib/skeleton-hero/vultus-skeleton-hero.component';
export { VultusEmptyState } from './lib/empty-state/vultus-empty-state.component';
export { VultusErrorState } from './lib/error-state/vultus-error-state.component';

// Shared tab-page header (spec 0096) — the fixed Vultus brand mark plus a
// projected trailing-buttons slot, used by all four tab pages (today,
// watchlist, search, settings). Self-registers only its brand icon.
export { VultusAppHeader } from './lib/app-header/vultus-app-header.component';

// Manual-sync cooldown state for the toolbar "refresh now" trigger (spec 0025),
// shared by the watchlist and title-detail slices (spec 0052). Imports only
// `@angular/core`, `@vultus/shared/domain/tokens`, and `firebase/app` — all
// permitted scope:shared dependencies.
export {
  SyncStateService,
  LAST_SYNC_KEY,
  SYNC_COOLDOWN_MS,
} from './lib/sync-state.service';
