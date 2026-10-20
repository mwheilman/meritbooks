import { describe, expect, it } from 'vitest';
import { GUARDS } from '@meritbooks/industry-packs';
import { GUARD_COPY, guardCopy, guardFixHref, guardsSentence } from '@/lib/pm/guards';

describe('guard → plain sentence', () => {
  it('has exactly one entry per GUARDS name', () => {
    expect(Object.keys(GUARD_COPY).sort()).toEqual([...GUARDS].sort());
  });

  it.each([...GUARDS])('%s has one human sentence, a need and a fix', (g) => {
    const c = GUARD_COPY[g];
    expect(c.failing).toMatch(/^[A-Z].*\.$/);
    expect(c.failing.split(/(?<=\.)\s+(?=[A-Z])/)).toHaveLength(1);
    expect(c.failing).not.toMatch(/_/);
    expect(c.need.length).toBeGreaterThan(2);
    expect(c.fix.label).toMatch(/^[A-Z]/);
    expect(!!c.fix.tab !== !!c.fix.href).toBe(true);
  });

  it('job-tab fixes link to the job; page fixes link to the page', () => {
    expect(guardFixHref('has_budget', 'j1')).toBe('/jobs/j1?tab=budget');
    expect(guardFixHref('has_customer', 'j1')).toBe('/jobs/j1?tab=overview');
    expect(guardFixHref('deposit_requested', 'j1')).toBe('/jobs/j1?tab=billing');
    expect(guardFixHref('punch_complete', 'j1')).toBe('/punch-list');
  });

  it('writes stage-machine checks in plain words', () => {
    expect(guardsSentence([])).toBe('No checks.');
    expect(guardsSentence(['has_customer'])).toBe('Needs a customer.');
    expect(guardsSentence(['has_customer', 'has_contract_value', 'has_budget'])).toBe('Needs a customer, a contract value and a budget.');
  });

  it('still produces a sentence for a guard added later', () => {
    expect(guardCopy('permit_issued').failing).toBe('A check (permit issued) is not met yet.');
  });
});
