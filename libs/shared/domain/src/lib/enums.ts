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

// Human-readable region names as native endonyms (spec 0079). `Record<Region,
// string>` is deliberate — a future REGIONS entry is a compile error here until
// its display name is added. BE→België (Dutch) is a deliberate call for
// consistency with NL, the app's default region.
export const REGION_DISPLAY_NAMES: Record<Region, string> = {
  NL: 'Nederland',
  DE: 'Deutschland',
  GB: 'United Kingdom',
  US: 'United States',
  FR: 'France',
  BE: 'België',
  ES: 'España',
  IT: 'Italia',
  CA: 'Canada',
  AU: 'Australia',
};

export function regionDisplayName(region: Region): string {
  return REGION_DISPLAY_NAMES[region];
}

export const NOTIFICATION_KINDS = [
  'episode-aired',
  'movie-available',
  'show-came-to-platform',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

// Internal discriminants — not iterated → bare unions, no companion array.
export type TitleType = 'movie' | 'tv';
export type WatchProviderType = 'flatrate' | 'rent' | 'buy';
