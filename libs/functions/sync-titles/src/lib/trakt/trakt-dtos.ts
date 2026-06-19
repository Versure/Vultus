// Raw Trakt API v2 JSON shapes (snake_case). Slice-internal — NOT exported from
// the barrel, NOT domain types. Only the fields the client reads are modeled
// (Trakt returns much more); the mappers convert these to the camelCase
// contract/domain types. Same discipline as `tmdb-dtos.ts`.

export interface TraktShowIdsDto {
  trakt: number;
  slug?: string;
  tvdb?: number | null;
  imdb?: string | null;
  /** Trakt is not guaranteed to have a TMDB id — may be null/absent. */
  tmdb?: number | null;
}

export interface TraktShowDto {
  title: string;
  year?: number | null;
  ids: TraktShowIdsDto;
}

export interface TraktEpisodeDto {
  season?: number | null;
  number?: number | null;
  title?: string | null;
  ids?: Record<string, unknown>;
}

// One entry of `GET /calendars/all/shows/{start_date}/{days}`.
export interface TraktCalendarEntryDto {
  /** Full ISO-8601 UTC instant, e.g. "2026-06-20T01:00:00.000Z". */
  first_aired?: string | null;
  episode: TraktEpisodeDto;
  show: TraktShowDto;
}

// One entry of `GET /search/tmdb/{tmdbId}?type=show`.
export interface TraktSearchResultDto {
  type: string;
  score?: number | null;
  show?: TraktShowDto;
}
