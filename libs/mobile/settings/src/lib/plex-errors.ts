// Typed Plex errors (spec 0073). Kept in a DEPENDENCY-FREE module (no
// @capacitor/*, no Firebase) so `plex-link.service` can discriminate failures
// via `instanceof` WITHOUT transitively importing `@capacitor/core` (which
// `plex.client` needs) into the service module and every spec that loads it.

/**
 * plex.tv / the PMS answered with a non-2xx status. Carries the HTTP status and
 * the endpoint PATH only — never the response body (untrusted data, spec 0068)
 * and never a token/header value.
 */
export class PlexHttpError extends Error {
  constructor(
    readonly status: number,
    endpoint: string,
  ) {
    super(`plex request to ${endpoint} failed with HTTP ${status}`);
    this.name = 'PlexHttpError';
  }
}

/**
 * The PIN no longer exists on plex.tv — a 404 from `GET /pins/{id}` (code 1020
 * "Code not found or expired"). A REAL expiry, distinct from transport errors:
 * the link service maps this to the 'expired' error reason immediately instead
 * of polling a dead pin until the local countdown runs out.
 */
export class PlexPinGoneError extends Error {
  constructor() {
    super('plex.tv pin not found or expired');
    this.name = 'PlexPinGoneError';
  }
}

/**
 * Redact an unknown Plex failure into a SHORT, SAFE diagnostic string for
 * `console`/logcat — the only way to see WHY a link/sync failed on-device
 * (issue #171: the failure was swallowed with no clue what went wrong).
 *
 * SAFE-BY-CONSTRUCTION (CLAUDE.md / spec 0073): returns STRINGS pulled from
 * known-safe fields only — never the error object itself and never any header.
 * Our HTTP calls carry the X-Plex-Token in a HEADER (never the URL), so
 * `PlexHttpError` (status + endpoint path) and a transport error's `name`/
 * `message` (URL + reason, e.g. a cleartext/timeout/DNS failure) cannot contain
 * the token. That is why we extract these two fields instead of logging `err`.
 */
export function describePlexError(err: unknown): string {
  if (err instanceof PlexHttpError) {
    return err.message; // "plex request to {endpoint} failed with HTTP {status}"
  }
  if (err instanceof PlexPinGoneError) {
    return 'plex.tv pin expired';
  }
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return 'unknown error';
}
