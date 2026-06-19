import { describe, expect, it, vi } from 'vitest';
import * as functions from 'firebase-functions';
import { classifyAuth, constantTimeEqual } from './auth';

const SECRET = 'super-secret-cron-value';

describe('constantTimeEqual', () => {
  it('returns true for an exact match', () => {
    expect(constantTimeEqual(SECRET, SECRET)).toBe(true);
  });

  it('returns false for a same-length mismatch', () => {
    const other = 'x'.repeat(SECRET.length);
    expect(other.length).toBe(SECRET.length);
    expect(constantTimeEqual(other, SECRET)).toBe(false);
  });

  it('returns false for unequal lengths without throwing (constant-time path)', () => {
    expect(constantTimeEqual('short', SECRET)).toBe(false);
    expect(constantTimeEqual(`${SECRET}-longer`, SECRET)).toBe(false);
  });
});

describe('classifyAuth', () => {
  it('valid secret header → cron, without calling verifyToken', async () => {
    const verifyToken = vi.fn();
    const result = await classifyAuth(
      { 'x-vultus-sync-secret': SECRET },
      SECRET,
      verifyToken,
    );
    expect(result).toEqual({ kind: 'cron' });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('wrong secret header → forbidden (constant-time compare exercised)', async () => {
    const verifyToken = vi.fn();
    const result = await classifyAuth(
      { 'x-vultus-sync-secret': 'wrong' },
      SECRET,
      verifyToken,
    );
    expect(result).toEqual({ kind: 'forbidden' });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('wrong secret of equal length → forbidden', async () => {
    const equalLenWrong = 'z'.repeat(SECRET.length);
    const result = await classifyAuth(
      { 'x-vultus-sync-secret': equalLenWrong },
      SECRET,
      vi.fn(),
    );
    expect(result).toEqual({ kind: 'forbidden' });
  });

  it('valid bearer token → user', async () => {
    const verifyToken = vi.fn(() => Promise.resolve({ uid: 'u1' }));
    const result = await classifyAuth(
      { authorization: 'Bearer good-token' },
      SECRET,
      verifyToken,
    );
    expect(result).toEqual({ kind: 'user' });
    expect(verifyToken).toHaveBeenCalledWith('good-token');
  });

  it('is case-insensitive on the Bearer scheme', async () => {
    const verifyToken = vi.fn(() => Promise.resolve({ uid: 'u1' }));
    const result = await classifyAuth(
      { authorization: 'bearer good-token' },
      SECRET,
      verifyToken,
    );
    expect(result).toEqual({ kind: 'user' });
  });

  it('invalid bearer token (verify rejects) → forbidden', async () => {
    const verifyToken = vi.fn(() => Promise.reject(new Error('bad token')));
    const result = await classifyAuth(
      { authorization: 'Bearer bad-token' },
      SECRET,
      verifyToken,
    );
    expect(result).toEqual({ kind: 'forbidden' });
  });

  it('malformed Authorization header (no Bearer) → forbidden', async () => {
    const verifyToken = vi.fn();
    const result = await classifyAuth(
      { authorization: 'Basic abc' },
      SECRET,
      verifyToken,
    );
    expect(result).toEqual({ kind: 'forbidden' });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('neither header → unauthenticated', async () => {
    const result = await classifyAuth({}, SECRET, vi.fn());
    expect(result).toEqual({ kind: 'unauthenticated' });
  });

  it('supports a getter-style header bag', async () => {
    const headers = (name: string) =>
      name === 'x-vultus-sync-secret' ? SECRET : undefined;
    const result = await classifyAuth(headers, SECRET, vi.fn());
    expect(result).toEqual({ kind: 'cron' });
  });

  it('never logs the secret or token', async () => {
    const infoSpy = vi
      .spyOn(functions.logger, 'info')
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(functions.logger, 'error')
      .mockImplementation(() => undefined);
    const warnSpy = vi
      .spyOn(functions.logger, 'warn')
      .mockImplementation(() => undefined);

    await classifyAuth({ 'x-vultus-sync-secret': SECRET }, SECRET, vi.fn());
    await classifyAuth(
      { authorization: 'Bearer secret-token-value' },
      SECRET,
      vi.fn(() => Promise.resolve({})),
    );

    const allArgs = [
      ...infoSpy.mock.calls,
      ...errorSpy.mock.calls,
      ...warnSpy.mock.calls,
    ]
      .flat()
      .map((a) => JSON.stringify(a))
      .join(' ');
    expect(allArgs).not.toContain(SECRET);
    expect(allArgs).not.toContain('secret-token-value');

    infoSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
