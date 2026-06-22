// Enum-like fields as string-literal unions (PLAN §4). Cases that are iterated
// at runtime are backed by an `as const` array; the union is derived from it.

// Iterated by UI/dispatch → const array + derived type.
export const WATCH_STATUSES = [
  'watching',
  'completed',
  'dropped',
  'planned',
] as const;
export type WatchStatus = (typeof WATCH_STATUSES)[number];

export const REGIONS = [
  'NL',
  'DE',
  'GB',
  'US',
  'FR',
  'BE',
  'ES',
  'IT',
  'CA',
  'AU',
] as const; // NL = v1 primary/default
export type Region = (typeof REGIONS)[number];

export const NOTIFICATION_KINDS = [
  'episode-aired',
  'movie-available',
  'show-came-to-platform',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

// Internal discriminants — not iterated → bare unions, no companion array.
export type TitleType = 'movie' | 'tv';
export type WatchProviderType = 'flatrate' | 'rent' | 'buy';
