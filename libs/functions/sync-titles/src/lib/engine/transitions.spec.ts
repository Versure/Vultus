import { describe, expect, it } from 'vitest';
import type { WatchProvider } from '@vultus/shared/domain';
import { detectTransitions } from './transitions';

const netflix: WatchProvider = {
  providerId: 8,
  name: 'Netflix',
  type: 'flatrate',
};
const disney: WatchProvider = {
  providerId: 337,
  name: 'Disney Plus',
  type: 'flatrate',
};
const apple: WatchProvider = {
  providerId: 350,
  name: 'Apple TV',
  type: 'rent',
};

describe('detectTransitions', () => {
  it('flags a provider that appears as added', () => {
    const result = detectTransitions('NL', [], [netflix]);
    expect(result).toEqual([
      {
        region: 'NL',
        providerId: 8,
        name: 'Netflix',
        type: 'flatrate',
        kind: 'added',
      },
    ]);
  });

  it('flags a provider that disappears as removed', () => {
    const result = detectTransitions('DE', [netflix], []);
    expect(result).toEqual([
      {
        region: 'DE',
        providerId: 8,
        name: 'Netflix',
        type: 'flatrate',
        kind: 'removed',
      },
    ]);
  });

  it('produces no transition for an unchanged provider', () => {
    const result = detectTransitions('NL', [netflix], [netflix]);
    expect(result).toEqual([]);
  });

  it('treats every provider as added on a first-ever sync (prev empty)', () => {
    const result = detectTransitions('US', [], [netflix, disney]);
    expect(result).toHaveLength(2);
    expect(result.every((t) => t.kind === 'added')).toBe(true);
    expect(result.map((t) => t.providerId).sort((a, b) => a - b)).toEqual([
      8, 337,
    ]);
  });

  it('handles a mix of added, removed, and unchanged', () => {
    // prev: netflix + apple; next: netflix + disney
    // → disney added, apple removed, netflix unchanged
    const result = detectTransitions('NL', [netflix, apple], [netflix, disney]);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({
      region: 'NL',
      providerId: 337,
      name: 'Disney Plus',
      type: 'flatrate',
      kind: 'added',
    });
    expect(result).toContainEqual({
      region: 'NL',
      providerId: 350,
      name: 'Apple TV',
      type: 'rent',
      kind: 'removed',
    });
  });

  it('flags every prior provider as removed when next is empty', () => {
    const result = detectTransitions('GB', [netflix, disney], []);
    expect(result).toHaveLength(2);
    expect(result.every((t) => t.kind === 'removed')).toBe(true);
  });
});
