import { describe, expect, it } from 'vitest';
import { WATCHMODE_TO_TMDB_PROVIDER } from './watchmode-provider-map';

describe('WATCHMODE_TO_TMDB_PROVIDER crosswalk (spec 0099)', () => {
  const entries = Object.entries(WATCHMODE_TO_TMDB_PROVIDER);

  it('every source_id key is a positive integer', () => {
    for (const [key] of entries) {
      const sourceId = Number(key);
      expect(Number.isInteger(sourceId)).toBe(true);
      expect(sourceId).toBeGreaterThan(0);
    }
  });

  it('every entry has a positive TMDB providerId and a non-empty name', () => {
    for (const [, entry] of entries) {
      expect(Number.isInteger(entry.providerId)).toBe(true);
      expect(entry.providerId).toBeGreaterThan(0);
      expect(typeof entry.name).toBe('string');
      expect(entry.name.trim().length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate TMDB providerId (each service mapped once)', () => {
    const providerIds = entries.map(([, e]) => e.providerId);
    expect(new Set(providerIds).size).toBe(providerIds.length);
  });

  it('contains the known global flatrate majors by TMDB providerId', () => {
    const providerIds = new Set(entries.map(([, e]) => e.providerId));
    // Netflix(8), Amazon Prime Video(9), Disney+(337), Max/HBO Max(1899),
    // Apple TV+(350) — the region-agnostic global majors decision 3 requires.
    for (const majorId of [8, 9, 337, 1899, 350]) {
      expect(providerIds.has(majorId)).toBe(true);
    }
  });
});
