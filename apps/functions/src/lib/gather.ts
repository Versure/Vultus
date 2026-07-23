/**
 * Pure dedupe of the gathered watchlist titles (spec 0009 "Gather").
 *
 * The `collectionGroup('watchlist')` scan yields one entry per (user, title);
 * a title tracked by N users appears N times. The engine syncs the GLOBAL union
 * of distinct titles — a title is synced once regardless of how many users track
 * it — so we dedupe by `tmdbId`. Distinct tmdbIds and the movie/tv mix are
 * preserved; an empty input → `[]`.
 */
import type { TitleType } from '@vultus/shared/domain';

export interface GatheredTitle {
  tmdbId: number;
  type: TitleType;
}

/** Distinct `{ tmdbId, type }` keyed by `tmdbId`, preserving first-seen order. */
export function dedupeTitles(items: GatheredTitle[]): GatheredTitle[] {
  const seen = new Map<number, GatheredTitle>();
  for (const item of items) {
    if (!seen.has(item.tmdbId)) {
      seen.set(item.tmdbId, { tmdbId: item.tmdbId, type: item.type });
    }
  }
  return [...seen.values()];
}

/**
 * One raw entry from the consolidated `collectionGroup('watchlist')` gather: which
 * user (`uid`, the parent document id) tracks which title (`titleId`, the watchlist
 * doc id) and the title's `tmdbId`/`type`. Richer than `GatheredTitle` because the
 * downstream episode fan-out + airing-scan stages need the (uid, titleId) tuple, not
 * just the distinct title union the title-sync stage consumes.
 */
export interface GatheredEntry {
  uid: string;
  titleId: string;
  tmdbId: number;
  type: TitleType;
}

/** One TV episode fan-out assignment (TV only). Structurally the tracker's
 *  `StagedAssignment` — the consolidated gather emits these for the fan-out stage. */
export interface GatheredAssignment {
  uid: string;
  titleId: string;
  tmdbId: number;
}

/** The consolidated single-gather output — every downstream stage's input. */
export interface ConsolidatedGather {
  /** Distinct titles (deduped by `tmdbId`) — the title-sync stage's work. */
  titles: GatheredTitle[];
  /** One assignment per (uid, titleId) TV entry — the episode fan-out stage. */
  assignments: GatheredAssignment[];
  /** Distinct TV show `tmdbId`s — the episode-cache stage (fetch once per show). */
  shows: number[];
  /** Distinct uids that track ≥1 TV title — the airing-scan stage. */
  uids: string[];
}

/**
 * Fold ONE watchlist gather into every downstream stage's input in a single pass
 * (spec 0101 T8), so the nightly pipeline reads the whole watchlist collection group
 * exactly once per run (down from three separate gathers).
 *
 * - `titles` = the distinct `{ tmdbId, type }` union (via `dedupeTitles`) — a title
 *   tracked by N users is synced once.
 * - `assignments` = one `{ uid, titleId, tmdbId }` per **TV** watchlist entry — the
 *   per-user fan-out writes cached episodes to each tracking user's docs.
 * - `shows` = the distinct **TV** `tmdbId`s — each show's episodes are fetched once.
 * - `uids` = the distinct uids that track **at least one TV title**.
 *
 * **uid-emission choice (documented + tested).** The airing scan re-reads each uid's
 * OWN watchlist and acts ONLY on `type === 'tv'` entries
 * (`dispatch-episode-aired.ts` `runEpisodeAiredScan`). A movie-only user has no TV
 * title for the scan to act on, so including its uid would only cost a wasted per-uid
 * read that finds nothing. Emitting the uids that track ≥1 TV title is therefore
 * both **sufficient** and **minimal**, and matches the pre-0101 airing-scan gather
 * semantics (which enumerated watchlist docs and only acted on TV titles). A
 * consequence: `shows`, `assignments`, and `uids` are all non-empty iff there is ≥1
 * TV entry — so "no TV content" is a single condition the coordinator keys the
 * healthy-no-op path off.
 */
export function consolidateGather(
  entries: GatheredEntry[],
): ConsolidatedGather {
  const titles = dedupeTitles(
    entries.map((e) => ({ tmdbId: e.tmdbId, type: e.type })),
  );
  const assignments: GatheredAssignment[] = [];
  const shows: number[] = [];
  const showSeen = new Set<number>();
  const uids: string[] = [];
  const uidSeen = new Set<string>();
  for (const e of entries) {
    if (e.type !== 'tv') continue;
    assignments.push({ uid: e.uid, titleId: e.titleId, tmdbId: e.tmdbId });
    if (!showSeen.has(e.tmdbId)) {
      showSeen.add(e.tmdbId);
      shows.push(e.tmdbId);
    }
    if (!uidSeen.has(e.uid)) {
      uidSeen.add(e.uid);
      uids.push(e.uid);
    }
  }
  return { titles, assignments, shows, uids };
}
