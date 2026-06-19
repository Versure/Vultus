import { describe, expect, it } from 'vitest';
import { mapWatchProviders, normalizeDate } from './mappers';

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
