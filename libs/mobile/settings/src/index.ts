export { SettingsPage } from './lib/settings.page';
// Plex (spec 0073) — the connect sub-page + the client classes + the root
// services the shell's app.config factory + the `/tabs/settings/plex` route
// import (T4). No PLEX_PROVIDERS — the shell factory selects the client directly.
export { PlexConnectPage } from './lib/plex-connect.page';
export { CapacitorHttpPlexClient } from './lib/plex.client';
export { MockPlexClient } from './lib/plex.client.mock';
export { PlexLinkService } from './lib/plex-link.service';
export { PlexSyncService } from './lib/plex-sync.service';
export type { PlexSyncSummary } from './lib/plex-sync.service';
// TMDB detail config token (spec 0086) — the shell's app.config wires this from
// environment.tmdb so PlexSyncService can fetch posterPath/voteAverage. The
// client factory + interface stay slice-internal (the shell only needs the
// token + config type).
export { SETTINGS_TMDB_CONFIG } from './lib/tokens';
export type { TmdbDetailConfig } from './lib/tmdb-detail.client';
