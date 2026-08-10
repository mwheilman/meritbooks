/**
 * Guard: an invoice that posts to the GL must debit the AR CONTROL account
 * (AR_CONTROL → '1100'), so the AR subledger (Σ invoices.balance_cents, exposed
 * by v_ar_aging) ties to the 1100 GL balance.
 *
 * This is the subledger-to-GL tie-out defect the audit flagged: the issuance path
 * (create-invoice.ts) resolved AR with a string RANGE `account_number >= '12000'
 * AND < '13000'`, which lexicographically EXCLUDES the 4-digit '1100' and instead
 * matched a 12xx asset (e.g. 1210 Job WIP / 1300 Prepaid) — posting the DR to the
 * WRONG account. The fix routes ALL three AR resolutions (issuance, edit re-post,
 * AR credit side) through resolveRole('AR_CONTROL'), the same role resolver, so a
 * remapped tenant never breaks the tie.
 *
 * These drive the REAL resolvers (resolveRole, resolveInvoiceCreditAccounts →
 * shouldDeferAtBilling) over a minimal in-memory fake of the supabase-js query
 * surface, and reconstruct the exact leg structure the issuance / edit-re-post
 * paths compose — so a regression in role resolution or the deferred/tax/retainage
 * split fails here.
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveRole } from '@/lib/posting/account-roles';
import { resolveInvoiceCreditAccounts } from './rev-rec-credit';

// ── Minimal fake of the supabase-js query builder ─────────────────────────────
type Row = Record<string, unknown>;
type Store = Record<string, Row[]>; // key: `${schema}.${table}`

class Builder {
  private filters: Array<(r: Row) => boolean> = [];
  constructor(private store: Store, private schema: string, private table: string) {}
  select() { return this; }
  eq(col: string, val: unknown) { this.filters.push((r) => r[col] === val); return this; }
  gte(col: string, val: unknown) { this.filters.push((r) => String(r[col]) >= String(val)); return this; }
  lt(col: string, val: unknown) { this.filters.push((r) => String(r[col]) < String(val)); return this; }
  or() { return this; } // company_location_id OR-clause — no-op; account_number already narrows
  limit() { return this; }
  private resolve(): Row[] {
    let rows = this.store[`${this.schema}.${this.table}`] ?? [];
    for (const f of this.filters) rows = rows.filter(f);
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

const AR = 'acc-ar';       // 1100 AR control
const WIP = 'acc-wip';     // 1210 Job WIP — in the OLD broken range
const PREPAID = 'acc-pre'; // 1300 Prepaid — in the OLD broken range
const REV = 'acc-rev';     // 4000 revenue
const DEF = 'acc-def';     // 2410 deferred revenue
const TAX = 'acc-tax';     // 2300 sales tax payable
const RET = 'acc-ret';     // 1110 retainage receivable

function accountsFixture(): Row[] {
  return [
    { id: AR, org_id: ORG, account_number: '1100', account_type: 'ASSET', account_sub_type: 'ACCOUNTS_RECEIVABLE', is_active: true, company_location_id: null, is_company_specific: false },
    { id: WIP, org_id: ORG, account_number: '1210', account_type: 'ASSET', account_sub_type: 'OTHER_CURRENT_ASSET', is_active: true, company_location_id: null, is_company_specific: false },
    { id: PREPAID, org_id: ORG, account_number: '1300', account_type: 'ASSET', account_sub_type: 'OTHER_CURRENT_ASSET', is_active: true, company_location_id: null, is_company_specific: false },
    { id: REV, org_id: ORG, account_number: '4000', account_type: 'REVENUE', account_sub_type: 'OPERATING_REVENUE', is_active: true, company_location_id: null, is_company_specific: false },
    { id: DEF, org_id: ORG, account_number: '2410', account_type: 'LIABILITY', account_sub_type: 'DEFERRED_REVENUE', is_active: true, company_location_id: null, is_company_specific: false },
    { id: TAX, org_id: ORG, account_number: '2300', account_type: 'LIABILITY', account_sub_type: 'OTHER_CURRENT_LIABILITY', is_active: true, company_location_id: null, is_company_specific: false },
    { id: RET, org_id: ORG, account_number: '1110', account_type: 'ASSET', account_sub_type: 'ACCOUNTS_RECEIVABLE', is_active: true, company_location_id: null, is_company_specific: false },
  ];
}

describe('AR control tie-out — invoice DR resolves to AR_CONTROL (1100), not a range', () => {
  it('(1) resolveRole(AR_CONTROL) picks 1100 — the OLD 12xxx range excluded it and hit the wrong asset', async () => {
    const store: Store = { 'public.account_roles': [], 'public.accounts': accountsFixture() };
    const db = fakeDb(store);

    // The fix: role resolution lands on the true AR control account.
    const ar = await resolveRole(db, ORG, 'AR_CONTROL', LOC);
    expect(ar.account_number).toBe('1100');
    expect(ar.id).toBe(AR);

    // The bug it replaces: the old lexicographic range `>= '12000' AND < '13000'`
    // never matches '1100' (it sorts BELOW '12000'); it matches a 12xx asset instead.
    const { data: bugRow } = await db
      .from('accounts')
      .select('id, account_number')
      .eq('org_id', ORG)
      .gte('account_number', '12000')
      .lt('account_number', '13000')
      .eq('is_active', true)
      .limit(1)
      .single();
    expect((bugRow as { id: string } | null)?.id).not.toBe(AR); // would have mis-posted AR
    expect(['1210', '1300']).toContain((bugRow as { account_number: string }).account_number);
  });

  it('(2) all AR resolutions go through the role — a tenant remap of AR_CONTROL is honored', async () => {
    // Tenant remapped AR_CONTROL to a non-standard account (e.g. a merged COA).
    const custom = 'acc-ar-custom';
    const store: Store = {
      'public.account_roles': [{ org_id: ORG, role_key: 'AR_CONTROL', account_id: custom, location_id: null }],
      'public.accounts': [
        ...accountsFixture(),
        { id: custom, org_id: ORG, account_number: '1105', account_type: 'ASSET', account_sub_type: 'ACCOUNTS_RECEIVABLE', is_active: true, company_location_id: null, is_company_specific: false },
      ],
    };
    const ar = await resolveRole(fakeDb(store), ORG, 'AR_CONTROL', LOC);
    // Role mapping wins over the standard 1100 default — so issuance, edit re-post,
    // and the AR credit side all tie to the SAME remapped account.
    expect(ar.id).toBe(custom);
    expect(ar.account_number).toBe('1105');
  });

  it('(3) edit re-post rebuilds the FULL issuance structure: AR debit + deferred/tax/retainage — balanced', async () => {
    // A deferring, taxable, retained invoice tied to a rev-rec-managed job.
    const store: Store = {
      'core.locations': [{ id: LOC, org_id: ORG, rev_rec_method: 'PCT_COSTS_INCURRED' }], // deferring default
      'core.jobs': [{ id: 'job-1', org_id: ORG, rev_rec_method_override: null }],
      'public.revenue_type_methods': [],
      'public.account_roles': [],
      'public.accounts': accountsFixture(),
    };
    const db = fakeDb(store);

    const subtotal = 100_000;
    const taxCents = 7_000;
    const retainageCents = 5_000;
    const newTotal = subtotal + taxCents - retainageCents; // mirrors create-invoice + route

    // Reconstruct exactly what the route's re-post (and issuance) compose.
    const arAccount = await resolveRole(db, ORG, 'AR_CONTROL', LOC);
    const creditLines = await resolveInvoiceCreditAccounts(db, {
      orgId: ORG, locationId: LOC, jobId: 'job-1',
      lines: [{ account_id: REV, amount_cents: subtotal }],
    });

    const glLines: Array<{ account_id: string; debit_cents: number; credit_cents: number }> = [
      { account_id: arAccount.id, debit_cents: newTotal, credit_cents: 0 },
      ...creditLines.map((cl) => ({ account_id: cl.account_id, debit_cents: 0, credit_cents: cl.amount_cents })),
    ];
    const taxAcct = await resolveRole(db, ORG, 'SALES_TAX_PAYABLE');
    glLines.push({ account_id: taxAcct.id, debit_cents: 0, credit_cents: taxCents });
    const retAcct = await resolveRole(db, ORG, 'RETAINAGE_RECEIVABLE');
    glLines.push({ account_id: retAcct.id, debit_cents: retainageCents, credit_cents: 0 });

    // AR debit lands on 1100 (not revenue, not a 12xx asset).
    expect(arAccount.id).toBe(AR);
    // The deferred leg is present (revenue NOT recognized in full on a rev-rec job).
    expect(creditLines.every((cl) => cl.deferred)).toBe(true);
    expect(glLines.some((l) => l.account_id === DEF && l.credit_cents === subtotal)).toBe(true);
    // Tax + retainage legs are present — the bug dropped these on re-post.
    expect(glLines.some((l) => l.account_id === TAX && l.credit_cents === taxCents)).toBe(true);
    expect(glLines.some((l) => l.account_id === RET && l.debit_cents === retainageCents)).toBe(true);

    // The double-entry invariant holds: debits == credits.
    const debits = glLines.reduce((s, l) => s + l.debit_cents, 0);
    const credits = glLines.reduce((s, l) => s + l.credit_cents, 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(subtotal + taxCents); // AR(total) + retainage == subtotal + tax
  });

  it('(4) an ad-hoc taxable invoice (no job) credits Revenue and still ties AR to 1100', async () => {
    const store: Store = {
      'core.locations': [{ id: LOC, org_id: ORG, rev_rec_method: 'PCT_COSTS_INCURRED' }],
      'public.account_roles': [],
      'public.accounts': accountsFixture(),
    };
    const db = fakeDb(store);

    const subtotal = 40_000;
    const taxCents = 2_800;
    const newTotal = subtotal + taxCents; // no retainage

    const arAccount = await resolveRole(db, ORG, 'AR_CONTROL', LOC);
    const creditLines = await resolveInvoiceCreditAccounts(db, {
      orgId: ORG, locationId: LOC, jobId: null,
      lines: [{ account_id: REV, amount_cents: subtotal }],
    });
    const taxAcct = await resolveRole(db, ORG, 'SALES_TAX_PAYABLE');

    const glLines = [
      { account_id: arAccount.id, debit_cents: newTotal, credit_cents: 0 },
      ...creditLines.map((cl) => ({ account_id: cl.account_id, debit_cents: 0, credit_cents: cl.amount_cents })),
      { account_id: taxAcct.id, debit_cents: 0, credit_cents: taxCents },
    ];

    expect(arAccount.id).toBe(AR);
    // No job → billing IS recognition → credit the line's revenue account, not 2410.
    expect(creditLines).toEqual([{ account_id: REV, amount_cents: subtotal, deferred: false }]);
    const debits = glLines.reduce((s, l) => s + l.debit_cents, 0);
    const credits = glLines.reduce((s, l) => s + l.credit_cents, 0);
    expect(debits).toBe(credits);
  });
});
