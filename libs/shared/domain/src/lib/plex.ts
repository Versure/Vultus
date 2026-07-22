// Protocol-agnostic Plex vocabulary (spec 0073). Pure structural types
// describing the PMS / plex.tv surface Vultus consumes, so both the real
// (CapacitorHttp) and mock client impls — and the PLEX_CLIENT token — are typed
// without importing the settings slice. NO CapacitorHttp/Capacitor/Firebase
// import: shared owns only the vocabulary, the slice owns the protocol.

export interface PlexPin {
  id: number;
  code: string; // the 4-char link code
  authToken: string | null; // null until authorized
}

export interface PlexServer {
  name: string;
  baseUrl: string; // resolved local-network connection URI
  accessToken: string; // server access token from resources
}

/** One library item as Vultus needs it: TMDB id parsed from the plex `tmdb://`
 *  GUID (null when GUID-less → skipped), plus addedAt + watch state. */
export interface PlexLibraryItem {
  type: 'movie' | 'tv';
  tmdbId: number | null; // tmdb:// GUID; null → try tvdb/imdb via /find
  tvdbId?: number | null; // tvdb:// GUID id (spec 0097); optional/nullable
  imdbId?: string | null; // imdb:// GUID id, e.g. 'tt0111161' (spec 0097)
  title: string;
  addedAt: string | null; // ISO 8601; null when Plex reports none (spec 0097)
  viewCount: number; // movie/show-level; >0 = watched (movie)
  lastViewedAt: string | null; // ISO 8601 or null
  ratingKey: string; // Plex item id, for episode fetch
}

export interface PlexEpisodeItem {
  season: number; // parentIndex
  episode: number; // index
  viewCount: number; // >0 = watched
  lastViewedAt: string | null;
}

export interface PlexClient {
  requestPin(): Promise<PlexPin>;
  checkPin(id: number): Promise<PlexPin>; // poll; authToken set once linked
  discoverServer(token: string): Promise<PlexServer | null>; // first owned + local
  listLibrary(server: PlexServer): Promise<PlexLibraryItem[]>; // all movie+tv sections, paged
  listEpisodes(
    server: PlexServer,
    ratingKey: string,
  ): Promise<PlexEpisodeItem[]>;
}
