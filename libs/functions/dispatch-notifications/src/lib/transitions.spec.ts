import { describe, expect, it } from 'vitest';
import type { WatchProvider } from '@vultus/shared/domain';
import {
  classifyFlatrateTransition,
  decideKinds,
  hasFlatrate,
} from './transitions';

const flatrate = (id: number, name = `p${id}`): WatchProvider => ({
  providerId: id,
  name,
  type: 'flatrate',
});
const rent = (id: number, name = `p${id}`): WatchProvider => ({
  providerId: id,
  name,
  type: 'rent',
});
const buy = (id: number, name = `p${id}`): WatchProvider => ({
  providerId: id,
  name,
  type: 'buy',
});

describe('classifyFlatrateTransition', () => {
  it('0 → 1 flatrate is "appeared"', () => {
    expect(classifyFlatrateTransition([], [flatrate(1)])).toBe('appeared');
  });

  it('2 → 0 flatrate is "removed"', () => {
    expect(classifyFlatrateTransition([flatrate(1), flatrate(2)], [])).toBe(
      'removed',
    );
  });

  it('1 → 1 flatrate is "unchanged"', () => {
    expect(classifyFlatrateTransition([flatrate(1)], [flatrate(2)])).toBe(
      'unchanged',
    );
  });

  it('rent/buy-only changes are "unchanged"', () => {
    expect(classifyFlatrateTransition([rent(1)], [rent(2), buy(3)])).toBe(
      'unchanged',
    );
  });

  it('only flatrate counts: adding rent to existing flatrate is "unchanged"', () => {
    expect(
      classifyFlatrateTransition([flatrate(1)], [flatrate(1), rent(2)]),
    ).toBe('unchanged');
  });

  it('switching the sole flatrate to rent (1 → 0 flatrate) is "removed"', () => {
    expect(classifyFlatrateTransition([flatrate(1)], [rent(1)])).toBe(
      'removed',
    );
  });

  it('gaining flatrate while keeping rent (0 → 1 flatrate) is "appeared"', () => {
    expect(classifyFlatrateTransition([rent(1)], [rent(1), flatrate(2)])).toBe(
      'appeared',
    );
  });
});

describe('hasFlatrate', () => {
  it('true with at least one flatrate', () => {
    expect(hasFlatrate([rent(1), flatrate(2)])).toBe(true);
  });

  it('false with only rent/buy', () => {
    expect(hasFlatrate([rent(1), buy(2)])).toBe(false);
  });

  it('false on empty', () => {
    expect(hasFlatrate([])).toBe(false);
  });
});

describe('decideKinds', () => {
  const NOW = '2026-06-22T00:00:00.000Z';

  it('appeared + movie → ["movie-available"]', () => {
    expect(
      decideKinds({
        type: 'movie',
        transition: 'appeared',
        hasFlatrateNow: true,
        episodeAirDates: [],
        now: NOW,
      }),
    ).toEqual(['movie-available']);
  });

  it('appeared + tv with no episodes → ["show-came-to-platform"]', () => {
    expect(
      decideKinds({
        type: 'tv',
        transition: 'appeared',
        hasFlatrateNow: true,
        episodeAirDates: [],
        now: NOW,
      }),
    ).toEqual(['show-came-to-platform']);
  });

  it('tv + hasFlatrateNow + episode airDate <= now → includes "episode-aired"', () => {
    expect(
      decideKinds({
        type: 'tv',
        transition: 'unchanged',
        hasFlatrateNow: true,
        episodeAirDates: ['2026-06-21T00:00:00.000Z'],
        now: NOW,
      }),
    ).toEqual(['episode-aired']);
  });

  it('tv that both appeared AND has an aired episode → both kinds', () => {
    expect(
      decideKinds({
        type: 'tv',
        transition: 'appeared',
        hasFlatrateNow: true,
        episodeAirDates: ['2026-06-20T00:00:00.000Z'],
        now: NOW,
      }),
    ).toEqual(['show-came-to-platform', 'episode-aired']);
  });

  it('removed → [] (no notification)', () => {
    expect(
      decideKinds({
        type: 'movie',
        transition: 'removed',
        hasFlatrateNow: false,
        episodeAirDates: [],
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('tv + hasFlatrateNow but all episode airDates > now → no "episode-aired"', () => {
    expect(
      decideKinds({
        type: 'tv',
        transition: 'unchanged',
        hasFlatrateNow: true,
        episodeAirDates: ['2026-06-23T00:00:00.000Z'],
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('tv with aired episode but not on flatrate now → no "episode-aired"', () => {
    expect(
      decideKinds({
        type: 'tv',
        transition: 'unchanged',
        hasFlatrateNow: false,
        episodeAirDates: ['2026-06-20T00:00:00.000Z'],
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('movie never yields "episode-aired" even with aired dates and flatrate', () => {
    expect(
      decideKinds({
        type: 'movie',
        transition: 'unchanged',
        hasFlatrateNow: true,
        episodeAirDates: ['2026-06-20T00:00:00.000Z'],
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('episode airing exactly at now is included (<= boundary)', () => {
    expect(
      decideKinds({
        type: 'tv',
        transition: 'unchanged',
        hasFlatrateNow: true,
        episodeAirDates: [NOW],
        now: NOW,
      }),
    ).toEqual(['episode-aired']);
  });
});
