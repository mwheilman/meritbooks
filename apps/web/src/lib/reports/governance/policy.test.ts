import { describe, expect, it } from 'vitest';
import { closedThrough, evaluateGovernance, releaseState, releasedThrough } from './policy';
import { assertShown, filterByGovernance, GovernanceDeniedError } from './filter';
import { applyGovernance } from './apply';
import { ResolvedAudience, resolveGovernanceAudience, type CapabilityProbe } from './audience';
import { monthEnd } from './periods';
import {
  DEFAULT_RELEASE_SETTINGS,
  type CompanyFacts,
  type FiscalPeriodFact,
  type GovernanceFacts,
  type PeriodStatus,
  type ReleaseFact,
  type ReleaseSettings,
} from './types';

const A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const B = 'bbbbbbbb-0000-0000-0000-00000000000b';
const C = 'cccccccc-0000-0000-0000-00000000000c';

function period(key: string, status: PeriodStatus): FiscalPeriodFact {
  const [y, m] = key.split('-').map(Number);
  return { year: y, month: m, status, endDate: monthEnd(key), closedAt: null, reopenReason: null };
}

function released(key: string, mode: 'MANUAL' | 'AUTO' = 'MANUAL', at = `${key}-28T12:00:00Z`): ReleaseFact {
  const [y, m] = key.split('-').map(Number);
  return { id: `r-${key}`, year: y, month: m, status: 'RELEASED', mode, releasedAt: at, releasedBy: 'user_ctl', withdrawnAt: null, withdrawReason: null, baselineSnapshotId: null };
}

function withdrawn(key: string): ReleaseFact {
  const [y, m] = key.split('-').map(Number);
  return { id: `w-${key}`, year: y, month: m, status: 'WITHDRAWN', mode: 'MANUAL', releasedAt: null, releasedBy: null, withdrawnAt: '2026-10-01T00:00:00Z', withdrawReason: 'Wrong accrual', baselineSnapshotId: null };
}

function company(id: string, over: Partial<CompanyFacts> = {}): CompanyFacts {
  return {
    locationId: id,
    name: `Co ${id.slice(0, 1).toUpperCase()}`,
    fiscalYearStartMonth: 1,
    periods: [period('2026-06', 'HARD_CLOSE'), period('2026-07', 'HARD_CLOSE'), period('2026-08', 'HARD_CLOSE'), period('2026-09', 'SOFT_CLOSE'), period('2026-10', 'OPEN')],
    releases: [released('2026-06'), released('2026-07')],
    restatements: [],
    coverage: null,
    settings: DEFAULT_RELEASE_SETTINGS,
    ...over,
  };
}

function facts(...cs: CompanyFacts[]): GovernanceFacts {
  return { companies: Object.fromEntries(cs.map((c) => [c.locationId, c])), tenantSettings: DEFAULT_RELEASE_SETTINGS };
}

const AUTO20: ReleaseSettings = { ...DEFAULT_RELEASE_SETTINGS, autoReleaseEnabled: true, autoReleaseDays: 20, autoReleaseMinStatus: 'HARD_CLOSE' };
const MONTHS = ['2026-06', '2026-07', '2026-08', '2026-09'];

describe('release rules', () => {
  it('manual release row releases the month', () => {
    const c = company(A);
    expect(releaseState(c, '2026-07', '2026-10-24')).toMatchObject({ released: true, mode: 'MANUAL', derived: false });
    expect(releaseState(c, '2026-08', '2026-10-24').released).toBe(false);
  });

  it('auto-release fires on month end + N days, not a day before, and only when hard-closed', () => {
    const c = company(A, { releases: [], settings: AUTO20 });
    // Aug ends 08-31 → releases 09-20.
    expect(releaseState(c, '2026-08', '2026-09-19').released).toBe(false);
    expect(releaseState(c, '2026-08', '2026-09-19').autoReleaseOn).toBe('2026-09-20');
    expect(releaseState(c, '2026-08', '2026-09-20')).toMatchObject({ released: true, mode: 'AUTO', derived: true, releasedOn: '2026-09-20' });
    // Sep is SOFT_CLOSE and the minimum is HARD_CLOSE → never auto-released.
    expect(releaseState(c, '2026-09', '2026-10-24')).toMatchObject({ released: false, blockedBy: 'soft_close_below_minimum' });
    // OPEN month never.
    expect(releaseState(c, '2026-10', '2026-12-31')).toMatchObject({ released: false, blockedBy: 'open' });
  });

  it('a SOFT_CLOSE minimum lets soft-closed months auto-release', () => {
    const c = company(A, { releases: [], settings: { ...AUTO20, autoReleaseMinStatus: 'SOFT_CLOSE' } });
    expect(releaseState(c, '2026-09', '2026-10-20').released).toBe(true);
    expect(releaseState(c, '2026-09', '2026-10-19').released).toBe(false);
  });

  it('with the rule off nothing auto-releases', () => {
    const c = company(A, { releases: [] });
    expect(releaseState(c, '2026-06', '2027-06-01').released).toBe(false);
    expect(releaseState(c, '2026-06', '2027-06-01').autoReleaseOn).toBeNull();
  });

  it('a withdrawn month stays withdrawn even when the auto rule would release it', () => {
    const c = company(A, { releases: [withdrawn('2026-08')], settings: AUTO20 });
    expect(releaseState(c, '2026-08', '2026-10-24')).toMatchObject({ released: false, withdrawn: true });
  });

  it('released-through is the latest released month', () => {
    expect(releasedThrough(company(A), '2026-10-24')).toBe('2026-07');
    expect(releasedThrough(company(A, { releases: [], settings: AUTO20 }), '2026-10-24')).toBe('2026-08');
  });
});

describe('books closed through', () => {
  it('is the contiguous HARD_CLOSE run from the first period', () => {
    expect(closedThrough(company(A))).toBe('2026-08');
  });
  it('a reopened month pulls it back', () => {
    const c = company(A, { periods: [period('2026-06', 'HARD_CLOSE'), period('2026-07', 'OPEN'), period('2026-08', 'HARD_CLOSE')] });
    expect(closedThrough(c)).toBe('2026-06');
  });
  it('a missing month ends the run; nothing closed → null', () => {
    expect(closedThrough(company(A, { periods: [period('2026-06', 'HARD_CLOSE'), period('2026-08', 'HARD_CLOSE')] }))).toBe('2026-06');
    expect(closedThrough(company(A, { periods: [period('2026-06', 'OPEN')] }))).toBeNull();
  });
});

describe('audience visibility (enforcement)', () => {
  const view = { periods: MONTHS, locationIds: [A], scopeKind: 'company' as const };

  it('an owner (non-finance) sees only released months', () => {
    const d = evaluateGovernance({ view, facts: facts(company(A)), audience: 'non_finance', today: '2026-10-24' });
    expect(d.shownPeriodKeys).toEqual(['2026-06', '2026-07']);
    expect(d.periods.find((p) => p.key === '2026-08')).toMatchObject({ visibility: 'hidden', hiddenReason: 'not_released' });
    expect(d.banner).toBeNull();
    expect(d.watermark).toBe('none');
    expect(d.locationsByPeriod['2026-08']).toEqual([]);
  });

  it('a controller (finance) sees unreleased months as preview with the banner', () => {
    const d = evaluateGovernance({ view, facts: facts(company(A)), audience: 'finance', today: '2026-10-24' });
    expect(d.shownPeriodKeys).toEqual(MONTHS);
    expect(d.periods.find((p) => p.key === '2026-08')?.visibility).toBe('preview');
    expect(d.watermark).toBe('preview');
    expect(d.banner?.text).toMatch(/^Preview — not released/);
    expect(d.footnote).toMatch(/Books closed through Aug 2026/);
  });

  it('finance with preview off sees exactly the partner view', () => {
    const fin = evaluateGovernance({ view, facts: facts(company(A)), audience: 'finance', options: { includePreview: false }, today: '2026-10-24' });
    const own = evaluateGovernance({ view, facts: facts(company(A)), audience: 'non_finance', today: '2026-10-24' });
    expect(fin.shownPeriodKeys).toEqual(own.shownPeriodKeys);
    expect(fin.locationsByPeriod).toEqual(own.locationsByPeriod);
  });

  it('includePreview requested by a non-finance caller is ignored', () => {
    const d = evaluateGovernance({ view, facts: facts(company(A)), audience: 'non_finance', options: { includePreview: true, proForma: true }, today: '2026-10-24' });
    expect(d.includePreview).toBe(false);
    expect(d.proForma).toBe(false);
    expect(d.shownPeriodKeys).toEqual(['2026-06', '2026-07']);
  });

  it('filterByGovernance drops every hidden figure server-side', () => {
    const d = evaluateGovernance({ view, facts: facts(company(A)), audience: 'non_finance', today: '2026-10-24' });
    const rows = MONTHS.map((k) => ({ period: k, location_id: A, revenue_cents: 100_00 }));
    const out = filterByGovernance(rows, d, (r) => ({ periodKey: r.period, locationId: r.location_id }));
    expect(out.map((r) => r.period)).toEqual(['2026-06', '2026-07']);
    // Unattributable rows fail closed.
    expect(filterByGovernance([{ period: null, location_id: A }], d, (r) => ({ periodKey: r.period, locationId: r.location_id }))).toEqual([]);
    expect(() => assertShown(d, ['2026-08'])).toThrow(GovernanceDeniedError);
    expect(() => assertShown(d, ['2026-07'])).not.toThrow();
  });

  it('a released but unclosed month is shown with a preliminary watermark', () => {
    // releases are in order: June → September all released
    const c = company(A, { releases: [released('2026-06'), released('2026-07'), released('2026-08'), released('2026-09')] });
    const d = evaluateGovernance({ view: { ...view, periods: ['2026-09'] }, facts: facts(c), audience: 'non_finance', today: '2026-10-24' });
    expect(d.shownPeriodKeys).toEqual(['2026-09']);
    expect(d.watermark).toBe('preliminary');
    expect(d.periods[0].unclosed).toBe(true);
    expect(d.annotations.some((a) => a.kind === 'unclosed' && a.text === 'Sep 2026 is preliminary (soft close).')).toBe(true);
  });

  it('restated months carry the "restated on" annotation', () => {
    const c = company(A, { restatements: [{ id: 'x', year: 2026, month: 7, detectedAt: '2026-10-03T09:00:00Z', netIncomeDeltaCents: -1250_00, acknowledged: false }] });
    const d = evaluateGovernance({ view, facts: facts(c), audience: 'non_finance', today: '2026-10-24' });
    expect(d.periods.find((p) => p.key === '2026-07')?.restatedOn).toBe('2026-10-03');
    expect(d.footnote).toMatch(/Restated: Jul 2026 \(Oct 3, 2026\)/);
  });
});

describe('multi-company and consolidation groups', () => {
  it('a month is visible to non-finance only when EVERY in-group member is released', () => {
    const a = company(A, { releases: [released('2026-06'), released('2026-07'), released('2026-08')] });
    const b = company(B, { releases: [released('2026-06'), released('2026-07')] });
    const d = evaluateGovernance({ view: { periods: MONTHS, locationIds: [A, B], scopeKind: 'consolidated' }, facts: facts(a, b), audience: 'non_finance', today: '2026-10-24' });
    expect(d.shownPeriodKeys).toEqual(['2026-06', '2026-07']);
    expect(d.locationsByPeriod['2026-07']).toEqual([A, B]);
    expect(d.releasedThrough.scope).toBe('2026-07');
    expect(d.closedThrough.scope).toBe('2026-08');
  });

  it('months before "in group from" are excluded from consolidated views', () => {
    const a = company(A);
    const b = company(B, { coverage: { inGroupFrom: '2026-07-15', inGroupUntil: null } });
    const d = evaluateGovernance({ view: { periods: ['2026-06', '2026-07'], locationIds: [A, B], scopeKind: 'consolidated' }, facts: facts(a, b), audience: 'non_finance', today: '2026-10-24' });
    expect(d.locationsByPeriod['2026-06']).toEqual([A]);
    expect(d.locationsByPeriod['2026-07']).toEqual([A, B]);
    expect(d.annotations.find((x) => x.kind === 'pre_acquisition')?.text).toBe('Co B is shown from Jul 2026, when it joined the group.');
  });

  it('a month where no company is in the group is hidden (pre-acquisition)', () => {
    const b = company(B, { coverage: { inGroupFrom: '2026-08-01', inGroupUntil: null } });
    const d = evaluateGovernance({ view: { periods: ['2026-07'], locationIds: [B], scopeKind: 'consolidated' }, facts: facts(b), audience: 'finance', today: '2026-10-24' });
    expect(d.periods[0]).toMatchObject({ visibility: 'hidden', hiddenReason: 'pre_acquisition' });
  });

  it('pro forma (finance only) includes pre-acquisition months, annotated', () => {
    const a = company(A);
    const b = company(B, { coverage: { inGroupFrom: '2026-07-15', inGroupUntil: null } });
    const d = evaluateGovernance({ view: { periods: ['2026-06'], locationIds: [A, B], scopeKind: 'consolidated' }, facts: facts(a, b), audience: 'finance', options: { proForma: true }, today: '2026-10-24' });
    expect(d.locationsByPeriod['2026-06']).toEqual([A, B]);
    expect(d.periods[0].proForma).toBe(true);
    expect(d.annotations.some((x) => x.kind === 'pro_forma')).toBe(true);
  });

  it('a non-finance single-company view also hides pre-acquisition months; finance sees its own books', () => {
    const b = company(B, { coverage: { inGroupFrom: '2026-07-01', inGroupUntil: null } });
    const view = { periods: ['2026-06', '2026-07'], locationIds: [B], scopeKind: 'company' as const };
    expect(evaluateGovernance({ view, facts: facts(b), audience: 'non_finance', today: '2026-10-24' }).shownPeriodKeys).toEqual(['2026-07']);
    expect(evaluateGovernance({ view, facts: facts(b), audience: 'finance', today: '2026-10-24' }).shownPeriodKeys).toEqual(['2026-06', '2026-07']);
  });

  it('client scope: a company the caller cannot read never contributes', () => {
    const d = evaluateGovernance({ view: { periods: ['2026-06'], locationIds: [A, C], scopeKind: 'combined' }, facts: facts(company(A)), audience: 'finance', today: '2026-10-24' });
    expect(d.outOfScopeLocationIds).toEqual([C]);
    expect(d.locationsByPeriod['2026-06']).toEqual([A]);
    expect(d.periods[0].companies.find((x) => x.locationId === C)?.visibility).toBe('out_of_scope');
    const none = evaluateGovernance({ view: { periods: ['2026-06'], locationIds: [C], scopeKind: 'company' }, facts: facts(company(A)), audience: 'finance', today: '2026-10-24' });
    expect(none.periods[0]).toMatchObject({ visibility: 'hidden', hiddenReason: 'out_of_scope' });
    expect(none.shownPeriodKeys).toEqual([]);
  });
});

describe('applyGovernance (server entry point)', () => {
  const probe = (held: string[]): CapabilityProbe => ({ has: async (f, a) => held.includes(`${f}:${a}`) });
  const load = async () => facts(company(A));

  it('resolves the audience from capabilities — owner vs controller', async () => {
    expect((await resolveGovernanceAudience(probe([]))).audience).toBe('non_finance');
    const ctl = await resolveGovernanceAudience(probe(['close_mgmt:manage']));
    expect(ctl).toMatchObject({ audience: 'finance', canRelease: true });
    const bk = await resolveGovernanceAudience(probe(['journal_entries:create']));
    expect(bk).toMatchObject({ audience: 'finance', canRelease: false });
  });

  it('enforces in the API path: the owner never receives unreleased months, even asking for preview', async () => {
    const base = { supabase: {} as never, orgId: 'org', userId: 'u', now: new Date('2026-10-24T12:00:00Z') };
    const owner = await applyGovernance({ periods: MONTHS, locationIds: [A], scopeKind: 'company' }, { ...base, includePreview: true, deps: { probe: probe([]), loadFacts: load } });
    expect(owner.shownPeriodKeys).toEqual(['2026-06', '2026-07']);
    const ctl = await applyGovernance({ periods: MONTHS, locationIds: [A], scopeKind: 'company' }, { ...base, deps: { probe: probe(['close_mgmt:manage']), loadFacts: load } });
    expect(ctl.shownPeriodKeys).toEqual(MONTHS);
    expect(ctl.watermark).toBe('preview');
  });

  it('reuses an already-resolved audience and rejects malformed period keys', async () => {
    const base = { supabase: {} as never, orgId: 'org', userId: 'u', now: new Date('2026-10-24T12:00:00Z') };
    const d = await applyGovernance({ periods: ['2026-07'], locationIds: [A], scopeKind: 'company' }, { ...base, audience: ResolvedAudience.of('non_finance', false), deps: { loadFacts: load } });
    expect(d.audience).toBe('non_finance');
    await expect(applyGovernance({ periods: ['2026-7'], locationIds: [A], scopeKind: 'company' }, { ...base, deps: { probe: probe([]), loadFacts: load } })).rejects.toThrow(/invalid period key/);
  });

  it('an empty company list never widens to "every company"', async () => {
    let called = false;
    const d = await applyGovernance({ periods: ['2026-07'], locationIds: [], scopeKind: 'combined' }, {
      supabase: {} as never, orgId: 'org', userId: 'u', deps: { probe: probe(['close_mgmt:manage']), loadFacts: async () => { called = true; return facts(company(A)); } },
    });
    expect(called).toBe(false);
    expect(d.periods[0].hiddenReason).toBe('no_companies');
  });
});
