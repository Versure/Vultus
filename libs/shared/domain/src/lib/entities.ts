// Core entity / value types — the in-memory domain vocabulary consumed by
// slices (search results, view models, transient data). Persistence-agnostic.

import type { WatchProviderType } from './enums';

export interface WatchProvider {
  providerId: number; // TMDB provider id
  name: string;
  type: WatchProviderType; // 'flatrate' | 'rent' | 'buy'
}

/** One provider in a region's TMDB watch-provider catalog (spec 0060). Narrower
 *  than WatchProvider: a region catalog has no per-title flatrate/rent/buy type,
 *  and carries the TMDB logo path. */
export interface CatalogProvider {
  providerId: number; // TMDB provider id
  name: string; // TMDB provider_name
  logoPath: string | null; // TMDB logo_path, e.g. '/abc.jpg'; null when unknown
}

// Title-type discriminated union: narrows on `type`. Episode-bearing data lives
// on the Show (tv) branch / TV documents only.
export interface Movie {
  type: 'movie';
  tmdbId: number;
  traktId: number | null;
  title: string;
}

export interface Show {
  type: 'tv';
  tmdbId: number;
  traktId: number | null;
  title: string;
}

export type Title = Movie | Show;

// A TV episode value type (the data, persistence-agnostic).
export interface Episode {
  season: number;
  episode: number;
  title: string | null; // episode name; null when unset (spec 0047)
  airDate: string; // ISO 8601
}
