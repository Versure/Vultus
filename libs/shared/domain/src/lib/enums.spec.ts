import { describe, expect, it } from 'vitest';
import { REGIONS, REGION_DISPLAY_NAMES, regionDisplayName } from './enums';

describe('REGION_DISPLAY_NAMES', () => {
  it('has a display name for exactly the REGIONS codes (as a set)', () => {
    expect(new Set(Object.keys(REGION_DISPLAY_NAMES))).toEqual(
      new Set(REGIONS),
    );
  });

  it('maps every region to a non-empty string', () => {
    for (const region of REGIONS) {
      expect(typeof REGION_DISPLAY_NAMES[region]).toBe('string');
      expect(REGION_DISPLAY_NAMES[region].length).toBeGreaterThan(0);
    }
  });
});

describe('regionDisplayName', () => {
  it('returns the issue-example endonyms', () => {
    expect(regionDisplayName('NL')).toBe('Nederland');
    expect(regionDisplayName('DE')).toBe('Deutschland');
    expect(regionDisplayName('GB')).toBe('United Kingdom');
  });

  it('returns the value from REGION_DISPLAY_NAMES for every region', () => {
    for (const region of REGIONS) {
      expect(regionDisplayName(region)).toBe(REGION_DISPLAY_NAMES[region]);
    }
  });
});
