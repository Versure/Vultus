// Slice-internal error carrying the failing HTTP status. Exported from the
// barrel so the sync engine can `instanceof`-check it. Kept DISTINCT from
// `TmdbError` (no shared base) per the spec. The `endpoint` is a path for
// diagnostics and MUST NEVER embed the Trakt client id (the credential lives
// only in the `trakt-api-key` header).

export class TraktError extends Error {
  /** HTTP status that caused the failure, or 0 for a network/transport error. */
  readonly status: number;
  /** The endpoint path that failed (e.g. '/search/tmdb/603?type=show').
   *  Never includes the client id. */
  readonly endpoint: string;

  constructor(message: string, status: number, endpoint: string) {
    super(message);
    this.name = 'TraktError';
    this.status = status;
    this.endpoint = endpoint;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, TraktError.prototype);
  }
}
