// @vultus/shared/firestore-schema — SDK-agnostic Firestore collection/document
// paths and pure Timestamp↔ISO converters (PLAN §3, §4, §6 item 6). Imports only
// @vultus/shared/domain; NO firebase/SDK import (the boundary is structural —
// `Date` on write, `{ toDate() }` on read). Query helpers are deferred to slices.

export * from './lib/data-types';
export * from './lib/paths';
export * from './lib/converters';
