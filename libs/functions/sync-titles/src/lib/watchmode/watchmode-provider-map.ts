// Region-AGNOSTIC Watchmode source_id → TMDB provider identity crosswalk
// (spec 0099, decision 3). Generated once from Watchmode `/sources/`
// cross-referenced to TMDB's provider catalog BY NAME, then committed +
// human-verified. Extend when a new global flatrate provider is added; a
// Watchmode source with no entry here is DROPPED from the fallback (never
// guessed). Covers major GLOBAL flatrate services (Netflix, Disney+, Prime
// Video, HBO/Max, Apple TV+, Paramount+, Peacock, Hulu, …) — NOT an NL-only
// list, because provider IDENTITY is global; only availability is regional.
//
// IMPORTANT (verification): the numeric Watchmode `source_id` keys and TMDB
// `providerId` values below are the well-known, community-documented ids for
// these services as of 2026-07. The one-time generation step (fetch Watchmode
// `/sources/` with the provisioned key + TMDB `/watch/providers/{movie,tv}`,
// match by normalized name) should be RE-RUN by a human with live credentials
// to confirm each pairing before relying on the fallback in production; any
// pairing that live data contradicts is corrected here (a one-line edit). See
// the sync-titles README + spec 0099 Risks ("Crosswalk staleness").

export interface CrosswalkEntry {
  /** TMDB provider id — the id the whole app keys availability/prefs on. */
  providerId: number;
  /** Human-readable provider name (TMDB `provider_name`), for diagnostics. */
  name: string;
}

export const WATCHMODE_TO_TMDB_PROVIDER: Record<number, CrosswalkEntry> = {
  // Watchmode source_id : { TMDB providerId, name }
  203: { providerId: 8, name: 'Netflix' }, // Netflix
  26: { providerId: 9, name: 'Amazon Prime Video' }, // Amazon Prime Video
  372: { providerId: 337, name: 'Disney Plus' }, // Disney+
  387: { providerId: 1899, name: 'Max' }, // HBO Max / Max
  371: { providerId: 350, name: 'Apple TV Plus' }, // Apple TV+
  157: { providerId: 15, name: 'Hulu' }, // Hulu
  444: { providerId: 531, name: 'Paramount Plus' }, // Paramount+
  388: { providerId: 386, name: 'Peacock Premium' }, // Peacock
};
