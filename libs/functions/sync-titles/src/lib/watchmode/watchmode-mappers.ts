// DTO → domain mapping for the Watchmode client. Pure functions (no I/O) — the
// priority unit-test surface. Slice-internal: NOT exported from the barrel.

import {
  REGIONS,
  type Region,
  type WatchProvider,
} from '@vultus/shared/domain';
import type {
  WatchmodeSearchResponse,
  WatchmodeSourceDto,
} from './watchmode-dtos';
import type { WatchmodeSource } from './watchmode-client';
import type { CrosswalkEntry } from './watchmode-provider-map';

const REGION_SET = new Set<string>(REGIONS);
const SOURCE_TYPES = new Set(['sub', 'rent', 'buy', 'free']);

/** Pull the Watchmode title id from a `/search/` response. First title result
 *  wins; no results / malformed → null. */
export function mapSearchToWatchmodeId(
  dto: WatchmodeSearchResponse,
): number | null {
  const first = dto.title_results?.[0];
  if (!first || typeof first.id !== 'number') return null;
  return first.id;
}

/** Map raw `/title/{id}/sources/` DTO rows to WatchmodeSource[], keeping only
 *  rows in a REGIONS country and a known availability `type`. Rows in an
 *  unknown region or with an unknown type are dropped (they cannot contribute
 *  to the flatrate fill). */
export function mapSourcesDtoToWatchmodeSources(
  dtos: WatchmodeSourceDto[],
): WatchmodeSource[] {
  const out: WatchmodeSource[] = [];
  for (const dto of dtos) {
    if (!REGION_SET.has(dto.region)) continue;
    if (!SOURCE_TYPES.has(dto.type)) continue;
    out.push({
      sourceId: dto.source_id,
      type: dto.type as WatchmodeSource['type'],
      region: dto.region as Region,
    });
  }
  return out;
}

/** Result of the flatrate fill: the per-region providers plus a count of
 *  sources dropped because no crosswalk entry maps their Watchmode source_id. */
export interface FlatrateFillResult {
  fill: Partial<Record<Region, WatchProvider[]>>;
  dropped: number;
}

/** Keep ONLY `sub`-type sources (decision 4: sub → flatrate; rent/buy/free
 *  ignored), map each Watchmode `source_id` → TMDB `{ providerId, name }` via
 *  the crosswalk (unmapped source_id → DROPPED, counted), and produce a
 *  per-region `WatchProvider[]` (type 'flatrate'), deduped by providerId. */
export function mapSourcesToFlatrateProviders(
  sources: WatchmodeSource[],
  crosswalk: Record<number, CrosswalkEntry>,
): FlatrateFillResult {
  const byRegion = new Map<Region, Map<number, WatchProvider>>();
  let dropped = 0;

  for (const source of sources) {
    if (source.type !== 'sub') continue; // flatrate = subscription only
    const entry = crosswalk[source.sourceId];
    if (!entry) {
      // No crosswalk entry → drop (never guess); count for diagnostics.
      dropped += 1;
      continue;
    }
    let regionMap = byRegion.get(source.region);
    if (!regionMap) {
      regionMap = new Map<number, WatchProvider>();
      byRegion.set(source.region, regionMap);
    }
    // Dedupe by providerId per region (first occurrence wins).
    if (regionMap.has(entry.providerId)) continue;
    regionMap.set(entry.providerId, {
      providerId: entry.providerId,
      name: entry.name,
      type: 'flatrate',
    });
  }

  const fill: Partial<Record<Region, WatchProvider[]>> = {};
  for (const [region, regionMap] of byRegion) {
    fill[region] = [...regionMap.values()];
  }
  return { fill, dropped };
}
