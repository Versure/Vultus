import { describe, expect, it } from 'vitest';
import type { Episode } from '@vultus/shared/domain';
import { episodeId, newEpisodeDoc } from './episode-id';

describe('episodeId', () => {
  it('pads season to 2 and episode to 3 digits', () => {
    expect(episodeId(1, 1)).toBe('s01e001');
    expect(episodeId(1, 10)).toBe('s01e010');
    expect(episodeId(2, 1)).toBe('s02e001');
    expect(episodeId(10, 1)).toBe('s10e001');
  });

  it('does not truncate values wider than the pad floor', () => {
    expect(episodeId(10, 100)).toBe('s10e100');
    expect(episodeId(1, 100)).toBe('s01e100');
  });
});

describe('newEpisodeDoc', () => {
  const ep: Episode = {
    season: 3,
    episode: 7,
    title: 'The One With The Test',
    airDate: '2026-01-02T00:00:00.000Z',
  };

  it('always starts unwatched (watched: false, watchedAt: null)', () => {
    const doc = newEpisodeDoc(ep);
    expect(doc.watched).toBe(false);
    expect(doc.watchedAt).toBeNull();
  });

  it('carries season, episode, title, airDate from the input', () => {
    const doc = newEpisodeDoc(ep);
    expect(doc.season).toBe(3);
    expect(doc.episode).toBe(7);
    expect(doc.title).toBe('The One With The Test');
    expect(doc.airDate).toBe('2026-01-02T00:00:00.000Z');
  });

  it('preserves a null title', () => {
    const doc = newEpisodeDoc({ ...ep, title: null });
    expect(doc.title).toBeNull();
  });
});
