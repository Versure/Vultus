import { describe, expect, it } from 'vitest';
import type { WatchmodeSource } from './watchmode-client';
import type { CrosswalkEntry } from './watchmode-provider-map';
import {
  mapSearchToWatchmodeId,
  mapSourcesDtoToWatchmodeSources,
  mapSourcesToFlatrateProviders,
} from './watchmode-mappers';

const crosswalk: Record<number, CrosswalkEntry> = {
  203: { providerId: 8, name: 'Netflix' },
  372: { providerId: 337, name: 'Disney Plus' },
  26: { providerId: 9, name: 'Amazon Prime Video' },
};

describe('mapSearchToWatchmodeId', () => {
  it('returns the first title_results id', () => {
    expect(
      mapSearchToWatchmodeId({
        title_results: [{ id: 111 }, { id: 222 }],
      }),
    ).toBe(111);
  });

  it('returns null on empty / missing title_results', () => {
    expect(mapSearchToWatchmodeId({ title_results: [] })).toBeNull();
    expect(mapSearchToWatchmodeId({})).toBeNull();
  });

  it('returns null when the first result lacks a numeric id', () => {
    expect(
      mapSearchToWatchmodeId({
        title_results: [{ id: undefined as unknown as number }],
      }),
    ).toBeNull();
  });
});

describe('mapSourcesDtoToWatchmodeSources', () => {
  it('keeps REGIONS rows with a known type; drops others', () => {
    const result = mapSourcesDtoToWatchmodeSources([
      { source_id: 203, type: 'sub', region: 'NL' },
      { source_id: 26, type: 'buy', region: 'DE' },
      { source_id: 8, type: 'sub', region: 'JP' }, // non-REGIONS
      { source_id: 5, type: 'tv', region: 'NL' }, // unknown type
    ]);
    expect(result).toEqual([
      { sourceId: 203, type: 'sub', region: 'NL' },
      { sourceId: 26, type: 'buy', region: 'DE' },
    ]);
  });
});

describe('mapSourcesToFlatrateProviders', () => {
  it('keeps only sub rows, maps via crosswalk, produces flatrate providers per region', () => {
    const sources: WatchmodeSource[] = [
      { sourceId: 203, type: 'sub', region: 'NL' },
      { sourceId: 372, type: 'sub', region: 'NL' },
      { sourceId: 26, type: 'rent', region: 'NL' }, // not sub → ignored
      { sourceId: 203, type: 'sub', region: 'DE' },
    ];
    const { fill, dropped } = mapSourcesToFlatrateProviders(sources, crosswalk);
    expect(dropped).toBe(0);
    expect(fill.NL).toEqual([
      { providerId: 8, name: 'Netflix', type: 'flatrate' },
      { providerId: 337, name: 'Disney Plus', type: 'flatrate' },
    ]);
    expect(fill.DE).toEqual([
      { providerId: 8, name: 'Netflix', type: 'flatrate' },
    ]);
  });

  it('drops (and counts) a sub source with no crosswalk entry — never guesses', () => {
    const sources: WatchmodeSource[] = [
      { sourceId: 203, type: 'sub', region: 'NL' },
      { sourceId: 99999, type: 'sub', region: 'NL' }, // unmapped
    ];
    const { fill, dropped } = mapSourcesToFlatrateProviders(sources, crosswalk);
    expect(dropped).toBe(1);
    expect(fill.NL).toEqual([
      { providerId: 8, name: 'Netflix', type: 'flatrate' },
    ]);
  });

  it('dedupes by providerId per region (first occurrence wins)', () => {
    const sources: WatchmodeSource[] = [
      { sourceId: 203, type: 'sub', region: 'NL' },
      { sourceId: 203, type: 'sub', region: 'NL' },
    ];
    const { fill } = mapSourcesToFlatrateProviders(sources, crosswalk);
    expect(fill.NL).toEqual([
      { providerId: 8, name: 'Netflix', type: 'flatrate' },
    ]);
  });

  it('ignores rent/buy/free entirely (flatrate = subscription only)', () => {
    const sources: WatchmodeSource[] = [
      { sourceId: 203, type: 'rent', region: 'NL' },
      { sourceId: 372, type: 'buy', region: 'NL' },
      { sourceId: 26, type: 'free', region: 'NL' },
    ];
    const { fill, dropped } = mapSourcesToFlatrateProviders(sources, crosswalk);
    expect(dropped).toBe(0);
    expect(fill.NL).toBeUndefined();
  });
});
