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
  firebase: {
    apiKey: 'demo-vultus-not-a-real-key',
    authDomain: 'demo-vultus.firebaseapp.com',
    projectId: 'vultus-cab62',
    storageBucket: 'demo-vultus.appspot.com',
    messagingSenderId: 'demo-sender-id',
    appId: 'demo-app-id',
  },
};
