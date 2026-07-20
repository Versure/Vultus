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
