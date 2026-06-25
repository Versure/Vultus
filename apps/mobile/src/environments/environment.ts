/**
 * Dev environment (spec 0010, decision 4).
 *
 * Emulator-first: `useEmulators: true` points AngularFire at the local Auth
 * (9099) / Firestore (8080) emulators (see firebase.json). The Firebase web
 * config below is NOT a secret — it ships in every client — and here it is a
 * set of clearly-fake `demo-` placeholders. `projectId` MUST stay
 * `'vultus-cab62'` so the emulator connectors target the same project the
 * emulators serve (firebase.json); a mismatch would silently break the
 * "boots + signs in against the emulator" outcome. The emulators do not
 * validate `apiKey`.
 */
export const environment = {
  production: false,
  useEmulators: true,
  // null in dev/prod — overridden to a fixture uid in environment.mock.ts so
  // the mock serve works without a running auth emulator.
  mockAuthUid: null as string | null,
  firebase: {
    apiKey: 'demo-vultus-not-a-real-key',
    authDomain: 'demo-vultus.firebaseapp.com',
    projectId: 'vultus-cab62',
    storageBucket: 'demo-vultus.appspot.com',
    messagingSenderId: 'demo-sender-id',
    appId: 'demo-app-id',
  },
  // TMDB search config (spec 0013). The api_key is intentionally EMPTY here —
  // populate it manually from `.env.local` (gitignored) before running the dev
  // server if you want live TMDB search locally. The base URLs are public.
  tmdb: {
    apiBaseUrl: 'https://api.themoviedb.org/3',
    imageBaseUrl: 'https://image.tmdb.org/t/p/w185',
    auth: { kind: 'apiKey' as const, apiKey: '' },
  },
};
