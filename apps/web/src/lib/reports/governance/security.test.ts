/**
 * Security-review fixes for number governance (Wave 3 H3): in-order releases, forecast /
 * balance-sheet / pre-acquisition gating, side-channel stripping, drill gating, fail-closed
 * hooks. PURE (no DB).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReportColumn, ReportResult } from '@/lib/reports/engine/types';
import { applyGovernance as applyEngineGovernance, governDrill, registerDrillGovernance, registerGovernance, registerMembership, resolveMembership } from '@/lib/reports/engine/governance-hook';
import { earlierUnreleased, evaluateGovernance, releaseState, releasedThrough } from './policy';
import { gateDrill, governColumns, governReportResult, governResult, intersectWindows, redactAmounts, drillWindowOf } from './engine-adapter';
import { monthEnd } from './periods';
import { DEFAULT_RELEASE_SETTINGS, type CompanyFacts, type GovernanceDecision, type GovernanceFacts, type PeriodStatus } from './types';
import { snapshotHashConsistent, statementHash, verifiedSnapshotHash } from './snapshot';

const A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const B = 'bbbbbbbb-0000-0000-0000-00000000000b';
const TODAY = '2026-12-15';

function co(id: string, months: Array<[number, PeriodStatus]>, released: number[], over: Partial<CompanyFacts> = {}): CompanyFacts {
  return {
    locationId: id,
    name: id === A ? 'Alpha' : 'Beta',
    fiscalYearStartMonth: 1,
    periods: months.map(([m, status]) => ({ year: 2026, month: m, status, endDate: monthEnd(`2026-${String(m).padStart(2, '0')}`), closedAt: null, reopenReason: null })),
    releases: released.map((m) => ({ id: `r${m}`, year: 2026, month: m, status: 'RELEASED', mode: 'MANUAL', releasedAt: '2026-11-01T00:00:00Z', releasedBy: 'u', withdrawnAt: null, withdrawReason: null, baselineSnapshotId: null })),
    restatements: [],
    coverage: null,
    settings: DEFAULT_RELEASE_SETTINGS,
    ...over,
  };
}

const HC = (ms: number[]): Array<[number, PeriodStatus]> => ms.map((m) => [m, 'HARD_CLOSE']);
const facts = (...cs: CompanyFacts[]): GovernanceFacts => ({ companies: Object.fromEntries(cs.map((c) => [c.locationId, c])), tenantSettings: DEFAULT_RELEASE_SETTINGS });
const key = (m: number) => `2026-${String(m).padStart(2, '0')}`;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => key(from + i));

function decide(f: GovernanceFacts, months: string[], ids: string[], audience: 'finance' | 'non_finance' = 'non_finance', scopeKind: 'company' | 'combined' = ids.length > 1 ? 'combined' : 'company', includePreview = true): GovernanceDecision {
  return evaluateGovernance({ view: { periods: months, locationIds: ids, scopeKind }, facts: f, audience, options: { includePreview }, today: TODAY });
}

function col(id: string, start: string | null, end: string, over: Partial<ReportColumn> = {}): ReportColumn {
  return { id, label: id, kind: 'amount', source: 'actual', range: { start, end }, drill: { companyIds: [], range: { start, end }, kinds: ['STANDARD'] }, ...over };
}

function result(columns: ReportColumn[], companies = [A], over: Partial<ReportResult> = {}): ReportResult {
  return {
    statement: 'income_statement',
    title: 'Statement',
    subtitle: '',
    basis: 'ACCRUAL',
    basisLabel: 'Accrual',
    rounding: 'cents',
    range: { start: '2026-01-01', end: '2026-12-31' },
    columns,
    rows: [{ id: 'r', kind: 'account', label: 'Revenue', depth: 0, values: columns.map(() => 500_00), fu: columns.map(() => null), cellDrill: columns.map(() => null) }],
    warnings: [],
    notes: [],
    companies: companies.map((id) => ({ id, name: id === A ? 'Alpha' : 'Beta' })),
    checks: [],
    chartSeries: [],
    generatedAt: '2026-12-15T00:00:00Z',
    ...over,
  };
}

describe('releases are IN ORDER (policy)', () => {
  it('an explicit release does not count while an earlier month with a period is unreleased', () => {
    const c = co(A, HC([7, 8, 9]), [8, 9]);
    expect(releaseState(c, key(8), TODAY)).toMatchObject({ released: false, heldBy: key(7) });
    expect(releaseState(c, key(9), TODAY)).toMatchObject({ released: false, heldBy: key(7) });
    expect(releasedThrough(c, TODAY)).toBeNull();
    expect(earlierUnreleased(c, key(8), TODAY)).toBe(key(7));
  });

  it('the auto rule cannot leapfrog a withdrawn (withheld) month', () => {
    const c = co(A, HC([7, 8, 9]), [], { settings: { ...DEFAULT_RELEASE_SETTINGS, autoReleaseEnabled: true, autoReleaseDays: 5 } });
    expect(releaseState(c, key(9), TODAY).released).toBe(true);
    c.releases.push({ id: 'w8', year: 2026, month: 8, status: 'WITHDRAWN', mode: 'MANUAL', releasedAt: null, releasedBy: null, withdrawnAt: '2026-11-01T00:00:00Z', withdrawReason: 'Accrual review', baselineSnapshotId: null });
    expect(releaseState(c, key(7), TODAY).released).toBe(true);
    expect(releaseState(c, key(8), TODAY).released).toBe(false);
    expect(releaseState(c, key(9), TODAY)).toMatchObject({ released: false, heldBy: key(8) });
    const d = decide(facts(c), range(7, 9), [A]);
    expect(d.shownPeriodKeys).toEqual([key(7)]);
    expect(d.releasedThrough.scope).toBe(key(7));
  });

  it('months without a fiscal period do not block (gaps are skipped)', () => {
    const c = co(A, HC([5, 7]), [5, 7]);
    expect(releaseState(c, key(7), TODAY).released).toBe(true);
  });
});

describe('forecast columns are gated like actuals for the months they fill with actuals', () => {
  // Jul–Sep hard-closed (actuals in the forecast), Oct–Dec open (budget).
  const months: Array<[number, PeriodStatus]> = [[7, 'HARD_CLOSE'], [8, 'HARD_CLOSE'], [9, 'HARD_CLOSE'], [10, 'OPEN'], [11, 'OPEN'], [12, 'OPEN']];
  const fc = col('fc', '2026-07-01', '2026-12-31', { source: 'forecast' });
  const bud = col('bud', '2026-07-01', '2026-12-31', { source: 'budget' });
  const view = result([fc, bud]);

  it('withheld when a closed (actual) month inside it is unreleased; budget columns pass', () => {
    const f = facts(co(A, months, [7, 8]));
    const d = decide(f, range(7, 12), [A]);
    const g = governColumns(view, d);
    expect([...g.withheld]).toEqual(['fc']);
  });

  it('shown once every actual month is released — open (budget) months never block', () => {
    const f = facts(co(A, months, [7, 8, 9]));
    const g = governColumns(view, decide(f, range(7, 12), [A]));
    expect(g.withheld.size).toBe(0);
  });

  it('the registered hook gates forecast months even when no actual column exists', async () => {
    const out = await governReportResult(view, { supabase: {} as never, orgId: 'org', userId: null, request: { scope: { companyIds: [A] } } as never }, { loadFacts: async () => facts(co(A, months, [7])) });
    expect(out.rows[0].values).toEqual([null, 500_00]);
  });
});

describe('balance-sheet (inception) columns need the whole history released', () => {
  it('a column as of a released month is withheld when an EARLIER month is not released (defense in depth)', () => {
    const f = facts(co(A, HC([7, 8, 9]), [7, 8, 9]));
    const view = result([col('bs', null, '2026-09-30')], [A], { statement: 'balance_sheet' });
    const gate = decide(f, range(7, 9), [A]);
    expect(governColumns(view, gate).withheld.size).toBe(0);
    // Forge a decision where August is not released but September is (what the in-order rule
    // prevents) — the history gate still withholds the balance sheet.
    const forged: GovernanceDecision = {
      ...gate,
      periods: gate.periods.map((p) => (p.key === key(8) ? { ...p, companies: p.companies.map((c) => ({ ...c, release: { ...c.release, released: false } })) } : p)),
    };
    expect([...governColumns(view, forged).withheld]).toEqual(['bs']);
  });

  it('the registered hook asks for every month from the first fiscal period', async () => {
    let asked: string[] = [];
    const f = facts(co(A, HC([1, 2, 3, 4, 5, 6, 7, 8, 9]), [1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const view = result([col('bs', null, '2026-09-30')], [A], { statement: 'balance_sheet' });
    const out = await governReportResult(
      view,
      { supabase: {} as never, orgId: 'org', userId: null, request: { scope: { companyIds: [A] } } as never },
      { loadFacts: async () => f, probe: { has: async () => false } },
    );
    expect(out.rows[0].values).toEqual([500_00]);
    // the display footnote / months only talk about the as-of month
    expect((out.governance?.months as Array<{ month: string }>).map((m) => m.month)).toEqual([key(9)]);
    asked = (out.governance?.months as Array<{ month: string }>).map((m) => m.month);
    expect(asked).not.toContain(key(1));
  });
});

describe('pre-acquisition months a report did not window out (TB / GL summary)', () => {
  const f = () => facts(co(A, HC([7, 8, 9]), [7, 8, 9]), co(B, HC([7, 8, 9]), [7, 8, 9], { coverage: { inGroupFrom: '2026-08-01', inGroupUntil: null } }));
  const tb = (windowed: string[]) => result([col('dr', '2026-07-01', '2026-09-30', { kind: 'debit', sublabel: 'Adjusted' })], [A, B], { statement: 'trial_balance', groupWindowCompanyIds: windowed });

  it('non-finance: figures that still contain the excluded months are WITHHELD', () => {
    const out = governResult(tb([]), decide(f(), range(7, 9), [A, B]));
    expect(out.rows[0].values).toEqual([null]);
    expect(out.notes.join(' ')).toMatch(/joined the group during this period/);
  });

  it('non-finance: when the engine applied the window the figures are shown', () => {
    const out = governResult(tb([B]), decide(f(), range(7, 9), [A, B]));
    expect(out.rows[0].values).toEqual([500_00]);
  });

  it('finance: shown, annotated (pro forma is a finance view)', () => {
    const out = governResult(tb([]), decide(f(), range(7, 9), [A, B], 'finance'));
    expect(out.rows[0].values).toEqual([500_00]);
    expect(out.notes.join(' ')).toMatch(/months before/);
  });
});

describe('side channels are stripped when a column is withheld', () => {
  const f = facts(co(A, HC([7, 8, 9]), [7, 8]));
  const cols = [col('aug', '2026-08-01', '2026-08-31'), col('sep', '2026-09-01', '2026-09-30')];
  const view = result(cols, [A], {
    checks: [
      { id: 'bs:aug', label: 'Assets = liabilities + equity (aug)', ok: true, differenceCents: 0 },
      { id: 'bs:sep', label: 'Assets = liabilities + equity (sep)', ok: false, differenceCents: 1234 },
    ],
    warnings: [
      { code: 'OUT_OF_BALANCE', message: 'The balance sheet is out of balance by 1234 cents (sep).', amountCents: 1234 },
      { code: 'ELIMINATION_RESIDUAL', message: 'Intercompany balances do not offset.', amountCents: 999 },
      { code: 'OUT_OF_BALANCE', message: 'Internal total check failed: Net income / sep: shows 700, parts sum to 690' },
    ],
    notes: ['Non-controlling interest: equity 5000 cents, share of net income 250 cents (included).'],
    chartSeries: [{ rowId: 'r', label: 'Revenue', points: cols.map((c) => ({ columnId: c.id, label: c.label, cents: 500_00 })) }],
  });
  const out = governResult(view, decide(f, range(8, 9), [A]));

  it('checks over a withheld column are dropped; the rest lose their difference', () => {
    expect(out.checks).toEqual([{ id: 'bs:aug', label: 'Assets = liabilities + equity (aug)', ok: true, differenceCents: null }]);
  });

  it('warnings lose amountCents and any amount in the text; notes too', () => {
    expect(out.warnings.every((w) => w.amountCents === undefined)).toBe(true);
    const text = [...out.warnings.map((w) => w.message), ...out.notes].join(' | ');
    expect(text).not.toMatch(/1234|5000|250 cents|700|690/);
    expect(out.notes[0]).toMatch(/Non-controlling interest: equity an amount/);
  });

  it('chart points and cells of the withheld column are null; released figures untouched', () => {
    expect(out.rows[0].values).toEqual([500_00, null]);
    expect(out.chartSeries[0].points.map((p) => p.cents)).toEqual([500_00, null]);
  });

  it('nothing withheld → side channels untouched', () => {
    const all = governResult(view, decide(facts(co(A, HC([7, 8, 9]), [7, 8, 9])), range(8, 9), [A]));
    expect(all.checks).toEqual(view.checks);
    expect(all.warnings).toEqual(view.warnings);
  });

  it('redactAmounts', () => {
    expect(redactAmounts('off by -1,234 cents in Q3 2026')).toBe('off by an amount in Q3 2026');
    expect(redactAmounts('Total $1,234.56 for 4000 Revenue')).toBe('Total an amount for 4000 Revenue');
  });
});

describe('drill gating (pure)', () => {
  const f = () => facts(co(A, HC([7, 8, 9]), [7, 8]), co(B, HC([7, 8, 9]), [7, 8, 9], { coverage: { inGroupFrom: '2026-08-01', inGroupUntil: null } }));

  it('non-finance: any unreleased month in the range is denied', () => {
    const d = decide(f(), range(7, 9), [A]);
    expect(gateDrill(d, { companyIds: [A], range: { start: '2026-08-01', end: '2026-09-30' } }).denied).toEqual([key(9)]);
    expect(gateDrill(d, { companyIds: [A], range: { start: '2026-07-01', end: '2026-08-31' } }).denied).toEqual([]);
  });

  it('non-finance, balance-sheet drill: every month through the as-of month', () => {
    const d = decide(f(), range(7, 9), [A]);
    expect(gateDrill(d, { companyIds: [A], range: { start: null, end: '2026-09-30' } }).denied).toEqual([key(9)]);
    expect(gateDrill(d, { companyIds: [A], range: { start: null, end: '2026-08-31' } }).denied).toEqual([]);
  });

  it('non-finance: in-group windows come from the decision (server-side)', () => {
    const d = decide(f(), range(7, 8), [A, B]);
    const g = gateDrill(d, { companyIds: [A, B], range: { start: '2026-07-01', end: '2026-08-31' } });
    expect(g.denied).toEqual([]);
    expect(g.windows).toEqual({ [B]: { from: '2026-08-01', to: null } });
    // point in time: a company outside the group at the as-of month is dropped entirely
    const d7 = decide(f(), range(7, 7), [A, B]);
    expect(gateDrill(d7, { companyIds: [A, B], range: { start: null, end: '2026-07-31' } }).windows[B]).toEqual({ from: '9999-12-01', to: null });
  });

  it('finance with preview: allowed, no forced windows', () => {
    const d = decide(f(), range(7, 9), [A, B], 'finance');
    expect(gateDrill(d, { companyIds: [A, B], range: { start: '2026-07-01', end: '2026-09-30' } })).toEqual({ denied: [], windows: {} });
  });

  it('finance with preview OFF is gated like non-finance', () => {
    const d = decide(f(), range(7, 9), [A], 'finance', 'company', false);
    expect(gateDrill(d, { companyIds: [A], range: { start: '2026-09-01', end: '2026-09-30' } }).denied).toEqual([key(9)]);
  });

  it('windows only narrow: intersect takes the later from and the earlier to', () => {
    expect(intersectWindows({ from: '2026-08-01', to: null }, { from: '2025-01-01', to: '2026-09-15' })).toEqual({ from: '2026-08-01', to: '2026-09-15' });
    expect(intersectWindows(undefined, { from: '2026-02-01', to: null })).toEqual({ from: '2026-02-01', to: null });
    expect(drillWindowOf({ from: '2026-02-01', until: '2026-05-01' })).toEqual({ from: '2026-02-01', to: '2026-05-31' });
  });
});

describe('governance hooks fail closed in production', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('unregistered hooks throw in production and are the identity elsewhere', async () => {
    registerGovernance(null);
    registerMembership(null);
    registerDrillGovernance(null);
    const view = result([col('jul', '2026-07-01', '2026-07-31')]);
    const ctx = { supabase: {} as never, orgId: 'org', userId: 'u', request: { scope: { companyIds: [A] } } as never };
    await expect(applyEngineGovernance(view, ctx)).resolves.toBe(view);
    vi.stubEnv('NODE_ENV', 'production');
    await expect(applyEngineGovernance(view, ctx)).rejects.toThrow(/not installed/);
    await expect(resolveMembership({ months: [key(7)], companyIds: [A], scopeKind: 'company' }, ctx)).rejects.toThrow(/not installed/);
    await expect(governDrill({ companyIds: [A], range: { start: null, end: '2026-07-31' } }, ctx)).rejects.toThrow(/not installed/);
  });
});

describe('restatement hash is verified server-side', () => {
  it('the hash is recomputed from the stored nets; a tampered stored hash is detected', () => {
    const nets = { [A]: 100, [B]: -100 };
    const good = { account_balances: nets, statement_hash: statementHash(nets) };
    expect(verifiedSnapshotHash(good)).toBe(statementHash(nets));
    expect(snapshotHashConsistent(good)).toBe(true);
    expect(snapshotHashConsistent({ ...good, statement_hash: '0'.repeat(64) })).toBe(false);
    // zero nets are ignored exactly like the live summary
    expect(verifiedSnapshotHash({ account_balances: { ...nets, zero: 0 } })).toBe(statementHash(nets));
  });
});
