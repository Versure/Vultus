// DTO → domain/contract mapping for the Trakt client. Pure functions (no I/O),
// the priority unit-test surface.
//
// Date handling contrast with TMDB: Trakt's `first_aired` is ALREADY a full
// ISO-8601 UTC instant (e.g. "2026-06-20T01:00:00.000Z"), unlike TMDB's
// date-only "YYYY-MM-DD" that `mappers.ts` had to synthesize a midnight instant
// for. So `first_aired` passes through to `Episode.airDate` UNCHANGED — no
// `T00:00:00.000Z` synthesis, no truncation.

import type { Episode } from '@vultus/shared/domain';
import type { TraktCalendarEntryDto, TraktSearchResultDto } from './trakt-dtos';
import type { TraktCalendarEntry } from './trakt-client';

// Map one calendar DTO entry. Returns null (→ caller skips it) when a required
// field is missing: a present, non-empty `first_aired`, an `episode.season`,
// and an `episode.number` are all required because `Episode.airDate`/`season`/
// `episode` are required. `show.ids.tmdb` is optional → `tmdbId: number | null`.
export function mapCalendarEntry(
  dto: TraktCalendarEntryDto,
): TraktCalendarEntry | null {
  const firstAired = dto.first_aired;
  if (!firstAired) return null;

  const season = dto.episode?.season;
  const number = dto.episode?.number;
  if (season === null || season === undefined) return null;
  if (number === null || number === undefined) return null;

  const episode: Episode = {
    season,
    episode: number,
    title: null, // Trakt calendar does not carry episode names
    // Pass through unchanged — Trakt already gives a full UTC instant.
    airDate: firstAired,
  };

  return {
    traktId: dto.show.ids.trakt,
    tmdbId: dto.show.ids.tmdb ?? null,
    showTitle: dto.show.title,
    episode,
  };
}

export function mapCalendar(
  dtos: TraktCalendarEntryDto[],
): TraktCalendarEntry[] {
  const entries: TraktCalendarEntry[] = [];
  for (const dto of dtos) {
    const mapped = mapCalendarEntry(dto);
    if (mapped !== null) entries.push(mapped);
  }
  return entries;
}

// Take the first `type === 'show'` result and return its `show.ids.trakt`.
// Trakt's score-ordered results put the best match first, and a TMDB id is a
// near-exact lookup. No `type === 'show'` entry (or empty array) → null.
export function extractShowTraktId(
  results: TraktSearchResultDto[],
): number | null {
  for (const result of results) {
    if (result.type === 'show' && result.show) {
      return result.show.ids.trakt;
    }
  }
  return null;
}
