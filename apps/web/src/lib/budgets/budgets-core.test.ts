/**
 * Wave 4B pure libraries: generators (AC-B13), bridges tie (AC-B15), department BvA windows,
 * lifecycle / SoD (AC-B9…B11), owner scope (AC-B17), grid editing (AC-B20), templates (AC-B14).
 */
import { describe, it, expect } from 'vitest';
import { generate, growSeries, latestEstimate, spreadByShape, spreadEven, specFrom, paramsOf } from './generators';
import { bridgeTies, classifyDriver, groupBridge, pyToBudgetBridge, type PyBudgetRow } from './bridges';
import { departmentBva, priorYearMonths, windowMonths, cellKey } from './bva';
import { BudgetError, budgetErrorFromDb, checkPlanAction, checkVersionAction, lockReason, nextVersionNumber } from './lifecycle';
import { canEditDepartment, canSeeDepartment, decideBudgetAccess, filterToScope } from './scope';
import { fillRight, moveCursor, parseCellToCents, parsePasteBlock, parsePercentToBps, pasteEdits } from './grid';
import { SYSTEM_TEMPLATES, suggestTemplateKey } from './templates/system';
import { matchScore, planTemplate, resolveTemplate } from './templates/resolve';
import type { AccountLite } from './types';

const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const isCents = (xs: number[]) => xs.length === 12 && xs.every((x) => Number.isInteger(x));

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('generators (AC-B13)', () => {
  it('fixed monthly and even spreads are integer cents that tie to the annual total', () => {
    expect(generate({ method: 'FIXED_MONTHLY', monthlyCents: 125_050 }).months).toEqual(Array(12).fill(125_050));
    const even = spreadEven(1_000_001);
    expect(isCents(even)).toBe(true);
    expect(total(even)).toBe(1_000_001);
    expect(even[0]).toBe(83_334);
    expect(even[11]).toBe(83_333);
  });

  it('seasonal spread follows last year’s shape and ties; a zero / negative PY falls back to even', () => {
    const py = [1, 1, 2, 4, 6, 8, 8, 6, 4, 2, 1, 1].map((x) => x * 10_000);
    const g = generate({ method: 'ANNUAL_SEASONAL', annualCents: 2_400_007 }, { pyMonths: py });
    expect(total(g.months)).toBe(2_400_007);
    expect(g.months[5]).toBeGreaterThan(g.months[0] * 7);
    expect(g.fellBackToEven).toBe(false);
    const z = generate({ method: 'ANNUAL_SEASONAL', annualCents: 120_000 }, { pyMonths: Array(12).fill(0) });
    expect(z.fellBackToEven).toBe(true);
    expect(z.months).toEqual(Array(12).fill(10_000));
    expect(spreadByShape(100, [5, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).fellBackToEven).toBe(true);
  });

  it('PY + x% keeps the month shape (signs too) and the total is round(PY × (1 + g))', () => {
    const r = rng(7);
    for (let k = 0; k < 200; k++) {
      const py = Array.from({ length: 12 }, () => Math.round((r() - 0.15) * 5_000_000));
      const g = Math.round((r() - 0.3) * 3000);
      const m = generate({ method: 'PY_GROWTH', growthBps: g }, { pyMonths: py }).months;
      expect(isCents(m)).toBe(true);
      expect(total(m)).toBe(Math.round(total(py) * (1 + g / 10000)));
      for (let i = 0; i < 12; i++) expect(Math.abs(m[i] - py[i] * (1 + g / 10000))).toBeLessThanOrEqual(1);
    }
  });

  it('% of revenue uses the revenue months; headcount respects the start month; units grow through the year', () => {
    const rev = Array(12).fill(1_000_000);
    expect(generate({ method: 'PCT_OF_REVENUE', pctBps: 350 }, { revenueMonths: rev }).months).toEqual(Array(12).fill(35_000));
    const hc = generate({ method: 'HEADCOUNT_RATE', headcount: 2, monthlyRateCents: 500_000, burdenBps: 2000, startMonth: 4 });
    expect(hc.months.slice(0, 3)).toEqual([0, 0, 0]);
    expect(hc.months[3]).toBe(1_200_000);
    expect(hc.annualCents).toBe(1_200_000 * 9);
    const u = generate({ method: 'UNITS_RATE', unitsPerMonth: 10, rateCents: 12_345, growthBps: 1000 });
    expect(isCents(u.months)).toBe(true);
    expect(u.months[0]).toBe(123_450);
    expect(u.months[11]).toBe(135_795);
    expect(() => generate({ method: 'HEADCOUNT_RATE', headcount: 1, monthlyRateCents: 1, burdenBps: 0, startMonth: 13 })).toThrow();
  });

  it('prior budget + x%, latest estimate, spec round-trip', () => {
    expect(total(generate({ method: 'PRIOR_BUDGET_GROWTH', growthBps: 500 }, { priorBudgetMonths: Array(12).fill(100_000) }).months)).toBe(1_260_000);
    expect(latestEstimate([1, 1, 1, 1], [9, 9, 9, 9], 2).slice(0, 4)).toEqual([9, 9, 1, 1]);
    const spec = specFrom('HEADCOUNT_RATE', { headcount: 3, monthlyRateCents: 410_000, burdenBps: 1800, startMonth: 2 });
    expect(specFrom(spec.method, paramsOf(spec))).toEqual(spec);
    expect(growSeries(Array(12).fill(0), 500)).toEqual(Array(12).fill(0));
  });
});

describe('bridges tie (AC-B15)', () => {
  const methods = [null, 'PY_GROWTH', 'PCT_OF_REVENUE', 'HEADCOUNT_RATE', 'UNITS_RATE', 'FIXED_MONTHLY'] as const;
  it('PY → budget: start + Σ steps = end on random departments, steps by driver', () => {
    const r = rng(42);
    for (let k = 0; k < 300; k++) {
      const n = 1 + Math.floor(r() * 12);
      const rows: PyBudgetRow[] = Array.from({ length: n }, (_, i) => ({
        accountId: `a${i}`,
        label: `Account ${i}`,
        nature: r() < 0.3 ? 'income' : 'expense',
        pyCents: r() < 0.15 ? 0 : Math.round(r() * 9_000_000),
        budgetCents: r() < 0.1 ? 0 : Math.round(r() * 9_000_000),
        method: methods[Math.floor(r() * methods.length)],
        bridgeDriver: 'AUTO',
        isPayroll: r() < 0.2,
      }));
      const b = pyToBudgetBridge(rows);
      expect(bridgeTies(b)).toBe(true);
      expect(b.steps.every((s) => !s.residual)).toBe(true);
    }
  });

  it('classifies new, dropped, payroll, revenue growth and volume-driven cost', () => {
    const base: PyBudgetRow = { accountId: 'x', label: 'x', nature: 'expense', pyCents: 100, budgetCents: 120, method: null, bridgeDriver: 'AUTO', isPayroll: false };
    expect(classifyDriver({ ...base, pyCents: 0 })).toBe('NEW_INITIATIVE');
    expect(classifyDriver({ ...base, budgetCents: 0 })).toBe('ONE_TIME');
    expect(classifyDriver({ ...base, isPayroll: true })).toBe('HEADCOUNT');
    expect(classifyDriver({ ...base, nature: 'income', method: 'PY_GROWTH' })).toBe('RATE');
    expect(classifyDriver({ ...base, method: 'PCT_OF_REVENUE' })).toBe('VOLUME');
    expect(classifyDriver({ ...base })).toBe('INFLATION');
    expect(classifyDriver({ ...base, bridgeDriver: 'ONE_TIME' })).toBe('ONE_TIME');
  });

  it('a cost-only department bridges spend (lower is better); a revenue department bridges contribution', () => {
    const spend = pyToBudgetBridge([{ accountId: 'a', label: 'Rent', nature: 'expense', pyCents: 1000, budgetCents: 1100, method: null, bridgeDriver: 'AUTO', isPayroll: false }]);
    expect(spend.measure).toBe('spend');
    expect(spend.direction).toBe('lower_is_better');
    expect([spend.start.cents, spend.end.cents]).toEqual([1000, 1100]);
    const contrib = pyToBudgetBridge([
      { accountId: 'r', label: 'Rev', nature: 'income', pyCents: 5000, budgetCents: 6000, method: 'PY_GROWTH', bridgeDriver: 'AUTO', isPayroll: false },
      { accountId: 'c', label: 'Cost', nature: 'expense', pyCents: 2000, budgetCents: 2500, method: 'PCT_OF_REVENUE', bridgeDriver: 'AUTO', isPayroll: false },
    ]);
    expect([contrib.start.cents, contrib.end.cents]).toEqual([3000, 3500]);
    expect(contrib.steps.map((s) => [s.key, s.cents])).toEqual([['volume', -500], ['rate', 1000]]);
  });

  it('budget → actual by group ties, folds the tail into one measured step', () => {
    const r = rng(9);
    for (let k = 0; k < 200; k++) {
      const rows = Array.from({ length: 30 }, (_, i) => ({
        accountId: `a${i}`, label: `A${i}`, groupName: `G${i % 11}`, accountType: i % 5 === 0 ? 'REVENUE' : 'OPEX',
        nature: (i % 5 === 0 ? 'income' : 'expense') as 'income' | 'expense',
        baseCents: Math.round(r() * 1_000_000), compareCents: Math.round(r() * 1_000_000),
      }));
      const b = groupBridge('Budget → actual', { start: 'Budget', end: 'Actual' }, rows, { maxSteps: 7 });
      expect(bridgeTies(b)).toBe(true);
      expect(b.steps.length).toBeLessThanOrEqual(7);
    }
  });
});

describe('department BvA', () => {
  it('windows: month, QTD, YTD, TTM and the prior year', () => {
    expect(windowMonths(2027, 5, 'MONTH')).toEqual(['2027-05']);
    expect(windowMonths(2027, 5, 'QTD')).toEqual(['2027-04', '2027-05']);
    expect(windowMonths(2027, 3, 'YTD')).toEqual(['2027-01', '2027-02', '2027-03']);
    const ttm = windowMonths(2027, 2, 'TTM');
    expect(ttm[0]).toBe('2026-03');
    expect(ttm).toHaveLength(12);
    expect(priorYearMonths(['2027-01'])).toEqual(['2026-01']);
  });

  it('computes actual / budget / PY per account with F/U by nature and materiality', () => {
    const accts = new Map<string, AccountLite>([
      ['r', { id: 'r', number: '4000', name: 'Revenue', type: 'REVENUE', subType: 'REVENUE', groupName: 'Service Revenue' }],
      ['e', { id: 'e', number: '6100', name: 'Ads', type: 'OPEX', subType: 'OPERATING_EXPENSE', groupName: 'Marketing' }],
      ['bs', { id: 'bs', number: '1000', name: 'Cash', type: 'ASSET', subType: 'CURRENT_ASSET', groupName: null }],
    ]);
    const actual = new Map([[cellKey('r', '2027-03'), 900_000], [cellKey('e', '2027-03'), 260_000], [cellKey('r', '2026-03'), 800_000], [cellKey('bs', '2027-03'), 5]]);
    const budget = new Map([[cellKey('r', '2027-03'), 1_000_000], [cellKey('e', '2027-03'), 200_000]]);
    const o = departmentBva({ accounts: accts, actual, budget, months: ['2027-03'], pyMonths: ['2026-03'], materialityCents: 50_000, materialityBps: 0 });
    expect(o.lines.map((l) => [l.accountId, l.varianceCents, l.verdict, l.material])).toEqual([
      ['r', -100_000, 'unfavourable', true],
      ['e', 60_000, 'unfavourable', true],
    ]);
    expect(o.totals).toEqual({ actualCents: 640_000, budgetCents: 800_000, pyCents: 800_000, measure: 'contribution' });
    expect(o.lines[0].pyChangePct).toBeCloseTo(0.125);
  });
});

describe('lifecycle (AC-B9 / B10 / B11)', () => {
  const base = { kind: 'BUDGET' as const, actor: 'u_cfo', submittedBy: 'u_ctl', openPlans: 0, currentIsLockedOther: false, isCurrent: false };
  it('allows the legal moves and refuses the rest with a reason', () => {
    expect(checkVersionAction({ ...base, action: 'submit', status: 'DRAFT' })).toBe('IN_REVIEW');
    expect(checkVersionAction({ ...base, action: 'approve', status: 'IN_REVIEW' })).toBe('APPROVED');
    expect(checkVersionAction({ ...base, action: 'delete', status: 'DRAFT' })).toBeNull();
    expect(() => checkVersionAction({ ...base, action: 'approve', status: 'DRAFT' })).toThrow(/a draft/);
    expect(() => checkVersionAction({ ...base, action: 'delete', status: 'APPROVED' })).toThrow(BudgetError);
    expect(() => checkVersionAction({ ...base, action: 'return', status: 'IN_REVIEW', note: '' })).toThrow(/at least 3/);
    expect(() => checkVersionAction({ ...base, action: 'lock', status: 'APPROVED' })).toThrow(/Only the current/);
  });
  it('SoD, open departments and a locked year block approval', () => {
    expect(() => checkVersionAction({ ...base, action: 'approve', status: 'IN_REVIEW', actor: 'u_ctl' })).toThrow(/submitted a budget can’t approve/);
    expect(() => checkVersionAction({ ...base, action: 'approve', status: 'IN_REVIEW', openPlans: 2 })).toThrow(/2 department budgets are not approved/);
    expect(() => checkVersionAction({ ...base, action: 'approve', status: 'IN_REVIEW', currentIsLockedOther: true })).toThrow(/reforecast/);
    try {
      checkVersionAction({ ...base, action: 'approve', status: 'IN_REVIEW', actor: 'u_ctl' });
    } catch (e) {
      expect((e as BudgetError).status).toBe(409);
    }
  });
  it('department plans: submit, return with a note, approve not by the submitter, gap note', () => {
    const p = { versionStatus: 'DRAFT' as const, actor: 'u_ctl', submittedBy: 'u_head' };
    expect(checkPlanAction({ ...p, action: 'submit', status: 'DRAFT' })).toBe('SUBMITTED');
    expect(() => checkPlanAction({ ...p, action: 'return', status: 'SUBMITTED' })).toThrow(/at least 3/);
    expect(checkPlanAction({ ...p, action: 'return', status: 'SUBMITTED', note: 'Trim travel' })).toBe('RETURNED');
    expect(() => checkPlanAction({ ...p, action: 'approve', status: 'SUBMITTED', actor: 'u_head' })).toThrow(/someone else/);
    expect(() => checkPlanAction({ ...p, action: 'approve', status: 'SUBMITTED', expenseGapCents: 5000 })).toThrow(/gap/);
    expect(checkPlanAction({ ...p, action: 'approve', status: 'SUBMITTED', expenseGapCents: 5000, gapNote: 'New hire approved' })).toBe('APPROVED');
    expect(() => checkPlanAction({ ...p, action: 'submit', status: 'DRAFT', versionStatus: 'APPROVED' })).toThrow(/can’t change/);
    expect(lockReason('APPROVED', null, true)).toMatch(/Create a new version/);
    expect(lockReason('DRAFT', 'SUBMITTED', true)).toMatch(/returned/);
    expect(lockReason('DRAFT', 'DRAFT', true)).toBeNull();
  });
  it('maps database refusals and numbers versions', () => {
    expect(budgetErrorFromDb('BUDGET_LOCKED: this budget version is approved — create a new version to change it')?.code).toBe('LOCKED');
    expect(budgetErrorFromDb('BUDGET_SOD: the person who submitted a budget can\'t approve it')?.code).toBe('SOD');
    expect(budgetErrorFromDb('something else')).toBeNull();
    expect(nextVersionNumber([{ kind: 'BUDGET', versionNumber: 2 }, { kind: 'REFORECAST', versionNumber: 5 }], 'BUDGET')).toBe(3);
  });
});

describe('department-owner scope (AC-B17)', () => {
  it('finance staff see everything; a department head sees only their departments', () => {
    const fin = decideBudgetAccess({ userId: 'u1', viewAllowed: true, editAllowed: true, approveAllowed: false, financeStaff: true, ownedDepartmentIds: [] });
    expect(fin.scope).toBe('ALL');
    expect(canSeeDepartment(fin, null)).toBe(true);
    const head = decideBudgetAccess({ userId: 'u2', viewAllowed: true, editAllowed: true, approveAllowed: false, financeStaff: false, ownedDepartmentIds: ['d1'] });
    expect(head.scope).toBe('DEPARTMENTS');
    expect(canSeeDepartment(head, 'd1')).toBe(true);
    expect(canSeeDepartment(head, 'd2')).toBe(false);
    expect(canSeeDepartment(head, null)).toBe(false);
    expect(canEditDepartment(head, 'd1')).toBe(true);
    expect(head.canApprove).toBe(false);
    expect(filterToScope(head, [{ departmentId: 'd1' }, { departmentId: 'd2' }, { departmentId: null }])).toEqual([{ departmentId: 'd1' }]);
    const nobody = decideBudgetAccess({ userId: 'u3', viewAllowed: true, editAllowed: false, approveAllowed: false, financeStaff: false, ownedDepartmentIds: [] });
    expect(nobody.canView).toBe(false);
    const viewer = decideBudgetAccess({ userId: 'u4', viewAllowed: true, editAllowed: false, approveAllowed: false, financeStaff: true, ownedDepartmentIds: [] });
    expect(canEditDepartment(viewer, null)).toBe(false);
  });
});

describe('grid editing (AC-B20)', () => {
  it('parses what people paste from Excel', () => {
    expect(parseCellToCents('$1,234.50')).toBe(123_450);
    expect(parseCellToCents('(1,234)')).toBe(-123_400);
    expect(parseCellToCents('-')).toBe(0);
    expect(parseCellToCents('2.5k')).toBe(250_000);
    expect(parseCellToCents('abc')).toBeNull();
    const block = parsePasteBlock('100\t200\t300\r\n400\t(50)\tx\n');
    expect(block.cells).toEqual([[10_000, 20_000, 30_000], [40_000, -5_000, null]]);
    expect(block.invalid).toBe(1);
    expect(parsePasteBlock('1,234').cells).toEqual([[123_400]]);
    const edits = pasteEdits(block, { row: 1, col: 10 }, 2);
    expect(edits).toEqual([{ row: 1, col: 10, cents: 10_000 }, { row: 1, col: 11, cents: 20_000 }]);
  });
  it('fill-right, percent parsing and keyboard moves', () => {
    expect(fillRight([1, 2, 3, 4], 1)).toEqual([1, 2, 2, 2]);
    expect(parsePercentToBps('5%')).toBe(500);
    expect(parsePercentToBps('-2.5')).toBe(-250);
    expect(parsePercentToBps('x')).toBeNull();
    expect(moveCursor({ row: 0, col: 11 }, 'Tab', 3)).toEqual({ row: 1, col: 0 });
    expect(moveCursor({ row: 0, col: 0 }, 'ArrowUp', 3)).toEqual({ row: 0, col: 0 });
    expect(moveCursor({ row: 1, col: 3 }, 'Enter', 3, 12, true)).toEqual({ row: 0, col: 3 });
  });
});

describe('templates (AC-B14)', () => {
  const coa: AccountLite[] = [
    { id: 'rev1', number: '4000', name: 'Service Revenue', type: 'REVENUE', subType: 'REVENUE', groupName: 'Service Revenue' },
    { id: 'rev2', number: '4100', name: 'Install Revenue', type: 'REVENUE', subType: 'REVENUE', groupName: 'Service Revenue' },
    { id: 'rev9', number: '4900', name: 'Interdepartment Revenue', type: 'REVENUE', subType: 'REVENUE', groupName: 'Interdepartmental Eliminations (REVENUE)' },
    { id: 'wag', number: '6000', name: 'Salaries & Wages', type: 'OPEX', subType: 'OPERATING_EXPENSE', groupName: 'Payroll & Benefits' },
    { id: 'com', number: '6010', name: 'Sales Commissions', type: 'OPEX', subType: 'OPERATING_EXPENSE', groupName: 'Payroll & Benefits' },
    { id: 'adv', number: '6200', name: 'Advertising', type: 'OPEX', subType: 'OPERATING_EXPENSE', groupName: 'Marketing & Sales' },
  ];

  it('every system template line selects by type / group / name — never an account number', () => {
    for (const t of SYSTEM_TEMPLATES) {
      expect(t.lines.length).toBeGreaterThan(0);
      for (const l of t.lines) {
        const src = JSON.stringify(l.selector);
        expect(src, `${t.key}.${l.key}`).not.toMatch(/\b\d{4}\b/);
        expect(l.selector.types.length).toBeGreaterThan(0);
        for (const r of [l.selector.name, l.selector.group, l.selector.notName]) if (r) expect(() => new RegExp(r, 'i')).not.toThrow();
      }
    }
    expect(new Set(SYSTEM_TEMPLATES.map((t) => t.key)).size).toBe(SYSTEM_TEMPLATES.length);
    expect(SYSTEM_TEMPLATES.map((t) => t.departmentKind)).toEqual(
      expect.arrayContaining(['SALES', 'OPERATIONS', 'ADMIN', 'MARKETING', 'SERVICE', 'PARTS', 'SHOP', 'CONSTRUCTION_PM']),
    );
  });

  it('resolves against the chart, reports what is missing, never reuses an account', () => {
    const sales = SYSTEM_TEMPLATES.find((t) => t.key === 'sales')!;
    const py = new Map([['rev1', 100], ['rev2', 50]]);
    const res = resolveTemplate(sales, coa, py);
    const byKey = new Map(res.resolved.map((r) => [r.line.key, r.accounts.map((a) => a.id)]));
    expect(byKey.get('revenue')).toEqual(['rev1', 'rev2']); // eliminations excluded, both PY accounts
    expect(byKey.get('commissions')).toEqual(['com']);
    expect(byKey.get('salaries')).toEqual(['wag']);
    expect(res.missing.map((l) => l.key)).toEqual(expect.arrayContaining(['travel', 'samples']));
    const all = res.resolved.flatMap((r) => r.accounts.map((a) => a.id));
    expect(new Set(all).size).toBe(all.length);
    expect(matchScore(sales.lines[0], coa[2])).toBe(0);
  });

  it('drafts months: revenue first, commission as % of that revenue, growth override applies', () => {
    const sales = SYSTEM_TEMPLATES.find((t) => t.key === 'sales')!;
    const pyMonthsByAccount = new Map<string, number[]>([['rev1', Array(12).fill(1_000_000)], ['wag', Array(12).fill(400_000)]]);
    const plan = planTemplate(sales, coa, { pyMonthsByAccount, growthOverrideBps: 1000 });
    const rev = plan.lines.find((l) => l.account?.id === 'rev1')!;
    expect(rev.annualCents).toBe(13_200_000);
    const com = plan.lines.find((l) => l.account?.id === 'com')!;
    expect(com.annualCents).toBe(Math.round(13_200_000 * 0.05));
    for (const l of plan.lines) expect(total(l.months)).toBe(l.annualCents);
  });

  it('suggests a template from the department name', () => {
    expect(suggestTemplateKey('Marketing')).toBe('marketing');
    expect(suggestTemplateKey('Service Department')).toBe('service');
    expect(suggestTemplateKey('Install')).toBe('operations');
    expect(suggestTemplateKey('Office / G&A')).toBe('admin');
  });
});
