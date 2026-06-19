import { describe, expect, it } from 'vitest';
import { isRateLimited } from './rate-limit';

const WINDOW = 5 * 60 * 1000; // 5 min
const NOW = 1_000_000_000;

describe('isRateLimited', () => {
  it('no prior run (null) → not limited', () => {
    expect(isRateLimited(null, NOW, WINDOW)).toBe(false);
  });

  it('last run within the window → limited', () => {
    expect(isRateLimited(NOW - (WINDOW - 1), NOW, WINDOW)).toBe(true);
    expect(isRateLimited(NOW - 1000, NOW, WINDOW)).toBe(true);
  });

  it('last run exactly at the window boundary (>=) → not limited', () => {
    expect(isRateLimited(NOW - WINDOW, NOW, WINDOW)).toBe(false);
  });

  it('last run older than the window → not limited', () => {
    expect(isRateLimited(NOW - (WINDOW + 1000), NOW, WINDOW)).toBe(false);
  });
});
