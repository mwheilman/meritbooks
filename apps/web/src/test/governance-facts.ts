/**
 * Test helpers for number-governance route tests: hand-built GovernanceFacts and a
 * chainable Supabase stand-in (every builder method returns itself; awaiting it — or
 * `.maybeSingle()` / `.single()` — resolves to the canned result).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { monthEnd } from '@/lib/reports/governance/periods';
import { DEFAULT_RELEASE_SETTINGS, type CompanyFacts, type GovernanceFacts } from '@/lib/reports/governance/types';

export const CO_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
export const CO_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

/** A company with HARD_CLOSE fiscal periods for `periodMonths` of `year`, released for `releasedMonths`. */
export function company(id: string, periodMonths: number[], releasedMonths: number[], year = 2026): CompanyFacts {
  const key = (m: number) => `${year}-${String(m).padStart(2, '0')}`;
  return {
    locationId: id,
    name: id === CO_A ? 'Alpha' : 'Beta',
    fiscalYearStartMonth: 1,
    periods: periodMonths.map((m) => ({ year, month: m, status: 'HARD_CLOSE', endDate: monthEnd(key(m)), closedAt: null, reopenReason: null })),
    releases: releasedMonths.map((m) => ({
      id: `r-${id}-${m}`,
      year,
      month: m,
      status: 'RELEASED',
      mode: 'MANUAL',
      releasedAt: `${year}-10-01T00:00:00Z`,
      releasedBy: 'u',
      withdrawnAt: null,
      withdrawReason: null,
      baselineSnapshotId: null,
    })),
    restatements: [],
    coverage: null,
    settings: DEFAULT_RELEASE_SETTINGS,
  };
}

export function facts(...cs: CompanyFacts[]): GovernanceFacts {
  return { companies: Object.fromEntries(cs.map((c) => [c.locationId, c])), tenantSettings: DEFAULT_RELEASE_SETTINGS };
}

/** Facts restricted to the requested companies (what loadGovernanceFacts returns). */
export function factsLoader(f: () => GovernanceFacts) {
  return async (_s: SupabaseClient, _o: string, ids: readonly string[]): Promise<GovernanceFacts> => {
    const all = f();
    return { ...all, companies: Object.fromEntries(Object.entries(all.companies).filter(([id]) => ids.includes(id))) };
  };
}

type Result = { data: unknown; error: null | { message: string } };

/** A Supabase client whose every query resolves to `pick(table)`. */
export function chainSupabase(pick: (table: string) => Result = () => ({ data: null, error: null })): SupabaseClient {
  const query = (table: string): unknown => {
    const result = pick(table);
    const q: Record<string, unknown> = {};
    const self = new Proxy(q, {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: Result) => unknown) => Promise.resolve(result).then(resolve);
        if (prop === 'maybeSingle' || prop === 'single') return async () => result;
        return () => self;
      },
    });
    return self;
  };
  const client = {
    from: (table: string) => query(table),
    schema: () => ({ from: (table: string) => query(table) }),
    rpc: async () => ({ data: null, error: null }),
  };
  return client as unknown as SupabaseClient;
}
