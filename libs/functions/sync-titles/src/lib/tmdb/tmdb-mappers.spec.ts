import { describe, expect, it } from 'vitest';
import {
  mapSeasonEpisodes,
  mapTvSeasonCount,
  mapWatchProviders,
  normalizeDate,
} from './tmdb-mappers';

describe('normalizeDate', () => {
  it('coerces a date-only string to a UTC midnight ISO instant', () => {
    expect(normalizeDate('1999-03-31')).toBe('1999-03-31T00:00:00.000Z');
  });

  it('returns null for null / undefined / empty string', () => {
    expect(normalizeDate(null)).toBeNull();
    expect(normalizeDate(undefined)).toBeNull();
    expect(normalizeDate('')).toBeNull();
  });
});

describe('mapWatchProviders ignored fields', () => {
  it('ignores display_priority and logo_path', () => {
    const result = mapWatchProviders({
      results: {
        US: {
          flatrate: [
            {
              provider_id: 8,
              provider_name: 'Netflix',
              display_priority: 9,
              logo_path: '/x.jpg',
            },
          ],
        },
      },
    } as Parameters<typeof mapWatchProviders>[0]);
    expect(result.US).toEqual([
      { providerId: 8, name: 'Netflix', type: 'flatrate' },
    ]);
  });

  it('returns an empty map for empty/missing results', () => {
    expect(mapWatchProviders({})).toEqual({});
    expect(mapWatchProviders({ results: {} })).toEqual({});
  });
});

describe('mapSeasonEpisodes (spec 0047)', () => {
  it('carries title from episode name, null when absent', () => {
    const result = mapSeasonEpisodes(
      {
        episodes: [
          {
            episode_number: 1,
            air_date: '2011-04-17',
            name: 'Winter Is Coming',
          },
          { episode_number: 2, air_date: '2011-04-24' }, // no name
        ],
      },
      1,
    );
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('Winter Is Coming');
    expect(result[1].title).toBeNull();
  });

  it('still drops episodes with null/missing air_date (Data-model option b)', () => {
    const result = mapSeasonEpisodes(
      {
        episodes: [
          { episode_number: 1, air_date: null, name: 'Undated' },
          { episode_number: 2, air_date: '2011-04-24', name: 'Dated' },
        ],
      },
      1,
    );
    expect(result).toHaveLength(1);
    expect(result[0].episode).toBe(2);
  });
});

describe('mapTvSeasonCount (spec 0047)', () => {
  it('returns number_of_seasons when present', () => {
    expect(mapTvSeasonCount({ number_of_seasons: 8 })).toBe(8);
  });

  it('returns null when number_of_seasons is absent', () => {
    expect(mapTvSeasonCount({})).toBeNull();
  });
});
