// @vultus/mobile/title-detail — the pushed per-title detail page (slice
// :title-detail). Barrel surface: the lazy-routed page + the TMDB config token
// the shell provides at root. See README.md.

export { TitleDetailPage } from './lib/title-detail.page';
export { TMDB_DETAIL_CONFIG } from './lib/tokens';
export type { TmdbDetailConfig } from './lib/tmdb-detail.client';
export type { SeasonGroup, EpisodeRow } from './lib/title-detail.service';
