import { describe, expect, it } from 'vitest';
import { filterStale } from './staleness';
import type { GatheredTitle } from './gather';

const WINDOW = 20 * 60 * 60 * 1000; // 20h
const NOW = Date.parse('2026-06-19T00:00:00.000Z');

const titles: GatheredTitle[] = [
  { tmdbId: 1, type: 'movie' },
  { tmdbId: 2, type: 'tv' },
  { tmdbId: 3, type: 'movie' },
];

function iso(offsetMs: number): string {
  return new Date(NOW - offsetMs).toISOString();
}

describe('filterStale', () => {
  it('drops a title synced more recently than the window (fresh)', () => {
    const map = new Map<number, string | null>([[1, iso(60 * 1000)]]); // 1 min ago
    const result = filterStale([titles[0]], map, NOW, WINDOW, false);
    expect(result).toEqual([]);
  });

  it('keeps a title synced longer ago than the window (stale)', () => {
    const map = new Map<number, string | null>([[1, iso(WINDOW + 1000)]]);
    const result = filterStale([titles[0]], map, NOW, WINDOW, false);
    expect(result).toEqual([titles[0]]);
  });

  it('keeps a title exactly at the window boundary (>= keeps)', () => {
    const map = new Map<number, string | null>([[1, iso(WINDOW)]]);
    const result = filterStale([titles[0]], map, NOW, WINDOW, false);
    expect(result).toEqual([titles[0]]);
  });

  it('keeps a never-synced title (null in map)', () => {
    const map = new Map<number, string | null>([[1, null]]);
    const result = filterStale([titles[0]], map, NOW, WINDOW, false);
    expect(result).toEqual([titles[0]]);
  });

  it('keeps a never-synced title (absent from map)', () => {
    const map = new Map<number, string | null>();
    const result = filterStale([titles[0]], map, NOW, WINDOW, false);
    expect(result).toEqual([titles[0]]);
  });

  it('force: true keeps ALL titles regardless of freshness', () => {
    const map = new Map<number, string | null>([
      [1, iso(60 * 1000)], // fresh
      [2, iso(WINDOW + 1000)], // stale
      [3, null], // never synced
    ]);
    const result = filterStale(titles, map, NOW, WINDOW, true);
    expect(result).toEqual(titles);
  });

  it('filters a mixed batch correctly', () => {
    const map = new Map<number, string | null>([
      [1, iso(60 * 1000)], // fresh → drop
      [2, iso(WINDOW + 1000)], // stale → keep
      [3, null], // never → keep
    ]);
    const result = filterStale(titles, map, NOW, WINDOW, false);
    expect(result).toEqual([titles[1], titles[2]]);
  });
});
