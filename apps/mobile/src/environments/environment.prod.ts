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
  firebase: {
    apiKey: 'REPLACE_WITH_REAL_WEB_API_KEY',
    authDomain: 'REPLACE_WITH_REAL_AUTH_DOMAIN',
    projectId: 'vultus-cab62',
    storageBucket: 'REPLACE_WITH_REAL_STORAGE_BUCKET',
    messagingSenderId: 'REPLACE_WITH_REAL_MESSAGING_SENDER_ID',
    appId: 'REPLACE_WITH_REAL_APP_ID',
  },
};
