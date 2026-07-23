// Raw Watchmode HTTP response DTOs. Slice-internal — NOT exported from the
// barrel; only the mappers consume them. Field names are based on the
// community-documented / secondary-source Watchmode v1 API shape (the live
// credentialed docs at https://api.watchmode.com/docs could not be rendered
// during implementation) and should be re-confirmed against the live docs with
// credentials — see the README + spec Risks for the assumptions flagged as
// unconfirmed.

/** GET /v1/search/?search_field={tmdb_movie_id|tmdb_tv_id}&search_value={id}
 *  Watchmode returns `title_results` (title matches) and `people_results`
 *  (person matches). We only consume `title_results[0].id` — the Watchmode
 *  numeric title id. Every field is optional to defend against a lean/altered
 *  payload. */
export interface WatchmodeSearchResponse {
  title_results?: WatchmodeTitleResult[];
  // people_results is present in the real payload but never consumed.
}

export interface WatchmodeTitleResult {
  /** The Watchmode title id — what we cache as `watchmodeId`. */
  id: number;
  name?: string;
  type?: string;
  tmdb_id?: number;
  tmdb_type?: string;
}

/** One source row from GET /v1/title/{id}/sources/?regions={csv}. Each object
 *  carries the Watchmode `source_id`, its availability bucket `type`
 *  (sub|rent|buy|free), and the ISO-3166-1 alpha-2 `region` it applies to. */
export interface WatchmodeSourceDto {
  source_id: number;
  /** 'sub' | 'rent' | 'buy' | 'free' — only 'sub' maps to flatrate. */
  type: string;
  /** ISO-3166-1 alpha-2 country code, e.g. 'NL'. */
  region: string;
  name?: string;
}
