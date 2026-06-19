// Slice-internal error carrying the failing HTTP status. Exported from the
// barrel so the sync engine can `instanceof`-check it. The `endpoint` is a path
// for diagnostics and MUST NEVER embed the bearer token.

export class TmdbError extends Error {
  /** HTTP status that caused the failure, or 0 for a network/transport error. */
  readonly status: number;
  /** The endpoint path that failed (e.g. '/movie/603'). Never includes the token. */
  readonly endpoint: string;

  constructor(message: string, status: number, endpoint: string) {
    super(message);
    this.name = 'TmdbError';
    this.status = status;
    this.endpoint = endpoint;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, TmdbError.prototype);
  }
}
