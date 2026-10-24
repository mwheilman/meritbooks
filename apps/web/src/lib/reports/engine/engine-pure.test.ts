import { describe, it, expect } from 'vitest';
import { buckets, priorPeriod, priorYear, resolvePeriod, fiscalYearLabel, isMonthAligned } from './periods';
import { evalFormula, parseFormula, validateLayout, matchesSelector } from './layout';
import { formatAmount, formatPercent, scaleCents } from './format';
import { cashFlowCategory, fillDerived, tieViolations } from './build';
import type { AccountMeta, LayoutRowDef, ReportColumn, ReportRow } from './types';

describe('period engine (fiscal-year aware)', () => {
  it('resolves month / quarter / year / to-date / TTM for a July fiscal year', () => {
    expect(resolvePeriod({ preset: 'month', asOf: '2026-02-14' }, 7)).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(resolvePeriod({ preset: 'quarter', asOf: '2026-02-14' }, 7)).toEqual({ start: '2026-01-01', end: '2026-03-31' });
    expect(resolvePeriod({ preset: 'year', asOf: '2026-02-14' }, 7)).toEqual({ start: '2025-07-01', end: '2026-06-30' });
    expect(resolvePeriod({ preset: 'ytd', asOf: '2026-02-14' }, 7)).toEqual({ start: '2025-07-01', end: '2026-02-14' });
    expect(resolvePeriod({ preset: 'qtd', asOf: '2026-02-14' }, 7)).toEqual({ start: '2026-01-01', end: '2026-02-14' });
    expect(resolvePeriod({ preset: 'mtd', asOf: '2026-02-14' }, 1)).toEqual({ start: '2026-02-01', end: '2026-02-14' });
    expect(resolvePeriod({ preset: 'ttm', asOf: '2026-02-14' }, 1)).toEqual({ start: '2025-03-01', end: '2026-02-28' });
    expect(resolvePeriod({ preset: 'custom', asOf: '2026-02-14', start: '2026-03-10', end: '2026-01-05' }, 1)).toEqual({ start: '2026-01-05', end: '2026-03-10' });
    expect(fiscalYearLabel('2026-02-14', 7)).toBe('FY2026');
    expect(fiscalYearLabel('2026-02-14', 1)).toBe('2026');
  });

  it('prior period is equal length; prior year keeps month ends (leap-safe)', () => {
    expect(priorPeriod({ start: '2026-04-01', end: '2026-06-30' })).toEqual({ start: '2026-01-01', end: '2026-03-31' });
    expect(priorPeriod({ start: '2026-03-01', end: '2026-03-31' })).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(priorPeriod({ start: '2026-03-01', end: '2026-03-15' })).toEqual({ start: '2026-02-01', end: '2026-02-15' });
    expect(priorPeriod({ start: '2026-03-05', end: '2026-03-14' })).toEqual({ start: '2026-02-23', end: '2026-03-04' });
    expect(priorYear({ start: '2024-02-01', end: '2024-02-29' })).toEqual({ start: '2023-02-01', end: '2023-02-28' });
    expect(priorYear({ start: null, end: '2026-06-30' })).toEqual({ start: null, end: '2025-06-30' });
  });

  it('buckets: a range spanning months splits into them; one month → trailing N; last bucket clipped to the as-of', () => {
    expect(buckets('month', { start: '2026-01-01', end: '2026-03-31' }, 1).map((b) => b.label)).toEqual(['Jan 2026', 'Feb 2026', 'Mar 2026']);
    const t = buckets('month', { start: '2026-03-01', end: '2026-03-31' }, 1);
    expect(t).toHaveLength(12);
    expect(t[0].range.start).toBe('2025-04-01');
    const ytd = buckets('month', { start: '2026-01-01', end: '2026-03-15' }, 1);
    expect(ytd[2].range).toEqual({ start: '2026-03-01', end: '2026-03-15' });
    expect(isMonthAligned(ytd[2].range)).toBe(false);
    const q = buckets('quarter', { start: '2025-07-01', end: '2026-06-30' }, 7);
    expect(q.map((b) => b.label)).toEqual(['Q1 FY2026', 'Q2 FY2026', 'Q3 FY2026', 'Q4 FY2026']);
  });
});

describe('row designer: formulas and validation', () => {
  it('evaluates arithmetic with precedence, parentheses, unary minus; ÷0 is null', () => {
    const vals: Record<string, number> = { a: 300, b: 200, c: 0 };
    const ev = (e: string) => evalFormula(parseFormula(e), (id) => vals[id] ?? null);
    expect(ev('{a} - {b} * 2')).toBe(-100);
    expect(ev('({a} - {b}) / {a} * 100')).toBeCloseTo(33.333, 2);
    expect(ev('-{a} + 1')).toBe(-299);
    expect(ev('{a} / {c}')).toBeNull();
    expect(ev('{missing} + 1')).toBeNull();
    expect(() => parseFormula('{a} +')).toThrow();
    expect(() => parseFormula('{A}')).toThrow();
  });

  it('rejects duplicate ids, unknown refs and circular references', () => {
    const rows: LayoutRowDef[] = [
      { id: 'rev', kind: 'accounts', label: 'Revenue', select: { types: ['REVENUE'] }, sign: -1 },
      { id: 'x', kind: 'subtotal', label: 'X', of: [{ id: 'y', sign: 1 }] },
      { id: 'y', kind: 'formula', label: 'Y', expr: '{x} + {rev}', format: 'amount' },
      { id: 'z', kind: 'subtotal', label: 'Z', of: [{ id: 'nope', sign: 1 }] },
      { id: 'rev', kind: 'header', label: 'dup' },
    ];
    const msgs = validateLayout(rows, 'PNL').map((i) => i.message).join(' | ');
    expect(msgs).toMatch(/Circular reference/);
    expect(msgs).toMatch(/unknown row "nope"/);
    expect(msgs).toMatch(/Duplicate row id "rev"/);
    expect(validateLayout([{ id: 'rev', kind: 'accounts', label: 'Revenue', select: { types: ['REVENUE'] }, sign: -1 }], 'PNL')).toEqual([]);
  });

  it('selectors match by type / role / numeric account range (never a hidden number rule)', () => {
    const a = { id: 'x', number: '6150', name: 'Rent', type: 'OPEX', subType: 'OPERATING_EXPENSE', groupId: 'g', roles: ['RENT'] } as unknown as AccountMeta;
    expect(matchesSelector(a, { ranges: [{ from: '6000', to: '6999' }] })).toBe(true);
    expect(matchesSelector(a, { ranges: [{ from: '600', to: '699' }] })).toBe(false);
    expect(matchesSelector(a, { types: ['OPEX'], roles: ['RENT'] })).toBe(true);
    expect(matchesSelector(a, { types: ['OPEX'], excludeAccountIds: ['x'] })).toBe(false);
    expect(matchesSelector(a, {})).toBe(false);
  });
});

describe('presentation rounding is drift-free', () => {
  it('rounds each figure from exact cents; parentheses; rounds-to-zero prints 0; exact zero is a dash', () => {
    expect(formatAmount(123456789, 'cents')).toBe('1,234,567.89');
    expect(formatAmount(-123456789, 'units')).toBe('(1,234,568)');
    expect(formatAmount(123456789, 'thousands')).toBe('1,234.6');
    expect(formatAmount(123456789, 'millions')).toBe('1.23');
    expect(formatAmount(1_000, 'thousands')).toBe('0');
    expect(formatAmount(0, 'thousands')).toBe('–');
    expect(formatPercent(-12.34)).toBe('(12.3%)');
  });

  it('totals are computed before rounding: the rounded total is round(Σ exact), not Σ round', () => {
    const rows = [33_333, 33_333, 33_334]; // $333.33 + $333.33 + $333.34 = $1,000.00
    const total = rows.reduce((s, x) => s + x, 0);
    expect(scaleCents(total, 'units')).toBe(1000);
    expect(rows.map((x) => scaleCents(x, 'units')).reduce((s, x) => s + x, 0)).toBe(999); // the footnoted rounding difference
  });
});

describe('derived columns and tie checks', () => {
  const cols: ReportColumn[] = [
    { id: 'a', label: 'Actual', kind: 'amount', source: 'actual', range: { start: '2026-01-01', end: '2026-01-31' } },
    { id: 'b', label: 'Budget', kind: 'amount', source: 'budget', range: { start: '2026-01-01', end: '2026-01-31' } },
    { id: 'd', label: '$ Var', kind: 'variance_amount', source: 'actual', range: { start: '2026-01-01', end: '2026-01-31' }, of: 'a', against: 'b' },
    { id: 'p', label: '% Var', kind: 'variance_pct', source: 'actual', range: { start: '2026-01-01', end: '2026-01-31' }, of: 'a', against: 'b', percent: true },
    { id: 'cs', label: '%', kind: 'common_size', source: 'actual', range: { start: '2026-01-01', end: '2026-01-31' }, of: 'a', percent: true },
  ];
  it('variance $ / %, F/U by polarity, common size, and margin variance in points', () => {
    const rows: ReportRow[] = [
      { id: 'rev', kind: 'subtotal', label: 'Revenue', depth: 0, values: [1200, 1000, null, null, null], goodWhen: 'up' },
      { id: 'cost', kind: 'subtotal', label: 'Cost', depth: 0, values: [700, 600, null, null, null], goodWhen: 'down' },
      { id: 'gm', kind: 'formula', label: 'GM', depth: 0, values: [41.7, 40, null, null, null], percent: true, goodWhen: 'up' },
    ];
    fillDerived(cols, rows, 'rev');
    expect(rows[0].values.slice(2)).toEqual([200, 20, 100]);
    expect(rows[0].fu?.[2]).toBe('F');
    expect(rows[1].values.slice(2)).toEqual([100, 16.7, 58.3]);
    expect(rows[1].fu?.[2]).toBe('U');
    expect(rows[2].values.slice(2)).toEqual([1.7, null, null]);
  });
  it('tieViolations flags a subtotal that does not equal its parts', () => {
    const rows: ReportRow[] = [
      { id: 'x', kind: 'account', label: 'x', depth: 1, values: [5, 1, null, null, null] },
      { id: 'y', kind: 'account', label: 'y', depth: 1, values: [6, 1, null, null, null] },
      { id: 't', kind: 'subtotal', label: 'T', depth: 0, values: [11, 3, null, null, null], sumOf: [{ id: 'x', sign: 1 }, { id: 'y', sign: 1 }] },
    ];
    expect(tieViolations(cols, rows)).toEqual(['T / Budget: shows 3, parts sum to 2']);
  });
});

describe('cash-flow classification is by type / role / flag, never by number', () => {
  const base = { number: '9999', subTypeName: '', subTypeOrder: 0, groupId: 'g', groupName: '', groupOrder: 0, order: 0, isEliminating: false, isActive: true, cashFlowCategory: null } as const;
  const acct = (o: Partial<AccountMeta>): AccountMeta => ({ ...base, id: 'a', name: 'x', type: 'ASSET', subType: 'CURRENT_ASSET', normalBalance: 'DEBIT', isBank: false, roles: [], ...o } as AccountMeta);
  it('classifies a re-numbered chart correctly', () => {
    const none = new Set<string>();
    expect(cashFlowCategory(acct({ isBank: true }), none)).toBe('CASH');
    expect(cashFlowCategory(acct({ roles: ['UNDEPOSITED_FUNDS'] }), none)).toBe('CASH');
    expect(cashFlowCategory(acct({}), none)).toBe('OPERATING');
    expect(cashFlowCategory(acct({ subType: 'FIXED_ASSET' }), none)).toBe('INVESTING');
    expect(cashFlowCategory(acct({ id: 'ad', subType: 'FIXED_ASSET' }), new Set(['ad']))).toBe('NONCASH');
    expect(cashFlowCategory(acct({ type: 'LIABILITY', subType: 'CURRENT_LIABILITY', roles: ['NOTES_PAYABLE'] }), none)).toBe('FINANCING');
    expect(cashFlowCategory(acct({ type: 'LIABILITY', subType: 'CURRENT_LIABILITY' }), none)).toBe('OPERATING');
    expect(cashFlowCategory(acct({ type: 'EQUITY', subType: 'EQUITY' }), none)).toBe('FINANCING');
    expect(cashFlowCategory(acct({ cashFlowCategory: 'INVESTING' }), none)).toBe('INVESTING');
    expect(cashFlowCategory(acct({ type: 'REVENUE', subType: 'REVENUE' }), none)).toBeNull();
  });
});
