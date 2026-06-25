/**
 * e2e support aggregator (spec 0019). The single import surface the flow specs
 * use: `import { resolveAnonUid, seedFor, routeTmdb } from './support'`.
 *
 * This is a plain re-export FILE (not a barrel `index.ts`): under Sheriff's
 * barrel-less mode an `index.ts` would make `src/support/` its own module and
 * trip the dependency rule against the (prefix-matched) `apps/mobile` tag. As a
 * file it stays part of the single untagged `apps/mobile-e2e` module.
 *
 * NOTE: `apps/mobile-e2e` imports NO workspace source (black-box browser +
 * emulator REST only) — no Sheriff scope/slice boundary applies.
 */
export { resolveAnonUid } from './support/auth';
export { routeTmdb, type TmdbFixtureName } from './support/tmdb';
export {
  resetAndSeed,
  seedFor,
  clearAll,
  type FixtureName,
} from './support/seed';
export {
  PROJECT_ID,
  firestoreHost,
  authHost,
  clearFirestore,
  clearAuth,
  writeDocument,
  readDocument,
} from './support/emulator';
export {
  encodeFields,
  encodeValue,
  type TimestampMarker,
} from './support/encode';
