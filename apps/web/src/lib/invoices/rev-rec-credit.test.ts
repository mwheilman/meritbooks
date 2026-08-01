/**
 * Guard: a manual invoice tied to a rev-rec-managed job must credit Deferred
 * Revenue (2410), NOT Revenue — the rev-rec engine earns it out later. Only
 * POINT_OF_SALE / AS_BILLED and ad-hoc (no-job) invoices credit Revenue at
 * billing. This is the exact defect the Invoice FPB audit flagged in
 * api/invoices/route.ts (it credited Revenue unconditionally).
 *
 * The test drives the REAL resolver chain (resolveInvoiceCreditAccounts →
 * shouldDeferAtBilling → resolveBillingRevRecMethod, and resolveRole for 2410)
 * over a minimal in-memory fake of the supabase-js query surface, so a
 * regression in any of those links fails here.
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveInvoiceCreditAccounts } from './rev-rec-credit';

// ── Minimal fake of the supabase-js query builder ─────────────────────────────
// Supports the chain the resolver uses: .schema().from().select().eq().limit()
// .maybeSingle()/.single(), plus awaiting the builder directly (array result).
type Row = Record<string, unknown>;
type Store = Record<string, Row[]>; // key: `${schema}.${table}`

class Builder {
  private filters: [string, unknown][] = [];
  constructor(private store: Store, private schema: string, private table: string) {}
  select() { return this; }
  eq(col: string, val: unknown) { this.filters.push([col, val]); return this; }
  limit() { return this; }
  private resolve(): Row[] {
    let rows = this.store[`${this.schema}.${this.table}`] ?? [];
    for (const [col, val] of this.filters) rows = rows.filter((r) => r[col] === val);
    return rows;
  }
  maybeSingle() { const r = this.resolve(); return Promise.resolve({ data: r[0] ?? null, error: null }); }
  single() { const r = this.resolve(); return Promise.resolve({ data: r[0] ?? null, error: r[0] ? null : { message: 'no rows' } }); }
  then<T>(onF: (v: { data: Row[]; error: null }) => T) { return Promise.resolve({ data: this.resolve(), error: null as null }).then(onF); }
}

function fakeDb(store: Store): SupabaseClient {
  const db = {
    schema: (s: string) => ({ from: (t: string) => new Builder(store, s, t) }),
    from: (t: string) => new Builder(store, 'public', t),
  };
  return db as unknown as SupabaseClient;
}

const ORG = 'org-1';
const LOC = 'loc-1';
const REV = 'acc-rev'; // the revenue account the user picked on the line
const DEF = 'acc-def'; // the tenant's Deferred Revenue (2410) account

/** Base fixtures shared by the cases; `locMethod` sets the company default. */
function store(locMethod: string, jobs: Row[], revTypeMethods: Row[] = []): Store {
  return {
    'core.locations': [{ id: LOC, org_id: ORG, rev_rec_method: locMethod }],
    'core.jobs': jobs,
    'public.revenue_type_methods': revTypeMethods,
    'public.account_roles': [], // unmapped → resolveRole falls back to number 2410
    'public.accounts': [
      { id: REV, org_id: ORG, account_number: '4000', account_type: 'REVENUE', account_sub_type: 'OPERATING_REVENUE', is_active: true, company_location_id: null },
      { id: DEF, org_id: ORG, account_number: '2410', account_type: 'LIABILITY', account_sub_type: 'DEFERRED_REVENUE', is_active: true, company_location_id: null },
    ],
  };
}

describe('invoice credit routing — rev-rec deferral', () => {
  it('(a) a rev-rec-managed job invoice credits Deferred Revenue (2410), not Revenue', async () => {
    // Company default is a deferral method; job has no override; no per-type map.
    const db = fakeDb(store('PCT_COSTS_INCURRED', [{ id: 'job-defer', org_id: ORG, rev_rec_method_override: null }]));

    const credits = await resolveInvoiceCreditAccounts(db, {
      orgId: ORG, locationId: LOC, jobId: 'job-defer',
      lines: [{ account_id: REV, amount_cents: 100_000 }],
    });

    expect(credits).toEqual([{ account_id: DEF, amount_cents: 100_000, deferred: true }]);
    expect(credits[0].account_id).not.toBe(REV); // did NOT credit Revenue
  });

  it('(b) a POINT_OF_SALE job invoice credits Revenue directly', async () => {
    const db = fakeDb(store('PCT_COSTS_INCURRED', [{ id: 'job-pos', org_id: ORG, rev_rec_method_override: 'POINT_OF_SALE' }]));

    const credits = await resolveInvoiceCreditAccounts(db, {
      orgId: ORG, locationId: LOC, jobId: 'job-pos',
      lines: [{ account_id: REV, amount_cents: 100_000 }],
    });

    expect(credits).toEqual([{ account_id: REV, amount_cents: 100_000, deferred: false }]);
  });

  it('(b) an ad-hoc (no-job) invoice credits Revenue directly', async () => {
    const db = fakeDb(store('PCT_COSTS_INCURRED', []));

    const credits = await resolveInvoiceCreditAccounts(db, {
      orgId: ORG, locationId: LOC, jobId: null,
      lines: [{ account_id: REV, amount_cents: 50_000 }],
    });

    expect(credits).toEqual([{ account_id: REV, amount_cents: 50_000, deferred: false }]);
  });

  it('per-revenue-type method overrides a deferring company default (POS wins → Revenue)', async () => {
    // Company defaults to defer, but this revenue account is mapped POINT_OF_SALE.
    const db = fakeDb(store(
      'PCT_COSTS_INCURRED',
      [{ id: 'job-x', org_id: ORG, rev_rec_method_override: null }],
      [{ org_id: ORG, location_id: LOC, revenue_account_id: REV, method: 'POINT_OF_SALE' }],
    ));

    const credits = await resolveInvoiceCreditAccounts(db, {
      orgId: ORG, locationId: LOC, jobId: 'job-x',
      lines: [{ account_id: REV, amount_cents: 100_000 }],
    });

    expect(credits[0]).toEqual({ account_id: REV, amount_cents: 100_000, deferred: false });
  });
});
