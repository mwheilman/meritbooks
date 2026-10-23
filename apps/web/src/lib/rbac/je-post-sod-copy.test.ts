import { describe, it, expect } from 'vitest';
import { jeSelfPostCopy } from './je-post-sod-copy';

describe('jeSelfPostCopy — one accurate sentence per access mode (1G-6)', () => {
  it('v2 (and an unreadable mode, which fails closed) says enforced', () => {
    for (const m of ['v2', null] as const) {
      const c = jeSelfPostCopy(m, '$25,000.00');
      expect(c.status).toBe('Enforced');
      expect(c.detail).toContain('$25,000.00');
      expect(c.detail).not.toMatch(/not yet enforced/i);
    }
  });
  it('dual says it is checked and logged, not blocking', () => {
    const c = jeSelfPostCopy('dual', '$25,000.00');
    expect(c.status).toMatch(/not blocking/);
    expect(c.detail).toMatch(/still go through/);
    expect(c.detail).toMatch(/Roles page/);
  });
  it('legacy says it is off and how to turn it on', () => {
    expect(jeSelfPostCopy('legacy', '$1.00').detail).toMatch(/original access model/);
  });
});
