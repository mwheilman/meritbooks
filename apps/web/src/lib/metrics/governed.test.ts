import { describe, it, expect } from 'vitest';
import { CO_A, CO_B, chainSupabase, company, facts, factsLoader } from '@/test/governance-facts';
import { governDataset, withholdDataset } from './governed';
import type { CompanyDataset, MetricDataset } from './types';

function co(id: string): CompanyDataset {
  const months = { '2026-06': 100, '2026-07': 200, '2026-08': 300, '2026-09': 400 };
  return {
    id,
    name: id,
    ownershipPct: null,
    inGroupFrom: null,
    firstMonthOnFile: '2026-06',
    closedThrough: '2026-09',
    gl: { revenue: { opening: 0, months: { ...months } }, cash: { opening: 5_000, months: { ...months } } },
    budget: { revenue: { '2026-09': 999 } },
    budgetApprovedFy: [2026],
    operational: { ar_open: { '2026-07': 10, '2026-09': 30 } },
    customerRevenue: { '2026-08': { acme: 300 } },
  };
}
const ds = (...ids: string[]): MetricDataset => ({
  source: 'test',
  fyStartMonth: 1,
  rangeStart: '2026-06',
  latestMonth: '2026-09',
  companies: ids.map(co),
  classMapping: {},
  operationalAvailable: ['ar_open'],
});
const MONTHS = ['2026-06', '2026-07', '2026-08', '2026-09'];

describe('withholdDataset', () => {
  it('cuts each company at its last shown month and pulls latestMonth back', () => {
    const out = withholdDataset(ds(CO_A), MONTHS, (m) => m <= '2026-07');
    const c = out.companies[0];
    expect(out.latestMonth).toBe('2026-07');
    expect(c.gl.revenue?.months).toEqual({ '2026-06': 100, '2026-07': 200 });
    expect(c.gl.cash?.opening).toBe(5_000);
    expect(c.operational.ar_open).toEqual({ '2026-07': 10 });
    expect(c.customerRevenue).toEqual({});
    expect(c.budget.revenue).toEqual({ '2026-09': 999 }); // budgets are not ledger actuals
  });

  it('a company with nothing shown contributes nothing; latestMonth falls before the range', () => {
    const out = withholdDataset(ds(CO_A, CO_B), MONTHS, (m, id) => id === CO_A && m <= '2026-08');
    expect(out.latestMonth).toBe('2026-05');
    const b = out.companies.find((c) => c.id === CO_B)!;
    expect(b.gl.cash).toEqual({ opening: 0, months: {} });
  });
});

describe('governDataset', () => {
  const f = facts(company(CO_A, [6, 7, 8, 9], [6, 7]));
  const base = { supabase: chainSupabase(), orgId: 'org-1' };

  it('no user → non-finance (fail closed): released months only', async () => {
    const out = await governDataset({ ...base, userId: null, deps: { loadFacts: factsLoader(() => f) } }, { companyIds: [CO_A], from: '2026-06', to: '2026-09' }, ds(CO_A));
    expect(out.latestMonth).toBe('2026-07');
    expect(Object.keys(out.companies[0].gl.revenue?.months ?? {})).toEqual(['2026-06', '2026-07']);
  });

  it('finance passes through unchanged', async () => {
    const input = ds(CO_A);
    const out = await governDataset({ ...base, userId: 'u', deps: { probe: { has: async () => true }, loadFacts: factsLoader(() => f) } }, { companyIds: [CO_A], from: '2026-06', to: '2026-09' }, input);
    expect(out).toBe(input);
  });
});
