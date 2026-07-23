import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';

// Emulator-backed security-rules tests for Vultus (PLAN §4 access control).
//
// This file is named `*.rules.spec.ts` so it is ONLY collected by
// `vitest.rules.config.mts` (the `test-rules` target / `pnpm test:rules`), which
// runs it under `firebase emulators:exec --only firestore`. `emulators:exec`
// sets FIRESTORE_EMULATOR_HOST, which initializeTestEnvironment reads
// AUTOMATICALLY — so we do NOT hardcode the emulator host here. The 8080 in
// firebase.json is only a documented fallback. We load the committed, real
// `firestore.rules` from the repo root so the rules under test are exactly the
// ones that ship.

// From tools/firestore-rules-test/src up to the repo root.
const repoRoot = join(__dirname, '..', '..', '..');
const rules = readFileSync(join(repoRoot, 'firestore.rules'), 'utf8');

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    // Fake project id — the emulator runs with no real credentials (€0 / no
    // secret invariant). Host/port come from FIRESTORE_EMULATOR_HOST.
    projectId: 'vultus-rules-test',
    firestore: { rules },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

describe('users/** — owner-only', () => {
  it('1. owner can read+write their own watchlist title and an episode', async () => {
    const userA = testEnv.authenticatedContext('userA').firestore();

    const titleRef = doc(userA, 'users/userA/watchlist/title1');
    const episodeRef = doc(userA, 'users/userA/watchlist/title1/episodes/ep1');

    await assertSucceeds(setDoc(titleRef, { type: 'tv', title: 'Severance' }));
    await assertSucceeds(getDoc(titleRef));
    await assertSucceeds(
      setDoc(episodeRef, { season: 1, episode: 1, watched: false }),
    );
    await assertSucceeds(getDoc(episodeRef));
  });

  it('2. a different user is denied on another user’s watchlist', async () => {
    const userB = testEnv.authenticatedContext('userB').firestore();
    const titleRef = doc(userB, 'users/userA/watchlist/title1');

    await assertFails(getDoc(titleRef));
    await assertFails(setDoc(titleRef, { type: 'tv', title: 'Severance' }));
  });

  it('3. an unauthenticated context is denied on any users/** path', async () => {
    const anon = testEnv.unauthenticatedContext().firestore();
    const titleRef = doc(anon, 'users/userA/watchlist/title1');

    await assertFails(getDoc(titleRef));
    await assertFails(setDoc(titleRef, { type: 'tv', title: 'Severance' }));
  });

  it('4. an anonymous-style owner (uid == doc owner) is allowed', async () => {
    // Firebase Auth assigns request.auth.uid for anonymous users; an anonymous
    // signed-in user whose uid equals the doc owner is a legitimate owner.
    const anonOwner = testEnv
      .authenticatedContext('anonUid123', {
        firebase: { sign_in_provider: 'anonymous' },
      })
      .firestore();

    const titleRef = doc(anonOwner, 'users/anonUid123/watchlist/title1');

    await assertSucceeds(setDoc(titleRef, { type: 'movie', title: 'Dune' }));
    await assertSucceeds(getDoc(titleRef));
  });
});

describe('title-cache/** — authenticated read, never client-write', () => {
  beforeEach(async () => {
    // Seed the shared cache via a rules-bypassing admin context so the read
    // tests have something to fetch.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const admin = ctx.firestore();
      await setDoc(doc(admin, 'title-cache/603'), {
        type: 'movie',
        metadata: {},
      });
      await setDoc(doc(admin, 'title-cache/603/availability/NL'), {
        providers: [],
      });
    });
  });

  it('5. an authenticated user can read title-cache and its availability', async () => {
    const user = testEnv.authenticatedContext('userA').firestore();

    await assertSucceeds(getDoc(doc(user, 'title-cache/603')));
    await assertSucceeds(getDoc(doc(user, 'title-cache/603/availability/NL')));
  });

  it('6. an authenticated user writing title-cache (or availability) is denied', async () => {
    const user = testEnv.authenticatedContext('userA').firestore();

    await assertFails(
      setDoc(doc(user, 'title-cache/603'), { type: 'movie', metadata: {} }),
    );
    await assertFails(
      setDoc(doc(user, 'title-cache/603/availability/NL'), { providers: [] }),
    );
  });
});

describe('title-cache/*/episodes/** — global episode cache, NEVER client-readable (spec 0101)', () => {
  beforeEach(async () => {
    // Seed the global episode cache via a rules-bypassing admin context. The
    // cache is written ONLY by Cloud Functions (episodeCacheWorker) via the
    // Admin SDK, which bypasses these rules; no client ever reads it (mobile
    // reads its own per-user episode docs, not the global cache). The
    // `episodes/*` subcollection is NOT matched by the `title-cache/{tmdbId}`
    // rule (which grants read only on the doc + its `availability/{region}`
    // subcollection), so it falls to default-deny — asserted below.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const admin = ctx.firestore();
      await setDoc(doc(admin, 'title-cache/603/episodes/s01e001'), {
        season: 1,
        episode: 1,
        title: 'Pilot',
        airDate: '2026-01-01T00:00:00.000Z',
        lastSyncedAt: '2026-07-22T00:00:00.000Z',
      });
    });
  });

  it('11. an authenticated user reading the global episode cache is denied (default-deny)', async () => {
    const user = testEnv.authenticatedContext('userA').firestore();

    await assertFails(getDoc(doc(user, 'title-cache/603/episodes/s01e001')));
  });
});

describe('sync-runs/** — authenticated read (finalized summary), NEVER client-write (regression guard)', () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const admin = ctx.firestore();
      await setDoc(doc(admin, 'sync-runs/run1'), {
        runId: 'run1',
        kind: 'cron',
        startedAt: '2026-07-22T00:00:00.000Z',
        completedAt: '2026-07-22T00:20:00.000Z',
      });
    });
  });

  it('12. an authenticated user can read a finalized sync-runs summary doc', async () => {
    const user = testEnv.authenticatedContext('userA').firestore();

    await assertSucceeds(getDoc(doc(user, 'sync-runs/run1')));
  });
});

describe('sync-run-progress/** — in-flight staging, NEVER client-readable (spec 0101)', () => {
  beforeEach(async () => {
    // Seed the staging collection via a rules-bypassing admin context. All
    // in-flight shard/stage progress lives here, written ONLY by Cloud
    // Functions via the Admin SDK (which bypasses these rules). No rule matches
    // `sync-run-progress/**`, so it falls to default-deny — clients read only
    // the finalized `sync-runs/{runId}` summary, never the staging progress.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const admin = ctx.firestore();
      await setDoc(doc(admin, 'sync-run-progress/run1'), {
        runId: 'run1',
        finalized: false,
      });
      await setDoc(doc(admin, 'sync-run-progress/run1/shards/titleSync-0'), {
        stage: 'titleSync',
        shardIndex: 0,
      });
    });
  });

  it('13. an authenticated user reading a sync-run-progress staging doc is denied (default-deny)', async () => {
    const user = testEnv.authenticatedContext('userA').firestore();

    await assertFails(getDoc(doc(user, 'sync-run-progress/run1')));
  });

  it('14. an authenticated user reading a sync-run-progress shard subdoc is denied (default-deny)', async () => {
    const user = testEnv.authenticatedContext('userA').firestore();

    await assertFails(
      getDoc(doc(user, 'sync-run-progress/run1/shards/titleSync-0')),
    );
  });
});

describe('provider-catalog/** — authenticated read, never client-write', () => {
  beforeEach(async () => {
    // Seed the shared catalog via a rules-bypassing admin context so the read
    // tests have something to fetch.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const admin = ctx.firestore();
      await setDoc(doc(admin, 'provider-catalog/NL'), {
        providers: [],
        lastSyncedAt: '2026-07-01T00:00:00.000Z',
      });
    });
  });

  it('8. an authenticated user can read the provider catalog', async () => {
    const user = testEnv.authenticatedContext('userA').firestore();

    await assertSucceeds(getDoc(doc(user, 'provider-catalog/NL')));
  });

  it('9. an authenticated user writing the provider catalog is denied', async () => {
    const user = testEnv.authenticatedContext('userA').firestore();

    await assertFails(
      setDoc(doc(user, 'provider-catalog/NL'), {
        providers: [],
        lastSyncedAt: '2026-07-01T00:00:00.000Z',
      }),
    );
  });
});

describe('default deny', () => {
  it('10. a write to an undeclared top-level path is denied', async () => {
    const user = testEnv.authenticatedContext('userA').firestore();

    await assertFails(
      setDoc(doc(user, 'some-undeclared-collection/doc1'), { foo: 'bar' }),
    );
  });
});
