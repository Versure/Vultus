// DTO → domain mapping. Pure functions (no I/O), the priority unit-test surface.

import {
  REGIONS,
  type Episode,
  type Region,
  type TitleMetadata,
  type WatchProvider,
  type WatchProviderType,
} from '@vultus/shared/domain';
import type {
  TmdbMovieResponse,
  TmdbProviderCountry,
  TmdbProviderEntry,
  TmdbSeasonResponse,
  TmdbTvResponse,
  TmdbWatchProvidersResponse,
} from './tmdb-dtos';

// A present, non-empty date-only "YYYY-MM-DD" → full ISO-8601 UTC instant.
// null / missing / empty → null. Consistent across air_date/release_date/first_air_date.
export function normalizeDate(date: string | null | undefined): string | null {
  if (!date) return null;
  return new Date(`${date}T00:00:00.000Z`).toISOString();
}

export function mapMovie(dto: TmdbMovieResponse): TitleMetadata {
  return {
    title: dto.title ?? '',
    overview: dto.overview ?? '',
    posterPath: dto.poster_path ?? null,
    releaseDate: normalizeDate(dto.release_date),
  };
}

export function mapTvShow(dto: TmdbTvResponse): TitleMetadata {
  return {
    // TV uses `name` (not `title`) and `first_air_date` (not `release_date`).
    title: dto.name ?? '',
    overview: dto.overview ?? '',
    posterPath: dto.poster_path ?? null,
    releaseDate: normalizeDate(dto.first_air_date),
  };
}

// Only flatrate/rent/buy map to a WatchProviderType; ads/free are dropped.
const PROVIDER_BUCKETS: WatchProviderType[] = ['flatrate', 'rent', 'buy'];

const REGION_SET = new Set<string>(REGIONS);

function mapCountryProviders(country: TmdbProviderCountry): WatchProvider[] {
  const providers: WatchProvider[] = [];
  for (const bucket of PROVIDER_BUCKETS) {
    const entries: TmdbProviderEntry[] | undefined = country[bucket];
    if (!entries) continue;
    for (const entry of entries) {
      providers.push({
        providerId: entry.provider_id,
        name: entry.provider_name,
        type: bucket,
      });
    }
  }
  return providers;
}

// Keep only REGIONS countries. A REGIONS country TMDB returned with only
// ads/free → key present, empty array. A REGIONS country absent from results →
// key absent. Non-REGIONS countries dropped entirely.
export function mapWatchProviders(
  dto: TmdbWatchProvidersResponse,
): Partial<Record<Region, WatchProvider[]>> {
  const out: Partial<Record<Region, WatchProvider[]>> = {};
  const results = dto.results ?? {};
  for (const [code, country] of Object.entries(results)) {
    if (!REGION_SET.has(code)) continue;
    out[code as Region] = mapCountryProviders(country);
  }
  return out;
}

// Episodes with a null/empty/missing air_date are skipped (Episode.airDate is a
// required string). `season_number` falls back to the season argument if absent.
export function mapSeasonEpisodes(
  dto: TmdbSeasonResponse,
  seasonNumber: number,
): Episode[] {
  const episodes: Episode[] = [];
  for (const entry of dto.episodes ?? []) {
    const airDate = normalizeDate(entry.air_date);
    if (airDate === null) continue;
    episodes.push({
      season: entry.season_number ?? seasonNumber,
      episode: entry.episode_number,
      airDate,
    });
  }
  return episodes;
}
