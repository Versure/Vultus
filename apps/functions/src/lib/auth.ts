/**
 * Pure, SDK-free auth classification for the `syncTitles` HTTP function.
 *
 * Two credentials are accepted (spec 0009 "Trigger + auth"):
 *  - `X-Vultus-Sync-Secret` — the privileged cron path (constant-time compared
 *    against the configured shared secret). Match → 'cron'; mismatch → forbidden.
 *  - `Authorization: Bearer <idToken>` — the rate-limited user path. The token is
 *    verified by an INJECTED `verifyToken` so this module never touches the Admin
 *    SDK. Resolves → 'user'; throws/rejects → forbidden.
 *  - Neither header → unauthenticated (the handler maps this to 401).
 *
 * NEVER logs the secret or token; the comparison is constant-time and does not
 * leak length via early return.
 */
import { timingSafeEqual } from 'node:crypto';

/** Case-insensitive-safe header lookup. Express lowercases header keys, so the
 *  input is a plain record keyed by lowercase header names. */
export type HeaderGetter = (name: string) => string | undefined;

/** A header bag (e.g. Express `req.headers`) or a getter function. */
export type Headers =
  | Record<string, string | string[] | undefined>
  | HeaderGetter;

/** Verifies a Firebase Auth ID token. Injected so this module stays SDK-free.
 *  Resolves on a valid token, rejects/throws on an invalid one. */
export type VerifyToken = (token: string) => Promise<unknown>;

/** The classified outcome. The handler maps each kind to an HTTP status:
 *  'cron'/'user' → proceed; 'forbidden' → 403; 'unauthenticated' → 401. */
export type AuthResult =
  | { kind: 'cron' }
  | { kind: 'user' }
  | { kind: 'forbidden' }
  | { kind: 'unauthenticated' };

const SECRET_HEADER = 'x-vultus-sync-secret';
const AUTH_HEADER = 'authorization';
const BEARER_PREFIX = 'bearer ';

function getHeader(headers: Headers, name: string): string | undefined {
  const lower = name.toLowerCase();
  if (typeof headers === 'function') {
    return headers(lower);
  }
  const raw = headers[lower] ?? headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Constant-time string compare. Unequal lengths return `false` WITHOUT leaking
 * timing: a same-length dummy comparison is performed against the expected
 * value before returning, so the work done is independent of `actual`'s length.
 */
export function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBuf = Buffer.from(actual, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (actualBuf.length !== expectedBuf.length) {
    // Compare expected against itself to spend equivalent time, then fail.
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return timingSafeEqual(actualBuf, expectedBuf);
}

/**
 * Classify the request's credentials. Pure aside from the injected
 * `verifyToken`. Never logs the secret or token.
 *
 * @param headers  Request headers (Express bag or a getter).
 * @param secret   The configured shared secret (`SYNC_SHARED_SECRET.value()`).
 * @param verifyToken  Injected ID-token verifier (Admin SDK in production).
 */
export async function classifyAuth(
  headers: Headers,
  secret: string,
  verifyToken: VerifyToken,
): Promise<AuthResult> {
  const presented = getHeader(headers, SECRET_HEADER);
  if (presented !== undefined) {
    return constantTimeEqual(presented, secret)
      ? { kind: 'cron' }
      : { kind: 'forbidden' };
  }

  const authorization = getHeader(headers, AUTH_HEADER);
  if (authorization !== undefined) {
    const lower = authorization.toLowerCase();
    if (lower.startsWith(BEARER_PREFIX)) {
      const token = authorization.slice(BEARER_PREFIX.length).trim();
      if (token.length > 0) {
        try {
          await verifyToken(token);
          return { kind: 'user' };
        } catch {
          return { kind: 'forbidden' };
        }
      }
    }
    // Present but malformed Authorization header → forbidden.
    return { kind: 'forbidden' };
  }

  return { kind: 'unauthenticated' };
}
