/**
 * Seed mechanism (spec 0019 — single prescribed approach).
 *
 * NODE-SIDE ONLY. Reset = clear Auth + Firestore via the emulator REST clear
 * endpoints, then LOAD the chosen committed fixture by writing its docs to
 * Firestore via the emulator REST `documents` API under the resolved test uid.
 *
 * The fixtures (`emulator-data/{empty,seeded}/docs.json`) are PLAIN domain JSON;
 * the `{uid}` placeholder in each doc path is substituted with the real anon uid
 * resolved from the running app (R3 — see `resolveAnonUid` in `auth.ts`), and the
 * data is encoded to Firestore REST typed values by `encode.ts`. The REST writes
 * bypass `firestore.rules` (like the Admin SDK), so seeding needs no rule
 * allowance.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearAuth, clearFirestore, writeDocument } from './emulator';
import { encodeFields } from './encode';

/** The two committed fixture sets. */
export type FixtureName = 'empty' | 'seeded';

interface FixtureDoc {
  path: string;
  data: Record<string, unknown>;
}

interface FixtureFile {
  description?: string;
  docs: FixtureDoc[];
}

/** Absolute path to `apps/mobile-e2e/emulator-data`. */
const EMULATOR_DATA_DIR = join(__dirname, '..', '..', 'emulator-data');

function loadFixture(name: FixtureName): FixtureFile {
  const file = join(EMULATOR_DATA_DIR, name, 'docs.json');
  return JSON.parse(readFileSync(file, 'utf-8')) as FixtureFile;
}

/**
 * Clear Auth + Firestore, then load the named fixture under `uid`.
 *
 * Pass the uid the app actually resolved AFTER boot (see `resolveAnonUid`), so
 * the seeded `users/{uid}/...` docs line up with the app's live session (R3). A
 * mismatched uid would silently render an empty watchlist (owner mismatch).
 *
 * NOTE: clearing Auth removes the anon account the app created; the app keeps
 * its in-memory session/token for the page lifetime, so already-resolved Firestore
 * reads under that uid still work. Call this BEFORE the app boots for a clean
 * slate, or seed (without clearing Auth) after boot when the uid must come from
 * the live session — see `seedFor` for the post-boot variant.
 */
export async function resetAndSeed(
  uid: string,
  fixture: FixtureName,
): Promise<void> {
  await clearAuth();
  await clearFirestore();
  await seedFor(uid, fixture);
}

/**
 * Load the named fixture under `uid` WITHOUT clearing Auth (so the app's live
 * anon session is preserved). Use this after boot, once `resolveAnonUid` has
 * returned the session's uid, to avoid evicting the account the page is using.
 */
export async function seedFor(
  uid: string,
  fixture: FixtureName,
): Promise<void> {
  const { docs } = loadFixture(fixture);
  for (const doc of docs) {
    const path = doc.path.replace('{uid}', uid);
    await writeDocument(path, encodeFields(doc.data));
  }
}

/** Clear Auth + Firestore only (no seed). */
export async function clearAll(): Promise<void> {
  await clearAuth();
  await clearFirestore();
}
