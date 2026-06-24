// @vultus/shared/domain — cross-slice domain types (PLAN §3, §6 item 5).
// Pure types + `as const` literal arrays, plus cross-scope DI tokens. No
// Firebase import, no Date/Timestamp — all timestamps are ISO 8601 strings.

export * from './lib/enums';
export * from './lib/entities';
export * from './lib/documents';
