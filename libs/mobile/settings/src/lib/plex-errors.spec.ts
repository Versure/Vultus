import { describe, expect, it } from 'vitest';
import {
  PlexHttpError,
  PlexPinGoneError,
  describePlexError,
} from './plex-errors';

describe('describePlexError', () => {
  it('formats a PlexHttpError as its status + endpoint path (no body/token)', () => {
    const msg = describePlexError(new PlexHttpError(401, '/resources'));
    expect(msg).toBe('plex request to /resources failed with HTTP 401');
  });

  it('labels a PlexPinGoneError as an expired pin', () => {
    expect(describePlexError(new PlexPinGoneError())).toBe(
      'plex.tv pin expired',
    );
  });

  it('formats a generic Error as name: message (e.g. a cleartext block)', () => {
    const err = new Error(
      'CLEARTEXT communication to 192.168.1.20 not permitted by network security policy',
    );
    err.name = 'TypeError';
    expect(describePlexError(err)).toBe(
      'TypeError: CLEARTEXT communication to 192.168.1.20 not permitted by network security policy',
    );
  });

  it('handles a non-Error throwable without throwing', () => {
    expect(describePlexError('boom')).toBe('unknown error');
    expect(describePlexError(undefined)).toBe('unknown error');
  });

  it('never echoes the whole error object (no headers/token can leak)', () => {
    // An error object that carries a token in a non-standard field must NOT be
    // reflected — only `name`/`message` are read.
    const err = Object.assign(new Error('request failed'), {
      config: { headers: { 'X-Plex-Token': 'super-secret-token' } },
    });
    const msg = describePlexError(err);
    expect(msg).not.toContain('super-secret-token');
    expect(msg).toBe('Error: request failed');
  });
});
