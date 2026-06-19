import { describe, expect, it } from 'vitest';
import { dedupeTitles } from './gather';

describe('dedupeTitles', () => {
  it('collapses a title tracked by 3 users to one entry', () => {
    const result = dedupeTitles([
      { tmdbId: 603, type: 'movie' },
      { tmdbId: 603, type: 'movie' },
      { tmdbId: 603, type: 'movie' },
    ]);
    expect(result).toEqual([{ tmdbId: 603, type: 'movie' }]);
  });

  it('preserves distinct tmdbIds', () => {
    const result = dedupeTitles([
      { tmdbId: 1, type: 'movie' },
      { tmdbId: 2, type: 'movie' },
      { tmdbId: 3, type: 'movie' },
    ]);
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.tmdbId)).toEqual([1, 2, 3]);
  });

  it('preserves a mixed movie/tv set', () => {
    const result = dedupeTitles([
      { tmdbId: 1, type: 'movie' },
      { tmdbId: 1396, type: 'tv' },
      { tmdbId: 1, type: 'movie' },
    ]);
    expect(result).toEqual([
      { tmdbId: 1, type: 'movie' },
      { tmdbId: 1396, type: 'tv' },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(dedupeTitles([])).toEqual([]);
  });

  it('keeps the first-seen type when the same id appears with differing types', () => {
    const result = dedupeTitles([
      { tmdbId: 5, type: 'tv' },
      { tmdbId: 5, type: 'movie' },
    ]);
    expect(result).toEqual([{ tmdbId: 5, type: 'tv' }]);
  });
});
