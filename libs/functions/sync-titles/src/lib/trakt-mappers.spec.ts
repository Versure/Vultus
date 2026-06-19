import { describe, expect, it } from 'vitest';
import {
  extractShowTraktId,
  mapCalendar,
  mapCalendarEntry,
} from './trakt-mappers';
import type { TraktCalendarEntryDto, TraktSearchResultDto } from './trakt-dtos';

function calendarEntry(
  overrides: Partial<TraktCalendarEntryDto> = {},
): TraktCalendarEntryDto {
  return {
    first_aired: '2026-06-20T01:00:00.000Z',
    episode: { season: 2, number: 5, title: 'Ep 5' },
    show: {
      title: 'Severance',
      year: 2022,
      ids: { trakt: 152334, slug: 'severance', tmdb: 95396 },
    },
    ...overrides,
  };
}

describe('mapCalendarEntry', () => {
  it('maps show ids + episode fields into a TraktCalendarEntry', () => {
    expect(mapCalendarEntry(calendarEntry())).toEqual({
      traktId: 152334,
      tmdbId: 95396,
      showTitle: 'Severance',
      episode: { season: 2, episode: 5, airDate: '2026-06-20T01:00:00.000Z' },
    });
  });

  it('passes first_aired through unchanged (no synthesis, no truncation)', () => {
    const mapped = mapCalendarEntry(
      calendarEntry({ first_aired: '2026-12-31T23:30:45.123Z' }),
    );
    expect(mapped?.episode.airDate).toBe('2026-12-31T23:30:45.123Z');
    expect(mapped?.episode.airDate).not.toContain('T00:00:00.000Z');
  });

  it('sets tmdbId null when show.ids.tmdb is null', () => {
    const mapped = mapCalendarEntry(
      calendarEntry({
        show: { title: 'No TMDB', ids: { trakt: 1, tmdb: null } },
      }),
    );
    expect(mapped?.tmdbId).toBeNull();
    expect(mapped?.traktId).toBe(1);
  });

  it('sets tmdbId null when show.ids.tmdb is absent', () => {
    const mapped = mapCalendarEntry(
      calendarEntry({ show: { title: 'No TMDB', ids: { trakt: 1 } } }),
    );
    expect(mapped?.tmdbId).toBeNull();
  });

  it('skips (returns null) when first_aired is missing/null/empty', () => {
    expect(mapCalendarEntry(calendarEntry({ first_aired: null }))).toBeNull();
    expect(mapCalendarEntry(calendarEntry({ first_aired: '' }))).toBeNull();
    expect(
      mapCalendarEntry(calendarEntry({ first_aired: undefined })),
    ).toBeNull();
  });

  it('skips when episode.season is missing/null', () => {
    expect(
      mapCalendarEntry(calendarEntry({ episode: { number: 5 } })),
    ).toBeNull();
    expect(
      mapCalendarEntry(calendarEntry({ episode: { season: null, number: 5 } })),
    ).toBeNull();
  });

  it('keeps season 0 (specials) — only missing/null is skipped', () => {
    const mapped = mapCalendarEntry(
      calendarEntry({ episode: { season: 0, number: 1 } }),
    );
    expect(mapped?.episode.season).toBe(0);
  });

  it('skips when episode.number is missing/null', () => {
    expect(
      mapCalendarEntry(calendarEntry({ episode: { season: 1 } })),
    ).toBeNull();
    expect(
      mapCalendarEntry(calendarEntry({ episode: { season: 1, number: null } })),
    ).toBeNull();
  });
});

describe('mapCalendar', () => {
  it('maps multiple entries and drops the skipped ones, keeping the rest', () => {
    const result = mapCalendar([
      calendarEntry(),
      calendarEntry({ first_aired: null }), // skipped
      calendarEntry({
        show: { title: 'Show B', ids: { trakt: 2, tmdb: 200 } },
        episode: { season: 1, number: 1 },
        first_aired: '2026-06-21T02:00:00.000Z',
      }),
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.traktId)).toEqual([152334, 2]);
  });

  it('returns [] for an empty array', () => {
    expect(mapCalendar([])).toEqual([]);
  });
});

describe('extractShowTraktId', () => {
  it('returns the first type === show result trakt id', () => {
    const results: TraktSearchResultDto[] = [
      { type: 'show', score: 99, show: { title: 'A', ids: { trakt: 42 } } },
      { type: 'show', score: 50, show: { title: 'B', ids: { trakt: 99 } } },
    ];
    expect(extractShowTraktId(results)).toBe(42);
  });

  it('skips non-show entries and returns the first show', () => {
    const results: TraktSearchResultDto[] = [
      { type: 'movie', show: { title: 'M', ids: { trakt: 7 } } },
      { type: 'show', show: { title: 'S', ids: { trakt: 8 } } },
    ];
    expect(extractShowTraktId(results)).toBe(8);
  });

  it('returns null for an empty array', () => {
    expect(extractShowTraktId([])).toBeNull();
  });

  it('returns null when no entry is type === show', () => {
    const results: TraktSearchResultDto[] = [
      { type: 'movie', show: { title: 'M', ids: { trakt: 7 } } },
    ];
    expect(extractShowTraktId(results)).toBeNull();
  });
});
