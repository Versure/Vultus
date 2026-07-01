// Internal TMDB v3 response DTOs (snake_case). NOT exported from the barrel and
// NOT domain types — the mappers convert these to `@vultus/shared/domain` shapes.
// Only the fields this client reads are modeled; TMDB returns more (e.g.
// `display_priority`, `logo_path`, top-level `id`, per-country `link`) which are
// deliberately left unmodeled.

export interface TmdbMovieResponse {
  title?: string;
  overview?: string;
  poster_path?: string | null;
  release_date?: string | null;
}

export interface TmdbTvResponse {
  name?: string;
  overview?: string;
  poster_path?: string | null;
  first_air_date?: string | null;
  number_of_seasons?: number;
}

// A single provider as returned inside a flatrate/rent/buy/ads/free bucket.
export interface TmdbProviderEntry {
  provider_id: number;
  provider_name: string;
}

// One country's availability. Buckets other than flatrate/rent/buy (e.g.
// ads/free) and the per-country `link` are present in TMDB but not all modeled
// for mapping; ads/free are intentionally typed so they can be ignored.
export interface TmdbProviderCountry {
  flatrate?: TmdbProviderEntry[];
  rent?: TmdbProviderEntry[];
  buy?: TmdbProviderEntry[];
  ads?: TmdbProviderEntry[];
  free?: TmdbProviderEntry[];
}

export interface TmdbWatchProvidersResponse {
  results?: Record<string, TmdbProviderCountry>;
}

// One entry in a region-wide watch-provider CATALOG list (GET
// /watch/providers/{movie,tv}?watch_region=…, spec 0060). Only the three fields
// the catalog mapper reads are modeled; TMDB also returns `display_priority`
// (and a `display_priorities` map) which are deliberately left unmodeled.
export interface TmdbWatchProviderListEntry {
  provider_id: number;
  provider_name: string;
  logo_path?: string | null;
}

export interface TmdbWatchProviderListResponse {
  results?: TmdbWatchProviderListEntry[];
}

export interface TmdbEpisodeEntry {
  season_number?: number;
  episode_number: number;
  air_date?: string | null;
  name?: string;
}

export interface TmdbSeasonResponse {
  episodes?: TmdbEpisodeEntry[];
}
