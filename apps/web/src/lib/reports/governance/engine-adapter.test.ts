import { describe, expect, it } from 'vitest';
import type { ReportColumn, ReportResult } from '@/lib/reports/engine/types';
import { governColumns, governReportResult, governResult, resultMonths, windowsFromDecision } from './engine-adapter';
import { evaluateGovernance } from './policy';
import { monthEnd } from './periods';
import { DEFAULT_RELEASE_SETTINGS, type CompanyFacts, type GovernanceFacts } from './types';

const A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const B = 'bbbbbbbb-0000-0000-0000-00000000000b';

function co(id: string, releasedMonths: number[], over: Partial<CompanyFacts> = {}): CompanyFacts {
  return {
    locationId: id,
    name: id === A ? 'Alpha' : 'Beta',
    fiscalYearStartMonth: 1,
    periods: [7, 8, 9].map((m) => ({ year: 2026, month: m, status: m < 9 ? 'HARD_CLOSE' : 'SOFT_CLOSE', endDate: monthEnd(`2026-0${m}`), closedAt: null, reopenReason: null })),
    releases: releasedMonths.map((m) => ({ id: `r${m}`, year: 2026, month: m, status: 'RELEASED', mode: 'MANUAL', releasedAt: `2026-0${m}-28T00:00:00Z`, releasedBy: 'u', withdrawnAt: null, withdrawReason: null, baselineSnapshotId: null })),
    restatements: [],
    coverage: null,
    settings: DEFAULT_RELEASE_SETTINGS,
    ...over,
  };
}

function col(id: string, start: string | null, end: string, over: Partial<ReportColumn> = {}): ReportColumn {
  return { id, label: id, kind: 'amount', source: 'actual', range: { start, end }, drill: { companyIds: [], range: { start, end }, kinds: ['STANDARD'] }, ...over };
}

function result(columns: ReportColumn[], companies = [A]): ReportResult {
  return {
    statement: 'income_statement',
    title: 'Income statement',
    subtitle: '',
    basis: 'ACCRUAL',
    basisLabel: 'Accrual',
    rounding: 'cents',
    range: { start: '2026-07-01', end: '2026-09-30' },
    columns,
    rows: [
      { id: 'rev', kind: 'account', label: 'Revenue', depth: 0, values: columns.map(() => 1_000_00), fu: columns.map(() => null), cellDrill: columns.map(() => null) },
    ],
    warnings: [],
    notes: [],
    companies: companies.map((id) => ({ id, name: id === A ? 'Alpha' : 'Beta' })),
    checks: [],
    chartSeries: [{ rowId: 'rev', label: 'Revenue', points: columns.map((c) => ({ columnId: c.id, label: c.label, cents: 1_000_00 })) }],
    generatedAt: '2026-10-24T00:00:00Z',
  };
}

const facts = (...cs: CompanyFacts[]): GovernanceFacts => ({ companies: Object.fromEntries(cs.map((c) => [c.locationId, c])), tenantSettings: DEFAULT_RELEASE_SETTINGS });

const byMonth = [
  col('jul', '2026-07-01', '2026-07-31'),
  col('aug', '2026-08-01', '2026-08-31'),
  col('sep', '2026-09-01', '2026-09-30'),
  col('var', null, '2026-09-30', { kind: 'variance_amount', of: 'sep', against: 'aug' }),
  col('bud', '2026-09-01', '2026-09-30', { source: 'budget' }),
];

describe('engine adapter — governing a ReportResult', () => {
  it('collects the months the actual columns touch (balance-sheet columns by their end month)', () => {
    expect(resultMonths(result(byMonth))).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(resultMonths(result([col('bs', null, '2026-08-31')]))).toEqual(['2026-08']);
  });

  it('non-finance: unreleased month columns (and what derives from them) are blanked; released figures untouched', () => {
    const view = result(byMonth);
    const d = evaluateGovernance({ view: { periods: resultMonths(view), locationIds: [A], scopeKind: 'company' }, facts: facts(co(A, [7, 8])), audience: 'non_finance', today: '2026-10-24' });
    const out = governResult(view, d);
    expect(out.rows[0].values).toEqual([1_000_00, 1_000_00, null, null, 1_000_00]);
    expect(out.columns.find((c) => c.id === 'sep')).toMatchObject({ sublabel: 'Not released', drill: null });
    expect(out.chartSeries[0].points.find((p) => p.columnId === 'sep')?.cents).toBeNull();
    expect(out.governance).toMatchObject({ booksClosedThrough: '2026-08', released: false, withheldColumnIds: ['sep', 'var'] });
    expect(out.notes.join(' ')).toMatch(/not released for your audience/);
  });

  it('finance: unreleased columns are kept as preview with the banner', () => {
    const view = result(byMonth);
    const d = evaluateGovernance({ view: { periods: resultMonths(view), locationIds: [A], scopeKind: 'company' }, facts: facts(co(A, [7, 8])), audience: 'finance', today: '2026-10-24' });
    const out = governResult(view, d);
    expect(out.rows[0].values.every((v) => v === 1_000_00)).toBe(true);
    expect(out.governance).toMatchObject({ watermark: 'preview', previewColumnIds: ['sep', 'var'], withheldColumnIds: [] });
    expect(String((out.governance as { banner: { text: string } }).banner.text)).toMatch(/^Preview — not released/);
  });

  it('a company column is gated by its own release; the consolidated column by every member', () => {
    const cols = [
      col('a', '2026-08-01', '2026-08-31', { drill: { companyIds: [A], range: { start: '2026-08-01', end: '2026-08-31' }, kinds: ['STANDARD'] } }),
      col('b', '2026-08-01', '2026-08-31', { drill: { companyIds: [B], range: { start: '2026-08-01', end: '2026-08-31' }, kinds: ['STANDARD'] } }),
      col('total', '2026-08-01', '2026-08-31', { kind: 'total' }),
    ];
    const view = result(cols, [A, B]);
    const d = evaluateGovernance({ view: { periods: ['2026-08'], locationIds: [A, B], scopeKind: 'combined' }, facts: facts(co(A, [7, 8]), co(B, [])), audience: 'non_finance', today: '2026-10-24' });
    const g = governColumns(view, d);
    expect([...g.withheld].sort()).toEqual(['b', 'total']);
  });

  it('a YTD column containing an unreleased month is withheld for non-finance', () => {
    const view = result([col('ytd', '2026-07-01', '2026-09-30')]);
    const d = evaluateGovernance({ view: { periods: resultMonths(view), locationIds: [A], scopeKind: 'company' }, facts: facts(co(A, [7, 8])), audience: 'non_finance', today: '2026-10-24' });
    expect(governResult(view, d).rows[0].values).toEqual([null]);
  });

  it('the registered hook resolves the audience server-side; no user = partner view', async () => {
    const view = result(byMonth);
    const out = await governReportResult(
      view,
      { supabase: {} as never, orgId: 'org', userId: null, request: { scope: { companyIds: [A] } } as never, preview: true },
      { loadFacts: async () => facts(co(A, [7, 8])) },
    );
    expect(out.governance).toMatchObject({ audience: 'non_finance', withheldColumnIds: ['sep', 'var'] });
  });
});

describe('windowsFromDecision (pre-acquisition exclusion before aggregation)', () => {
  const facts = (over: Partial<CompanyFacts>): GovernanceFacts => ({
    companies: { [A]: co(A, [7, 8, 9]), [B]: co(B, [7, 8, 9], over) },
    tenantSettings: DEFAULT_RELEASE_SETTINGS,
  });
  const decide = (f: GovernanceFacts, scopeKind: 'company' | 'combined', audience: 'finance' | 'non_finance' = 'non_finance') =>
    evaluateGovernance({ view: { periods: ['2026-07', '2026-08', '2026-09'], locationIds: scopeKind === 'company' ? [B] : [A, B], scopeKind }, facts: f, audience, today: '2026-10-24' });

  it('a company joining in August gets a window from August; the others none', () => {
    const w = windowsFromDecision(decide(facts({ coverage: { inGroupFrom: '2026-08-15', inGroupUntil: null } }), 'combined'));
    expect(w).toEqual({ [B]: { from: '2026-08-01', until: null } });
  });

  it('a company leaving after July gets an until; never-in-group gets an empty window', () => {
    expect(windowsFromDecision(decide(facts({ coverage: { inGroupFrom: null, inGroupUntil: '2026-07-31' } }), 'combined'))).toEqual({ [B]: { from: null, until: '2026-07-01' } });
    expect(windowsFromDecision(decide(facts({ coverage: { inGroupFrom: '2027-01-01', inGroupUntil: null } }), 'combined'))[B]?.from).toBe('9999-12-01');
  });

  it('finance reading one company sees its own books (no window)', () => {
    expect(windowsFromDecision(decide(facts({ coverage: { inGroupFrom: '2026-08-15', inGroupUntil: null } }), 'company', 'finance'))).toEqual({});
  });
});
