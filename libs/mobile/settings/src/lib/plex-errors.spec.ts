import { describe, expect, it } from 'vitest';
import {
  PlexHttpError,
  PlexPinGoneError,
  describePlexError,
  describeTmdbError,
} from './plex-errors';
import { TmdbDetailError } from './tmdb-detail.client';

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

describe('describeTmdbError', () => {
  it('formats a TmdbDetailError as its HTTP status only (no url/token/body)', () => {
    const msg = describeTmdbError(
      new TmdbDetailError('TMDB detail failed: 404', 404),
    );
    expect(msg).toBe('TmdbDetailError: HTTP 404');
  });

  it('formats a generic Error as name: message (e.g. a fetch network failure)', () => {
    const err = new Error('Failed to fetch');
    err.name = 'TypeError';
    expect(describeTmdbError(err)).toBe('TypeError: Failed to fetch');
  });

  it('handles a non-Error throwable without throwing', () => {
    expect(describeTmdbError('boom')).toBe('unknown error');
    expect(describeTmdbError(undefined)).toBe('unknown error');
  });

  it('never echoes the whole error object (no api_key/token can leak)', () => {
    // A TmdbDetailError only carries a numeric status — the query-param api_key
    // the client builds never reaches the diagnostic.
    const err = Object.assign(
      new TmdbDetailError('TMDB detail failed: 401', 401),
      { url: 'https://api.themoviedb.org/3/movie/550?api_key=super-secret' },
    );
    const msg = describeTmdbError(err);
    expect(msg).not.toContain('super-secret');
    expect(msg).toBe('TmdbDetailError: HTTP 401');
  });
});
