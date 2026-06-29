import { describe, expect, it } from 'vitest';
import { relativeTime } from './relative-time';

// Fixed reference instant so every tier boundary is deterministic.
const NOW = new Date('2026-06-29T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

describe('relativeTime', () => {
  it('"Just now" under a minute', () => {
    expect(relativeTime(ago(30 * SEC), NOW)).toBe('Just now');
  });

  it('"Just now" for a future timestamp (clock skew)', () => {
    expect(
      relativeTime(new Date(NOW.getTime() + 5000).toISOString(), NOW),
    ).toBe('Just now');
  });

  it('"Nm ago" under an hour', () => {
    expect(relativeTime(ago(5 * MIN), NOW)).toBe('5m ago');
    expect(relativeTime(ago(59 * MIN), NOW)).toBe('59m ago');
  });

  it('"Nh ago" under 24h', () => {
    expect(relativeTime(ago(2 * HOUR), NOW)).toBe('2h ago');
    expect(relativeTime(ago(23 * HOUR), NOW)).toBe('23h ago');
  });

  it('"Yesterday" between 24h and 48h', () => {
    expect(relativeTime(ago(24 * HOUR), NOW)).toBe('Yesterday');
    expect(relativeTime(ago(47 * HOUR), NOW)).toBe('Yesterday');
  });

  it('"N days ago" between 2 and 7 days', () => {
    expect(relativeTime(ago(2 * DAY), NOW)).toBe('2 days ago');
    expect(relativeTime(ago(6 * DAY), NOW)).toBe('6 days ago');
  });

  it('"1 week ago" then "N weeks ago"', () => {
    expect(relativeTime(ago(WEEK), NOW)).toBe('1 week ago');
    expect(relativeTime(ago(8 * DAY), NOW)).toBe('1 week ago');
    expect(relativeTime(ago(2 * WEEK), NOW)).toBe('2 weeks ago');
    expect(relativeTime(ago(3 * WEEK), NOW)).toBe('3 weeks ago');
  });

  it('short absolute date for older than ~4 weeks', () => {
    // 2026-06-29 minus ~6 weeks ≈ mid-May 2026.
    expect(relativeTime(ago(6 * WEEK), NOW)).toBe('18 May 2026');
  });

  it('falls back to the raw input for an unparseable string', () => {
    expect(relativeTime('not-a-date', NOW)).toBe('not-a-date');
  });
});
