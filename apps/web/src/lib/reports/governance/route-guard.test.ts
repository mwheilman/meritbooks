import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { GovernanceDeniedError } from './filter';
import { monthEnd } from './periods';
import { governRoute, governRouteMonths, MAX_GUARD_MONTHS, rangeMonths, type RouteGuardContext } from './route-guard';
import { DEFAULT_RELEASE_SETTINGS, type CompanyFacts, type GovernanceFacts } from './types';

const A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const B = 'bbbbbbbb-0000-0000-0000-00000000000b';

function co(id: string, periodMonths: number[], releasedMonths: number[], over: Partial<CompanyFacts> = {}): CompanyFacts {
  return {
    locationId: id,
    name: id === A ? 'Alpha' : 'Beta',
    fiscalYearStartMonth: 1,
    periods: periodMonths.map((m) => ({ year: 2026, month: m, status: 'HARD_CLOSE', endDate: monthEnd(`2026-${String(m).padStart(2, '0')}`), closedAt: null, reopenReason: null })),
    releases: releasedMonths.map((m) => ({ id: `r${id}${m}`, year: 2026, month: m, status: 'RELEASED', mode: 'MANUAL', releasedAt: '2026-10-01T00:00:00Z', releasedBy: 'u', withdrawnAt: null, withdrawReason: null, baselineSnapshotId: null })),
    restatements: [],
    coverage: null,
    settings: DEFAULT_RELEASE_SETTINGS,
    ...over,
  };
}

const facts = (...cs: CompanyFacts[]): GovernanceFacts => ({ companies: Object.fromEntries(cs.map((c) => [c.locationId, c])), tenantSettings: DEFAULT_RELEASE_SETTINGS });

function ctx(f: GovernanceFacts, finance: boolean, extra: Partial<RouteGuardContext> = {}): RouteGuardContext {
  return {
    supabase: {} as SupabaseClient,
    orgId: 'org-1',
    userId: 'user-1',
    now: new Date('2026-10-24T12:00:00Z'),
    deps: {
      probe: { has: async () => finance },
      loadFacts: async (_s, _o, ids) => ({ ...f, companies: Object.fromEntries(Object.entries(f.companies).filter(([id]) => ids.includes(id))) }),
      listLocations: async () => Object.keys(f.companies),
    },
    ...extra,
  };
}

describe('rangeMonths', () => {
  it('spans months inclusively and refuses ranges past the cap', () => {
    expect(rangeMonths('2026-07-15', '2026-09-02')).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(rangeMonths('2026-09-01', '2026-07-01')).toEqual([]);
    expect(rangeMonths('1990-01-01', '2026-01-01')).toBeNull();
    expect(rangeMonths('bad', '2026-01-01')).toBeNull();
  });
});

describe('governRouteMonths — range', () => {
  const f = facts(co(A, [6, 7, 8, 9], [6, 7, 8]), co(B, [6, 7, 8, 9], [6, 7]));

  it('non-finance: a month is shown only when every included company is released', async () => {
    const g = await governRouteMonths(ctx(f, false), { months: ['2026-07', '2026-08', '2026-09'], locationIds: [A, B] });
    expect(g.finance).toBe(false);
    expect(g.shownMonths).toEqual(['2026-07']);
    expect(g.deniedMonths).toEqual(['2026-08', '2026-09']);
    expect(g.isShown('2026-08', A)).toBe(true);
    expect(g.isShown('2026-08', B)).toBe(false);
    expect(g.isShown('2026-08')).toBe(false);
    expect(g.isShown('2026-05')).toBe(false); // not requested
    expect(() => g.assertAllShown()).toThrow(GovernanceDeniedError);
    expect(g.info.withheldPeriods).toEqual(['2026-08', '2026-09']);
  });

  it('keepShown drops rows of hidden months and unattributable rows', async () => {
    const g = await governRouteMonths(ctx(f, false), { months: ['2026-07', '2026-08'], locationIds: [A, B] });
    const rows = [{ m: '2026-07' }, { m: '2026-08' }, { m: null }];
    expect(g.keepShown(rows, (r) => r.m)).toEqual([{ m: '2026-07' }]);
  });

  it('unscoped (empty locationIds) means every company in the org', async () => {
    const g = await governRouteMonths(ctx(f, false), { months: ['2026-08'], locationIds: [] });
    expect(g.locationIds.sort()).toEqual([A, B]);
    expect(g.shownMonths).toEqual([]);
  });

  it('finance passes through with preview info', async () => {
    const g = await governRouteMonths(ctx(f, true), { months: ['2026-08', '2026-09'], locationIds: [A, B] });
    expect(g.finance).toBe(true);
    expect(g.shownMonths).toEqual(['2026-08', '2026-09']);
    expect(() => g.assertAllShown()).not.toThrow();
    expect(g.info.watermark).toBe('preview');
    expect(g.info.banner).not.toBeNull();
  });

  it('no user → non-finance (fail closed)', async () => {
    const c = ctx(f, true, { userId: null });
    delete (c.deps as { probe?: unknown }).probe;
    const g = await governRouteMonths(c, { months: ['2026-08'], locationIds: [A] });
    expect(g.finance).toBe(false);
    expect(g.shownMonths).toEqual(['2026-08']);
    const g2 = await governRouteMonths(c, { months: ['2026-09'], locationIds: [A] });
    expect(g2.shownMonths).toEqual([]);
  });

  it('a company outside the caller scope denies the month', async () => {
    const g = await governRouteMonths(ctx(f, false), { months: ['2026-07'], locationIds: [A, 'cccccccc-0000-0000-0000-00000000000c'] });
    expect(g.shownMonths).toEqual([]);
  });

  it('a pre-acquisition (excluded) company denies the month for non-finance', async () => {
    const f2 = facts(co(A, [6, 7], [6, 7]), co(B, [6, 7], [6, 7], { coverage: { inGroupFrom: '2026-07-01', inGroupUntil: null } }));
    const g = await governRouteMonths(ctx(f2, false), { months: ['2026-06', '2026-07'], locationIds: [A, B], scopeKind: 'combined' });
    expect(g.shownMonths).toEqual(['2026-07']);
  });

  it('no org / no companies / too many months → everything denied', async () => {
    const f0 = facts();
    expect((await governRouteMonths(ctx(f, false, { orgId: null }), { months: ['2026-07'], locationIds: [A] })).shownMonths).toEqual([]);
    expect((await governRouteMonths(ctx(f0, false), { months: ['2026-07'], locationIds: [] })).shownMonths).toEqual([]);
    const many = Array.from({ length: MAX_GUARD_MONTHS + 1 }, (_, i) => `${String(2000 + Math.floor(i / 12))}-${String((i % 12) + 1).padStart(2, '0')}`);
    expect((await governRouteMonths(ctx(f, false), { months: many, locationIds: [A] })).shownMonths).toEqual([]);
  });
});

describe('governRouteMonths — cumulative (balance as of)', () => {
  it('requires every month from the first fiscal period through the as-of month', async () => {
    // A: Jun released, Jul WITHDRAWN-like (never released), Aug released on its own.
    const a = co(A, [6, 7, 8], [6, 8]);
    const g = await governRouteMonths(ctx(facts(a), false), { months: ['2026-08'], locationIds: [A], cumulative: true });
    expect(g.shownMonths).toEqual([]);
    const ok = await governRouteMonths(ctx(facts(co(A, [6, 7, 8], [6, 7, 8])), false), { months: ['2026-08'], locationIds: [A], cumulative: true });
    expect(ok.shownMonths).toEqual(['2026-08']);
  });

  it('a month before any fiscal period, or the unreleased as-of month, is denied', async () => {
    const a = co(A, [6, 7, 8], [6, 7, 8]);
    const g = await governRouteMonths(ctx(facts(a), false), { months: ['2026-09'], locationIds: [A], cumulative: true });
    expect(g.shownMonths).toEqual([]);
  });

  it('gaps with no fiscal period inside the history are skipped (nothing posted there)', async () => {
    const a = co(A, [3, 7, 8], [3, 7, 8]);
    const g = await governRouteMonths(ctx(facts(a), false), { months: ['2026-08'], locationIds: [A], cumulative: true });
    expect(g.shownMonths).toEqual(['2026-08']);
  });
});

describe('governRoute', () => {
  it('returns a 403 NOT_RELEASED response with the denied months', async () => {
    const f = facts(co(A, [7, 8], [7]));
    const res = await governRoute(ctx(f, false), { months: ['2026-07', '2026-08'], locationIds: [A] });
    expect(res).toBeInstanceOf(NextResponse);
    const r = res as NextResponse;
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.code).toBe('NOT_RELEASED');
    expect(body.periodKeys).toEqual(['2026-08']);
  });

  it('returns the governance when every month is shown', async () => {
    const f = facts(co(A, [7, 8], [7, 8]));
    const res = await governRoute(ctx(f, false), { months: ['2026-07', '2026-08'], locationIds: [A] });
    expect(res).not.toBeInstanceOf(NextResponse);
  });
});
