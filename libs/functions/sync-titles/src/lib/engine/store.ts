// The persistence boundary the sync engine writes through. Domain-typed and
// Firebase-free: the engine NEVER imports a Firebase SDK. The real adapter that
// implements this port with the Admin SDK (titleCacheDocPath /
// availabilityDocPath + the spec-0005 converters) is the #12 HTTP-function
// spec's thin wiring layer. All methods key on tmdbId / Region — the same keys
// as the PLAN §4 title-cache paths.

import type {
  Region,
  RegionAvailability,
  TitleCacheEntry,
} from '@vultus/shared/domain';

export interface TitleCacheStore {
  /** Current cached entry for a title, or null if never synced. */
  getEntry(tmdbId: number): Promise<TitleCacheEntry | null>;
  /** Current per-region availability for a title; a region absent from the map
   *  means "never synced for that region". */
  getAvailability(
    tmdbId: number,
  ): Promise<Partial<Record<Region, RegionAvailability>>>;
  /** Write (create or overwrite) the title's cache entry. */
  putEntry(tmdbId: number, entry: TitleCacheEntry): Promise<void>;
  /** Write (create or overwrite) one region's availability for the title. */
  putAvailability(
    tmdbId: number,
    region: Region,
    availability: RegionAvailability,
  ): Promise<void>;
}
