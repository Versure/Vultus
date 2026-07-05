import { describe, expect, it } from 'vitest';
import {
  mapSeasonEpisodes,
  mapTvSeasonCount,
  mapWatchProviders,
  mergeCatalogProviders,
  normalizeDate,
} from './tmdb-mappers';
import type { TmdbWatchProviderListEntry } from './tmdb-dtos';

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

describe('mergeCatalogProviders (spec 0060)', () => {
  const netflix: TmdbWatchProviderListEntry = {
    provider_id: 8,
    provider_name: 'Netflix',
    logo_path: '/netflix.jpg',
  };
  const disney: TmdbWatchProviderListEntry = {
    provider_id: 337,
    provider_name: 'Disney Plus',
    logo_path: '/disney.jpg',
  };
  const prime: TmdbWatchProviderListEntry = {
    provider_id: 9,
    provider_name: 'Amazon Prime Video',
    logo_path: '/prime.jpg',
  };

  it('merges movie + tv lists into one CatalogProvider[]', () => {
    const result = mergeCatalogProviders([netflix], [disney]);
    expect(result).toEqual([
      { providerId: 337, name: 'Disney Plus', logoPath: '/disney.jpg' },
      { providerId: 8, name: 'Netflix', logoPath: '/netflix.jpg' },
    ]);
  });

  it('dedupes by providerId — a provider in both lists appears once (first wins)', () => {
    const movieNetflix = { ...netflix, logo_path: '/movie-logo.jpg' };
    const tvNetflix = { ...netflix, logo_path: '/tv-logo.jpg' };
    const result = mergeCatalogProviders([movieNetflix], [tvNetflix]);
    expect(result).toHaveLength(1);
    // First occurrence (movie side) wins.
    expect(result[0]).toEqual({
      providerId: 8,
      name: 'Netflix',
      logoPath: '/movie-logo.jpg',
    });
  });

  it('maps logo_path ?? null (null and missing → null)', () => {
    const nullLogo: TmdbWatchProviderListEntry = {
      provider_id: 1,
      provider_name: 'NullLogo',
      logo_path: null,
    };
    const missingLogo = {
      provider_id: 2,
      provider_name: 'MissingLogo',
    } as TmdbWatchProviderListEntry;
    const result = mergeCatalogProviders([nullLogo, missingLogo], []);
    expect(result).toEqual([
      { providerId: 2, name: 'MissingLogo', logoPath: null },
      { providerId: 1, name: 'NullLogo', logoPath: null },
    ]);
  });

  it('sorts by name, case-insensitive', () => {
    const lower: TmdbWatchProviderListEntry = {
      provider_id: 3,
      provider_name: 'apple tv',
      logo_path: null,
    };
    const upper: TmdbWatchProviderListEntry = {
      provider_id: 4,
      provider_name: 'Zee5',
      logo_path: null,
    };
    const result = mergeCatalogProviders([upper, lower], [netflix]);
    expect(result.map((p) => p.name)).toEqual(['apple tv', 'Netflix', 'Zee5']);
  });

  it('handles movie-only input', () => {
    const result = mergeCatalogProviders([netflix, prime], []);
    expect(result.map((p) => p.providerId)).toEqual([9, 8]);
  });

  it('handles tv-only input', () => {
    const result = mergeCatalogProviders([], [disney, netflix]);
    expect(result.map((p) => p.providerId)).toEqual([337, 8]);
  });

  it('returns [] for two empty inputs', () => {
    expect(mergeCatalogProviders([], [])).toEqual([]);
  });

  // spec 0077 (#195): exclude the real TMDB "Plex" provider from the merged
  // catalog so it never collides with the manual "I use Plex" chip (spec 0061).
  describe('excludes the real TMDB "Plex" provider (spec 0077 / #195)', () => {
    const plexVariants: { label: string; name: string }[] = [
      { label: 'exact "Plex"', name: 'Plex' },
      { label: 'lowercase "plex"', name: 'plex' },
      { label: 'whitespace-padded " Plex "', name: ' Plex ' },
    ];

    for (const { label, name } of plexVariants) {
      it(`drops a Plex entry (${label}) on the movie side, Netflix passes through`, () => {
        const plex: TmdbWatchProviderListEntry = {
          provider_id: 999,
          provider_name: name,
          logo_path: '/plex.jpg',
        };
        const result = mergeCatalogProviders([netflix, plex], []);
        const names = result.map((p) => p.name.trim().toLowerCase());
        expect(names).not.toContain('plex');
        expect(result.map((p) => p.name)).toContain('Netflix');
      });

      it(`drops a Plex entry (${label}) on the tv side, Netflix passes through`, () => {
        const plex: TmdbWatchProviderListEntry = {
          provider_id: 999,
          provider_name: name,
          logo_path: '/plex.jpg',
        };
        const result = mergeCatalogProviders([], [netflix, plex]);
        const names = result.map((p) => p.name.trim().toLowerCase());
        expect(names).not.toContain('plex');
        expect(result.map((p) => p.name)).toContain('Netflix');
      });
    }

    it('does NOT exclude a non-exact name like "Plex Premium" (no over-matching)', () => {
      const plexPremium: TmdbWatchProviderListEntry = {
        provider_id: 1001,
        provider_name: 'Plex Premium',
        logo_path: null,
      };
      const plexus: TmdbWatchProviderListEntry = {
        provider_id: 1002,
        provider_name: 'Plexus',
        logo_path: null,
      };
      const result = mergeCatalogProviders([plexPremium, plexus], []);
      expect(result.map((p) => p.name)).toEqual(['Plex Premium', 'Plexus']);
    });

    it('still dedupes by id (first wins) with the Plex filter present', () => {
      const movieNetflix = { ...netflix, logo_path: '/movie-logo.jpg' };
      const tvNetflix = { ...netflix, logo_path: '/tv-logo.jpg' };
      const plex: TmdbWatchProviderListEntry = {
        provider_id: 999,
        provider_name: 'Plex',
        logo_path: '/plex.jpg',
      };
      const result = mergeCatalogProviders([movieNetflix, plex], [tvNetflix]);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        providerId: 8,
        name: 'Netflix',
        logoPath: '/movie-logo.jpg',
      });
    });

    it('still sorts by name (case-insensitive) with the Plex filter present', () => {
      const lower: TmdbWatchProviderListEntry = {
        provider_id: 3,
        provider_name: 'apple tv',
        logo_path: null,
      };
      const upper: TmdbWatchProviderListEntry = {
        provider_id: 4,
        provider_name: 'Zee5',
        logo_path: null,
      };
      const result = mergeCatalogProviders([upper, lower], [netflix]);
      expect(result.map((p) => p.name)).toEqual([
        'apple tv',
        'Netflix',
        'Zee5',
      ]);
    });
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
