import {
  type EpisodeDoc,
  type RegionAvailability,
  type WatchProvider,
  type WatchlistItem,
} from '@vultus/shared/domain';
import { describe, expect, it } from 'vitest';
import {
  isMovieWatchableToday,
  isTvWatchableToday,
  nextEpisodeLabel,
  partitionAvailabilityPill,
  partitionWatchableToday,
  watchableSubtitle,
} from './today.logic';

// A fixed "now" in two representations (D5): full ISO datetime for TV, the
// date-only slice for movies. Kept internally consistent so a case only flips if
// the formats are conflated.
const NOW_ISO = '2026-01-02T15:00:00.000Z';
const TODAY_DATE_ONLY = NOW_ISO.slice(0, 10); // '2026-01-02'

function item(over: Partial<WatchlistItem>): WatchlistItem {
  return {
    type: 'movie',
    tmdbId: 1,
    traktId: null,
    title: 'Title',
    addedAt: '2026-01-01T00:00:00.000Z',
    status: 'watching',
    watchingViaPlex: false,
    ...over,
  };
}

function ep(over: Partial<EpisodeDoc>): EpisodeDoc {
  return {
    season: 1,
    episode: 1,
    title: null,
    airDate: '2026-01-01T00:00:00.000Z',
    watched: false,
    watchedAt: null,
    ...over,
  };
}

describe('isMovieWatchableToday', () => {
  it('true for a watching movie whose releaseDate is in the past', () => {
    expect(
      isMovieWatchableToday(
        item({ type: 'movie', status: 'watching', releaseDate: '2024-03-15' }),
        TODAY_DATE_ONLY,
      ),
    ).toBe(true);
  });

  it('true for a planned movie whose releaseDate is in the past', () => {
    expect(
      isMovieWatchableToday(
        item({ type: 'movie', status: 'planned', releaseDate: '2024-03-15' }),
        TODAY_DATE_ONLY,
      ),
    ).toBe(true);
  });

  it('false for a future releaseDate', () => {
    expect(
      isMovieWatchableToday(
        item({ type: 'movie', releaseDate: '2099-01-01' }),
        TODAY_DATE_ONLY,
      ),
    ).toBe(false);
  });

  it('false for a null releaseDate', () => {
    expect(
      isMovieWatchableToday(
        item({ type: 'movie', releaseDate: null }),
        TODAY_DATE_ONLY,
      ),
    ).toBe(false);
  });

  it('false for an absent releaseDate', () => {
    const bare = item({ type: 'movie' });
    delete bare.releaseDate;
    expect(isMovieWatchableToday(bare, TODAY_DATE_ONLY)).toBe(false);
  });

  it('false for dropped/completed regardless of date', () => {
    expect(
      isMovieWatchableToday(
        item({ type: 'movie', status: 'dropped', releaseDate: '2024-03-15' }),
        TODAY_DATE_ONLY,
      ),
    ).toBe(false);
    expect(
      isMovieWatchableToday(
        item({ type: 'movie', status: 'completed', releaseDate: '2024-03-15' }),
        TODAY_DATE_ONLY,
      ),
    ).toBe(false);
  });
});

describe('isTvWatchableToday', () => {
  it('true for a watching TV show whose nextUnwatchedEpisodeAirDate is in the past', () => {
    expect(
      isTvWatchableToday(
        item({
          type: 'tv',
          status: 'watching',
          nextUnwatchedEpisodeAirDate: '2025-06-01T00:00:00.000Z',
        }),
        NOW_ISO,
      ),
    ).toBe(true);
  });

  it('true for a planned TV show whose nextUnwatchedEpisodeAirDate is in the past', () => {
    expect(
      isTvWatchableToday(
        item({
          type: 'tv',
          status: 'planned',
          nextUnwatchedEpisodeAirDate: '2025-06-01T00:00:00.000Z',
        }),
        NOW_ISO,
      ),
    ).toBe(true);
  });

  it('false for a future nextUnwatchedEpisodeAirDate', () => {
    expect(
      isTvWatchableToday(
        item({
          type: 'tv',
          nextUnwatchedEpisodeAirDate: '2099-01-01T00:00:00.000Z',
        }),
        NOW_ISO,
      ),
    ).toBe(false);
  });

  it('false for a null nextUnwatchedEpisodeAirDate', () => {
    expect(
      isTvWatchableToday(
        item({ type: 'tv', nextUnwatchedEpisodeAirDate: null }),
        NOW_ISO,
      ),
    ).toBe(false);
  });

  it('false for dropped/completed regardless of date', () => {
    expect(
      isTvWatchableToday(
        item({
          type: 'tv',
          status: 'dropped',
          nextUnwatchedEpisodeAirDate: '2025-06-01T00:00:00.000Z',
        }),
        NOW_ISO,
      ),
    ).toBe(false);
    expect(
      isTvWatchableToday(
        item({
          type: 'tv',
          status: 'completed',
          nextUnwatchedEpisodeAirDate: '2025-06-01T00:00:00.000Z',
        }),
        NOW_ISO,
      ),
    ).toBe(false);
  });
});

describe('D5 boundary / format guard', () => {
  it('a movie whose date-only releaseDate EQUALS todayDateOnly is watchable (<=)', () => {
    expect(
      isMovieWatchableToday(
        item({ type: 'movie', releaseDate: '2024-03-15' }),
        '2024-03-15',
      ),
    ).toBe(true);
  });

  it('a TV airDate earlier TODAY (full datetime) is watchable against a later-today nowISO — would FLIP if formats were conflated', () => {
    // Episode aired 09:00 today; "now" is 15:00 today. Correct full-datetime
    // compare: '2026-01-02T09:00...' <= '2026-01-02T15:00...' → watchable.
    const airedEarlierToday = '2026-01-02T09:00:00.000Z';
    expect(
      isTvWatchableToday(
        item({
          type: 'tv',
          nextUnwatchedEpisodeAirDate: airedEarlierToday,
        }),
        NOW_ISO,
      ),
    ).toBe(true);

    // Guard against the conflation bug: had the function sliced the airDate to a
    // date-only string and compared it against the full nowISO, the comparison
    // '2026-01-02' <= '2026-01-02T15:00:00.000Z' is still true here, but a LATER
    // episode today vs an earlier now must be false — proving full-datetime use.
    const airsLaterToday = '2026-01-02T20:00:00.000Z';
    expect(
      isTvWatchableToday(
        item({
          type: 'tv',
          nextUnwatchedEpisodeAirDate: airsLaterToday,
        }),
        NOW_ISO,
      ),
    ).toBe(false);
  });
});

describe('partitionWatchableToday', () => {
  it('partitions a mixed set into { movies, tvShows }, excluding gated/dropped/completed', () => {
    const watchableMovie = item({
      tmdbId: 1,
      type: 'movie',
      status: 'watching',
      releaseDate: '2024-03-15',
    });
    const futureMovie = item({
      tmdbId: 2,
      type: 'movie',
      status: 'watching',
      releaseDate: '2099-01-01',
    });
    const droppedMovie = item({
      tmdbId: 3,
      type: 'movie',
      status: 'dropped',
      releaseDate: '2024-03-15',
    });
    const watchableTv = item({
      tmdbId: 4,
      type: 'tv',
      status: 'planned',
      nextUnwatchedEpisodeAirDate: '2025-06-01T00:00:00.000Z',
    });
    const futureTv = item({
      tmdbId: 5,
      type: 'tv',
      status: 'watching',
      nextUnwatchedEpisodeAirDate: '2099-01-01T00:00:00.000Z',
    });
    const completedTv = item({
      tmdbId: 6,
      type: 'tv',
      status: 'completed',
      nextUnwatchedEpisodeAirDate: '2025-06-01T00:00:00.000Z',
    });

    const result = partitionWatchableToday(
      [
        watchableMovie,
        futureMovie,
        droppedMovie,
        watchableTv,
        futureTv,
        completedTv,
      ],
      NOW_ISO,
      TODAY_DATE_ONLY,
    );

    expect(result.movies.map((i) => i.tmdbId)).toEqual([1]);
    expect(result.tvShows.map((i) => i.tmdbId)).toEqual([4]);
  });
});

describe('watchableSubtitle', () => {
  it('renders exact singular/plural/zero strings', () => {
    expect(watchableSubtitle(1)).toBe('1 thing ready to watch');
    expect(watchableSubtitle(3)).toBe('3 things ready to watch');
    expect(watchableSubtitle(0)).toBe('0 things ready to watch');
  });
});

describe('nextEpisodeLabel', () => {
  it('returns the earliest unwatched episode UNPADDED', () => {
    const episodes = [
      ep({ season: 3, episode: 5, airDate: '2026-01-01T00:00:00.000Z' }),
      ep({ season: 3, episode: 6, airDate: '2026-02-01T00:00:00.000Z' }),
    ];
    expect(nextEpisodeLabel(episodes)).toBe('S3E5 available');
  });

  it('skips watched episodes when picking the earliest unwatched', () => {
    const episodes = [
      ep({
        season: 1,
        episode: 1,
        airDate: '2025-01-01T00:00:00.000Z',
        watched: true,
      }),
      ep({
        season: 1,
        episode: 2,
        airDate: '2025-02-01T00:00:00.000Z',
        watched: false,
      }),
    ];
    expect(nextEpisodeLabel(episodes)).toBe('S1E2 available');
  });

  it('tie-breaks equal airDate by (season, episode) ascending', () => {
    const sameAir = '2026-01-01T00:00:00.000Z';
    const episodes = [
      ep({ season: 2, episode: 1, airDate: sameAir }),
      ep({ season: 1, episode: 4, airDate: sameAir }),
      ep({ season: 1, episode: 2, airDate: sameAir }),
    ];
    expect(nextEpisodeLabel(episodes)).toBe('S1E2 available');
  });

  it('returns null when every episode is watched', () => {
    const episodes = [
      ep({ season: 1, episode: 1, watched: true }),
      ep({ season: 1, episode: 2, watched: true }),
    ];
    expect(nextEpisodeLabel(episodes)).toBeNull();
  });

  it('returns null for an empty episode list', () => {
    expect(nextEpisodeLabel([])).toBeNull();
  });
});

describe('partitionAvailabilityPill', () => {
  function availability(providers: WatchProvider[]): RegionAvailability {
    return {
      providers,
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
      previousSnapshot: [],
    };
  }

  it('mine → the first flatrate provider whose id ∈ myProviderIds', () => {
    const a = availability([
      { providerId: 9, name: 'Amazon', type: 'flatrate' },
      { providerId: 8, name: 'Netflix', type: 'flatrate' },
    ]);
    expect(partitionAvailabilityPill(a, [8])).toEqual({
      kind: 'mine',
      name: 'Netflix',
    });
  });

  it('elsewhere → the first flatrate provider when none is mine', () => {
    const a = availability([
      { providerId: 9, name: 'Amazon', type: 'flatrate' },
      { providerId: 8, name: 'Netflix', type: 'flatrate' },
    ]);
    expect(partitionAvailabilityPill(a, [337])).toEqual({
      kind: 'elsewhere',
      name: 'Amazon',
    });
  });

  it('null → no flatrate provider (rent/buy only) → no pill', () => {
    const a = availability([{ providerId: 9, name: 'Amazon', type: 'rent' }]);
    expect(partitionAvailabilityPill(a, [9])).toBeNull();
  });

  it('null availability → no pill', () => {
    expect(partitionAvailabilityPill(null, [8])).toBeNull();
  });
});
