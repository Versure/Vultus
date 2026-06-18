import { describe, expect, it } from 'vitest';

import { REGIONS } from '../index';

describe('shared/domain', () => {
  it('pins NL as the primary/default region', () => {
    expect(REGIONS[0]).toBe('NL');
  });
});
