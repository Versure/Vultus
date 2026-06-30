// Deterministic episode document id + new-doc builder. The id encodes season +
// episode so the merge filter can compare against existing Firestore doc ids
// without a query per episode, and so re-syncs are idempotent.

import type { Episode, EpisodeDoc } from '@vultus/shared/domain';

/** `s${SS}e${EEE}` — season zero-padded to 2, episode to 3 (e.g. `s01e001`).
 *  Padding is a floor, not a cap: a season >= 100 or episode >= 1000 keeps its
 *  full digits (e.g. `s10e100`, `s100e1000`). */
export function episodeId(season: number, episode: number): string {
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(3, '0');
  return `s${s}e${e}`;
}

/** Build a fresh `EpisodeDoc` for insertion. Always starts unwatched —
 *  `watched: false`, `watchedAt: null` — so a sync never disturbs a user's
 *  watched state (and existing docs are filtered out before this is ever
 *  called). `season`, `episode`, `title`, `airDate` carry straight from the
 *  domain `Episode`. */
export function newEpisodeDoc(ep: Episode): EpisodeDoc {
  return {
    season: ep.season,
    episode: ep.episode,
    title: ep.title,
    airDate: ep.airDate,
    watched: false,
    watchedAt: null,
  };
}
