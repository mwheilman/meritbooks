import { describe, expect, it } from 'vitest';
import { GATE_COPY, RELEASE_GATES, gateCopy, isReleaseGate, releaseSentence } from '@/lib/pm/ops/release-gates';

describe('release-to-shop gates (pm.release_to_shop, 1105)', () => {
  it('has one entry per gate the function can return, each with a fix', () => {
    expect(Object.keys(GATE_COPY).sort()).toEqual([...RELEASE_GATES].sort());
    for (const g of RELEASE_GATES) {
      const c = GATE_COPY[g];
      expect(c.failing).toMatch(/\.$/);
      expect(c.fix.label.length).toBeGreaterThan(0);
      expect(Boolean(c.fix.panel) || Boolean(c.fix.href)).toBe(true);
    }
  });
  it('links the off-order fixes to the right place', () => {
    expect(GATE_COPY.selections_approved.fix.href?.('j1')).toBe('/selections?job=j1');
    expect(GATE_COPY.has_budget.fix.href?.('j1')).toBe('/jobs/j1?tab=budget');
    expect(GATE_COPY.drawings_approved.fix.panel).toBe('drawings');
  });
  it('turns the failing list into one sentence', () => {
    expect(releaseSentence([])).toBe('Released to the shop.');
    expect(releaseSentence(['drawings_approved'])).toBe('Not released: shop drawings are not approved yet.');
    expect(releaseSentence(['drawings_approved', 'bom_present', 'has_budget'])).toBe(
      'Not released: shop drawings are not approved yet; the order has no cut list or bill of materials; and the job has no original budget with lines.',
    );
  });
  it('still reads an unknown gate in plain words', () => {
    expect(isReleaseGate('paint_cured')).toBe(false);
    expect(gateCopy('paint_cured').failing).toBe('A release check (paint cured) is not met yet.');
    expect(releaseSentence(['paint_cured'])).toBe('Not released: a release check (paint cured) is not met yet.');
  });
});
