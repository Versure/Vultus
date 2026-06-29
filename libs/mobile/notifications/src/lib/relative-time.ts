import { formatDate } from '@angular/common';

/**
 * Slice-local relative-time formatter for notification `sentAt` ISO strings
 * (spec 0042 §5). Pure — pass `now` to make it deterministic in tests.
 *
 * Tiers (matching the Stitch screen's vocabulary "2h ago" / "Yesterday" /
 * "2 days ago" / "1 week ago"):
 *   - < 60s            → "Just now"
 *   - < 60m            → "Nm ago"
 *   - < 24h            → "Nh ago"
 *   - < 48h            → "Yesterday"
 *   - < 7d             → "N days ago"
 *   - < 14d            → "1 week ago"
 *   - < ~4 weeks (28d) → "N weeks ago"
 *   - older            → a short absolute date (e.g. "5 Mar 2026")
 *
 * The relative tiers are hand-rolled (no library expresses this exact ladder);
 * the absolute fallback reuses `@angular/common`'s `formatDate` (already a
 * workspace dependency — no new package is added). An unparseable ISO string
 * falls back to the raw input so the row never renders "Invalid Date".
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const thenMs = then.getTime();
  if (Number.isNaN(thenMs)) {
    return iso;
  }

  const diffMs = now.getTime() - thenMs;
  // Guard clock skew / future timestamps → treat as "Just now".
  if (diffMs < 0) {
    return 'Just now';
  }

  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;

  if (diffMs < MIN) {
    return 'Just now';
  }
  if (diffMs < HOUR) {
    const minutes = Math.floor(diffMs / MIN);
    return `${minutes}m ago`;
  }
  if (diffMs < DAY) {
    const hours = Math.floor(diffMs / HOUR);
    return `${hours}h ago`;
  }
  if (diffMs < 2 * DAY) {
    return 'Yesterday';
  }
  if (diffMs < WEEK) {
    const days = Math.floor(diffMs / DAY);
    return `${days} days ago`;
  }
  if (diffMs < 4 * WEEK) {
    const weeks = Math.floor(diffMs / WEEK);
    return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  }

  // Older than ~4 weeks → short absolute date, e.g. "5 Mar 2026".
  return formatDate(then, 'd MMM y', 'en-US');
}
