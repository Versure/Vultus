/**
 * Pure rate-limit check (spec 0009 "Rate limit"). Applies to the user path only;
 * the privileged cron path bypasses it in the handler.
 *
 * `lastRunAt === null` (no prior run) → not limited. Otherwise limited while the
 * last run is within `windowMs` (`now - lastRunAt < windowMs`); at or past the
 * window (`>=`) → not limited.
 */
export function isRateLimited(
  lastRunAt: number | null,
  now: number,
  windowMs: number,
): boolean {
  if (lastRunAt === null) {
    return false;
  }
  return now - lastRunAt < windowMs;
}
