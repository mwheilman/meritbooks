/**
 * Guard: the event-driven JOB_BILLING → invoice/AR path (services/billing-consumer.ts)
 * must post through the SAME canonical rev-rec resolver as the manual-invoice path,
 * so both agree on defer-vs-recognize. This is the exact defect the rev-rec review
 * flagged: the consumer used to hand-roll `recognizeNow = revRec === 'POINT_OF_SALE'`
 * off the company default only — which (1) wrongly DEFERRED AS_BILLED, (2) ignored
 * per-job overrides / per-revenue-type mappings, and (3) resolved 2410 by number.
 *
 * These tests drive the REAL processBillingEvents (→ shouldDeferAtBilling →
 * resolveBillingRevRecMethod, and resolveRole for 2410, and postJournalEntry) over
 * a minimal in-memory fake of the supabase-js surface, then inspect the balanced GL
 * lines it produced. A regression in any of those links fails here.
 *
 *   (a) AS_BILLED  → recognize at billing → GL credits the REVENUE account
 *   (b) PCT_COSTS_INCURRED (a deferral method) → GL credits Deferred Revenue (2410)
 *   (c) a per-job override beats a conflicting company default
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { processBillingEvents } from './billing-consumer';

// ── Minimal fake of the supabase-js query builder ─────────────────────────────
// Supports the chain processBillingEvents + its resolvers use:
//   .schema().from().select()/insert()/update().eq()/.lte()/.gte()/.limit()/.order()
//   terminated by .single()/.maybeSingle() or an await (then), incl. head+count.
// insert/update mutate the store; inserts auto-assign a uuid id (+ entry_number for
// gl_entries) so downstream reads (invoice_id, gl_entry_id) behave like Postgres.
type Row = Record<string, unknown>;
type Store = Record<string, Row[]>; // key: `${schema}.${table}`

class Builder {
  private filters: { op: 'eq' | 'lte' | 'gte'; col: string; val: unknown }[] = [];
  private op: 'select' | 'insert' | 'update' = 'select';
  private payload: Row[] = [];
  private updates: Row = {};
  private head = false;
  constructor(private store: Store, private schema: string, private table: string) {}

  private key() { return `${this.schema}.${this.table}`; }

  select(_cols?: string, opts?: { count?: string; head?: boolean }) { if (opts?.head) this.head = true; return this; }
  insert(rows: Row | Row[]) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  update(vals: Row) { this.op = 'update'; this.updates = vals; return this; }
  eq(col: string, val: unknown) { this.filters.push({ op: 'eq', col, val }); return this; }
  lte(col: string, val: unknown) { this.filters.push({ op: 'lte', col, val }); return this; }
  gte(col: string, val: unknown) { this.filters.push({ op: 'gte', col, val }); return this; }
  or() { return this; }
  limit() { return this; }
  order() { return this; }

  private match(): Row[] {
    let rows = this.store[this.key()] ?? [];
    for (const f of this.filters) {
      rows = rows.filter((r) => {
        const v = r[f.col];
        if (f.op === 'eq') return v === f.val;
        if (f.op === 'lte') return (v as string) <= (f.val as string);
        return (v as string) >= (f.val as string);
      });
    }
    return rows;
  }

  /** Execute the pending op, mutating the store for insert/update. */
  private run(): Row[] {
    if (this.op === 'insert') {
      const bucket = (this.store[this.key()] ??= []);
      const inserted = this.payload.map((r) => {
        const row: Row = { ...r };
        if (row.id === undefined) row.id = randomUUID();
        if (this.table === 'gl_entries' && row.entry_number === undefined) row.entry_number = `JE-${bucket.length + 1}`;
        bucket.push(row);
        return row;
      });
      return inserted;
    }
    if (this.op === 'update') {
      const rows = this.match();
      for (const r of rows) Object.assign(r, this.updates);
      return rows;
    }
    return this.match();
  }

  single() { const r = this.run(); return Promise.resolve({ data: r[0] ?? null, error: r[0] ? null : { message: 'no rows' } }); }
  maybeSingle() { const r = this.run(); return Promise.resolve({ data: r[0] ?? null, error: null }); }
  then<T>(onF: (v: { data: Row[] | null; error: null; count?: number }) => T) {
    if (this.head) return Promise.resolve({ data: null, error: null as null, count: this.match().length }).then(onF);
    return Promise.resolve({ data: this.run(), error: null as null }).then(onF);
  }
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
const CUST = 'cust-1';
const JOB = 'job-1';
const AR = 'acc-ar';
const REV = 'acc-rev';
const DEF = 'acc-def';
const AMOUNT = 100_000;

/**
 * Build a store with one pending JOB_BILLING event.
 * @param locMethod  the company default rev-rec method (core.locations)
 * @param jobOverride the per-job override (core.jobs.rev_rec_method_override), or null
 */
function store(locMethod: string, jobOverride: string | null): Store {
  return {
    'core.events': [{
      id: 'ev-row-1', org_id: ORG, event_id: 'evt-1', event_type: 'JOB_BILLING',
      status: 'pending', created_at: '2026-06-15T00:00:00Z', occurred_on: '2026-06-15',
      payload: {
        event_id: 'evt-1', job_id: JOB, location_id: LOC, billing_type: 'PROGRESS',
        occurred_on: '2026-06-15', source_ref: 'ref-1', memo: null,
        lines: [{ description: 'Framing', amount_cents: AMOUNT, item_id: null }],
      },
    }],
    'core.locations': [{ id: LOC, org_id: ORG, short_code: 'ABC', rev_rec_method: locMethod }],
    'core.jobs': [{ id: JOB, org_id: ORG, customer_id: CUST, rev_rec_method_override: jobOverride }],
    'public.fiscal_periods': [{ id: 'fp-1', org_id: ORG, location_id: LOC, start_date: '2026-01-01', end_date: '2026-12-31', status: 'OPEN' }],
    'public.revenue_type_methods': [],
    'public.account_roles': [],
    'public.accounts': [
      { id: AR, org_id: ORG, account_number: '1100', name: 'Accounts Receivable', account_type: 'ASSET', account_sub_type: 'AR', is_active: true, company_location_id: null },
      { id: REV, org_id: ORG, account_number: '4000', name: 'Service Revenue', account_type: 'REVENUE', account_sub_type: 'OPERATING_REVENUE', is_active: true, company_location_id: null },
      { id: DEF, org_id: ORG, account_number: '2410', name: 'Deferred Revenue', account_type: 'LIABILITY', account_sub_type: 'DEFERRED_REVENUE', is_active: true, company_location_id: null },
    ],
    'public.invoices': [],
    'public.invoice_lines': [],
    'public.gl_entries': [],
    'public.gl_entry_lines': [],
  };
}

/** Pull the DR (AR) and CR (revenue|deferred) lines the consumer posted. */
function glLines(s: Store) {
  const lines = s['public.gl_entry_lines'] ?? [];
  const debit = lines.find((l) => Number(l.debit_cents) > 0);
  const credit = lines.find((l) => Number(l.credit_cents) > 0);
  return { debit, credit, count: lines.length };
}

describe('billing-consumer — rev-rec routing parity with the manual path', () => {
  it('(a) AS_BILLED recognizes at billing → GL credits Revenue (not deferred)', async () => {
    const s = store('AS_BILLED', null);
    const res = await processBillingEvents(fakeDb(s), ORG);

    expect(res).toMatchObject({ processed: 1, rejected: 0 });
    const { debit, credit, count } = glLines(s);
    expect(count).toBe(2);
    // DR AR for the full billed amount.
    expect(debit).toMatchObject({ account_id: AR, debit_cents: AMOUNT, credit_cents: 0, job_id: JOB });
    // CR Revenue — the defect was that the old code DEFERRED AS_BILLED.
    expect(credit).toMatchObject({ account_id: REV, credit_cents: AMOUNT, debit_cents: 0, job_id: JOB });
    expect(credit?.account_id).not.toBe(DEF);
    // Balanced.
    expect(Number(debit?.debit_cents)).toBe(Number(credit?.credit_cents));
    // Invoice line references the revenue account, not the deferred liability.
    expect(s['public.invoice_lines'][0]).toMatchObject({ account_id: REV });
  });

  it('(b) a deferral method (PCT_COSTS_INCURRED) → GL credits Deferred Revenue (2410)', async () => {
    const s = store('PCT_COSTS_INCURRED', null);
    const res = await processBillingEvents(fakeDb(s), ORG);

    expect(res).toMatchObject({ processed: 1, rejected: 0 });
    const { debit, credit } = glLines(s);
    expect(debit).toMatchObject({ account_id: AR, debit_cents: AMOUNT });
    // CR Deferred Revenue (2410, resolved by ROLE — no hard-coded number).
    expect(credit).toMatchObject({ account_id: DEF, credit_cents: AMOUNT });
    expect(credit?.account_id).not.toBe(REV);
    expect(Number(debit?.debit_cents)).toBe(Number(credit?.credit_cents));
  });

  it('(c) a per-job override beats the company default', async () => {
    // Company defaults to a DEFERRAL method, but this job is overridden to recognize
    // at billing. The override must win → credit Revenue, not Deferred Revenue.
    const s = store('PCT_COSTS_INCURRED', 'POINT_OF_SALE');
    const res = await processBillingEvents(fakeDb(s), ORG);

    expect(res).toMatchObject({ processed: 1, rejected: 0 });
    const { credit } = glLines(s);
    expect(credit).toMatchObject({ account_id: REV, credit_cents: AMOUNT });
    expect(credit?.account_id).not.toBe(DEF);
  });
});

// ── Per-event org resolution (gate #9 / cross-tenant posting) ──────────────────
// The drain must post each event under ITS OWN org_id (FROZEN v3: every core.events
// row carries org_id), never a single pinned "first org". Regression here would be
// a cross-tenant leak: one tenant's billing posting into another tenant's ledger.
describe('billing-consumer — per-event org resolution (no cross-tenant posting)', () => {
  /** All rows a single org needs for one pending AS_BILLED JOB_BILLING event. */
  function orgFixture(o: {
    org: string; loc: string; cust: string; job: string; ar: string; rev: string; def: string;
    shortCode: string; eventRowId: string; eventId: string;
  }): Store {
    return {
      'core.events': [{
        id: o.eventRowId, org_id: o.org, event_id: o.eventId, event_type: 'JOB_BILLING',
        status: 'pending', created_at: '2026-06-15T00:00:00Z', occurred_on: '2026-06-15',
        payload: {
          event_id: o.eventId, job_id: o.job, location_id: o.loc, billing_type: 'PROGRESS',
          occurred_on: '2026-06-15', source_ref: `ref-${o.org}`, memo: null,
          lines: [{ description: 'Framing', amount_cents: AMOUNT, item_id: null }],
        },
      }],
      'core.locations': [{ id: o.loc, org_id: o.org, short_code: o.shortCode, rev_rec_method: 'AS_BILLED' }],
      'core.jobs': [{ id: o.job, org_id: o.org, customer_id: o.cust, rev_rec_method_override: null }],
      'public.fiscal_periods': [{ id: `fp-${o.org}`, org_id: o.org, location_id: o.loc, start_date: '2026-01-01', end_date: '2026-12-31', status: 'OPEN' }],
      'public.revenue_type_methods': [],
      'public.account_roles': [],
      'public.accounts': [
        { id: o.ar, org_id: o.org, account_number: '1100', name: 'Accounts Receivable', account_type: 'ASSET', account_sub_type: 'AR', is_active: true, company_location_id: null },
        { id: o.rev, org_id: o.org, account_number: '4000', name: 'Service Revenue', account_type: 'REVENUE', account_sub_type: 'OPERATING_REVENUE', is_active: true, company_location_id: null },
        { id: o.def, org_id: o.org, account_number: '2410', name: 'Deferred Revenue', account_type: 'LIABILITY', account_sub_type: 'DEFERRED_REVENUE', is_active: true, company_location_id: null },
      ],
      'public.invoices': [],
      'public.invoice_lines': [],
      'public.gl_entries': [],
      'public.gl_entry_lines': [],
    };
  }

  /** Merge two per-org fixtures into one store (arrays concatenated per table). */
  function mergeStores(a: Store, b: Store): Store {
    const out: Store = {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      out[key] = [...(a[key] ?? []), ...(b[key] ?? [])];
    }
    return out;
  }

  it('drains two tenants in one pass and books each event under its OWN org', async () => {
    const A = { org: 'org-A', loc: 'loc-A', cust: 'cust-A', job: 'job-A', ar: 'ar-A', rev: 'rev-A', def: 'def-A', shortCode: 'AAA', eventRowId: 'ev-A', eventId: 'evt-A' };
    const B = { org: 'org-B', loc: 'loc-B', cust: 'cust-B', job: 'job-B', ar: 'ar-B', rev: 'rev-B', def: 'def-B', shortCode: 'BBB', eventRowId: 'ev-B', eventId: 'evt-B' };
    const s = mergeStores(orgFixture(A), orgFixture(B));

    // No org argument → drain ALL tenants; per-event org_id drives every write.
    const res = await processBillingEvents(fakeDb(s));
    expect(res).toMatchObject({ processed: 2, rejected: 0 });

    // Each invoice carries its own org and short_code — never the other tenant's.
    const invA = s['public.invoices'].find((i) => i.org_id === A.org);
    const invB = s['public.invoices'].find((i) => i.org_id === B.org);
    expect(invA).toBeTruthy();
    expect(invB).toBeTruthy();
    expect(String(invA?.invoice_number)).toContain('AAA');
    expect(String(invB?.invoice_number)).toContain('BBB');

    // GL posts under the correct org: org-B's credit hits org-B's revenue account,
    // NOT org-A's. A first-org pin would have posted B's event into A's ledger.
    const bLines = s['public.gl_entry_lines'].filter((l) => l.org_id === B.org);
    const bCredit = bLines.find((l) => Number(l.credit_cents) > 0);
    const bDebit = bLines.find((l) => Number(l.debit_cents) > 0);
    expect(bCredit).toMatchObject({ account_id: B.rev, credit_cents: AMOUNT });
    expect(bDebit).toMatchObject({ account_id: B.ar, debit_cents: AMOUNT });
    // And nothing from org-B leaked account references belonging to org-A.
    expect(bLines.some((l) => l.account_id === A.ar || l.account_id === A.rev)).toBe(false);

    // Both events flipped to processed, scoped to their own row (idempotency intact).
    expect(s['core.events'].find((e) => e.id === A.eventRowId)?.status).toBe('processed');
    expect(s['core.events'].find((e) => e.id === B.eventRowId)?.status).toBe('processed');
  });
});
