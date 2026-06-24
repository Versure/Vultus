// Subpath barrel for Angular DI tokens. Mobile-only — not part of the main
// @vultus/shared/domain barrel so Cloud Functions builds don't pull in
// @angular/core as a transitive dependency.
export * from './lib/tokens';
