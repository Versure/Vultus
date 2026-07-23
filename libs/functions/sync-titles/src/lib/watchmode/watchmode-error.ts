// Slice-internal error carrying the failing HTTP status, mirroring TmdbError.
// Exported from the barrel so the sync engine can `instanceof`-check it. The
// `endpoint` is a credential-free path for diagnostics and MUST NEVER embed the
// Watchmode apiKey (the http core's `authQuery` strips it — see shared/http.ts).

export class WatchmodeError extends Error {
  /** HTTP status that caused the failure, or 0 for a network/transport error. */
  readonly status: number;
  /** The endpoint path that failed (e.g. '/title/42/sources/'). Never includes
   *  the apiKey — it is appended by the http core AFTER the error path is set. */
  readonly endpoint: string;

  constructor(message: string, status: number, endpoint: string) {
    super(message);
    this.name = 'WatchmodeError';
    this.status = status;
    this.endpoint = endpoint;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, WatchmodeError.prototype);
  }
}
