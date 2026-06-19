// Admin-SDK-backed implementation of the engine's TitleCacheStore port (spec
// 0008). This is the ONLY place `firebase-admin` enters the slice — the engine
// stays SDK-free. It is a thin map: domain types onto the spec-0005 path
// builders + converters (`titleCacheDocPath` / `availabilityPath` /
// `availabilityDocPath` + `dataToTitleCache` / `titleCacheToData` /
// `dataToAvailability` / `availabilityToData`). NO business logic — transition
// detection + the snapshot roll live in the engine.

import type { Firestore } from 'firebase-admin/firestore';
import type {
  Region,
  RegionAvailability,
  TitleCacheEntry,
} from '@vultus/shared/domain';
import {
  availabilityDocPath,
  availabilityPath,
  availabilityToData,
  dataToAvailability,
  dataToTitleCache,
  titleCacheDocPath,
  titleCacheToData,
  type RegionAvailabilityReadData,
  type TitleCacheReadData,
} from '@vultus/shared/firestore-schema';
import type { TitleCacheStore } from '../engine/store';

export function createFirestoreTitleCacheStore(db: Firestore): TitleCacheStore {
  return {
    async getEntry(tmdbId: number): Promise<TitleCacheEntry | null> {
      const snap = await db.doc(titleCacheDocPath(tmdbId)).get();
      return snap.exists
        ? dataToTitleCache(snap.data() as TitleCacheReadData)
        : null;
    },

    async getAvailability(
      tmdbId: number,
    ): Promise<Partial<Record<Region, RegionAvailability>>> {
      const snap = await db.collection(availabilityPath(tmdbId)).get();
      const result: Partial<Record<Region, RegionAvailability>> = {};
      for (const doc of snap.docs) {
        result[doc.id as Region] = dataToAvailability(
          doc.data() as RegionAvailabilityReadData,
        );
      }
      return result;
    },

    async putEntry(tmdbId: number, entry: TitleCacheEntry): Promise<void> {
      await db.doc(titleCacheDocPath(tmdbId)).set(titleCacheToData(entry));
    },

    async putAvailability(
      tmdbId: number,
      region: Region,
      availability: RegionAvailability,
    ): Promise<void> {
      await db
        .doc(availabilityDocPath(tmdbId, region))
        .set(availabilityToData(availability));
    },
  };
}
