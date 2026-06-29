/**
 * Production environment (spec 0010, decision 4).
 *
 * MANUAL PREREQ (PLAN §7): before a real prod build connects to Firebase, the
 * user must paste the real PUBLIC web config for the `vultus-cab62` Firebase
 * web app (Firebase console → Project settings → Your apps → SDK setup) into
 * the `firebase` block below, replacing the `REPLACE_WITH_REAL_*` placeholders.
 *
 * The Firebase web config is PUBLIC, not a secret — it ships in every client —
 * so committing these placeholders (and later the real values) is correct, not
 * a secrets violation. Do NOT fabricate an `apiKey`; the placeholders are
 * intentionally obvious. Prod runs against real Firebase, so `useEmulators` is
 * false. Anonymous sign-in must be enabled in the Firebase console (PLAN §7).
 */
export const environment = {
  production: true,
  useEmulators: false,
  mockAuthUid: null as string | null,
  firebase: {
    apiKey: 'REPLACE_WITH_REAL_WEB_API_KEY',
    authDomain: 'REPLACE_WITH_REAL_AUTH_DOMAIN',
    projectId: 'vultus-cab62',
    storageBucket: 'REPLACE_WITH_REAL_STORAGE_BUCKET',
    messagingSenderId: 'REPLACE_WITH_REAL_MESSAGING_SENDER_ID',
    appId: 'REPLACE_WITH_REAL_APP_ID',
  },
  // TMDB search config (spec 0013). The api_key placeholder is substituted at
  // build time by CI from the `TMDB_API_KEY` GitHub Actions secret (CI wiring
  // is a separate follow-up spec). The base URLs are public, not secrets.
  tmdb: {
    apiBaseUrl: 'https://api.themoviedb.org/3',
    imageBaseUrl: 'https://image.tmdb.org/t/p/w185',
    // Larger base for the title-detail hero (spec 0036) — the 530px hero
    // upscales w185 to blur, so the detail slice gets w780 instead. Search and
    // watchlist thumbnails stay on imageBaseUrl (w185).
    detailImageBaseUrl: 'https://image.tmdb.org/t/p/w780',
    auth: { kind: 'apiKey' as const, apiKey: 'REPLACE_WITH_REAL_TMDB_API_KEY' },
  },
};
