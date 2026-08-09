/**
 * Close open-items detector — attribution / bucketing proof over a MOCK Supabase.
 *
 * The reads themselves are RLS-scoped by the DB; what this file pins is the PURE JS
 * attribution the scan does on top of them:
 *   • unposted drafts mapped period → location,
 *   • bills-on-hold bounded by bill_date ≤ period end (a bill dated after period end
 *     is NOT counted),
 *   • unapplied customer payments = amount − Σ(applications), attributed via the
 *     receiving bank account, counted only when the remainder is > 0,
 *   • pending-approval JEs (by period) + bills (by location + date) folded into one
 *     pendingApproval count,
 *   • every requested location present in the result (zeroed when it has nothing),
 *   • empty-context short-circuit, and the single-entity convenience wrapper.
 *
 * The mock ignores server-side filters (the DB would apply them) and returns fixtures
 * per table; gl_entries / bills are queried twice with different shapes, disambiguated
 * by whether an `id` IN-filter was applied. No real database is touched.
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  gatherOpenItemsByLocation,
  gatherEntityOpenItems,
  emptyOpenItems,
  type LocationCloseContext,
} from './open-items';

interface RecordedQuery {
  table: string;
  filters: Array<{ op: 'in' | 'eq' | 'neq'; col: string }>;
}

/** Minimal thenable query-builder mock; `resolve` returns rows for a recorded query. */
function makeClient(resolve: (q: RecordedQuery) => unknown[]): SupabaseClient {
  const from = (table: string) => {
    const q: RecordedQuery = { table, filters: [] };
    const builder: Record<string, unknown> = {
      select: () => builder,
      limit: () => builder,
      in: (col: string) => {
        q.filters.push({ op: 'in', col });
        return builder;
      },
      eq: (col: string) => {
        q.filters.push({ op: 'eq', col });
        return builder;
      },
      neq: (col: string) => {
        q.filters.push({ op: 'neq', col });
        return builder;
      },
      then: (onF: (v: { data: unknown[]; error: null }) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve({ data: resolve(q), error: null }).then(onF, onR),
    };
    return builder;
  };
  return { from } as unknown as SupabaseClient;
}

const hasIdFilter = (q: RecordedQuery) => q.filters.some((f) => f.col === 'id' && f.op === 'in');

const CONTEXTS: LocationCloseContext[] = [
  { locationId: 'LOC_A', periodId: 'P_A', periodEndISO: '2026-08-31' },
  { locationId: 'LOC_B', periodId: 'P_B', periodEndISO: '2026-08-31' },
  { locationId: 'LOC_C', periodId: null, periodEndISO: null }, // no period → zeroed but present
];

const resolver = (q: RecordedQuery): unknown[] => {
  switch (q.table) {
    case 'gl_entries':
      // Second use (pending-approval JEs) filters by `id`; first use lists drafts.
      return hasIdFilter(q)
        ? [{ id: 'je1', location_id: null, fiscal_period_id: 'P_A' }]
        : [
            { fiscal_period_id: 'P_A' },
            { fiscal_period_id: 'P_A' },
            { fiscal_period_id: 'P_B' },
            { fiscal_period_id: 'P_UNKNOWN' }, // no context → ignored
          ];
    case 'bills':
      // Second use (pending-approval bills) filters by `id`; first use lists ON_HOLD.
      return hasIdFilter(q)
        ? [{ id: 'b_appr', location_id: 'LOC_B', bill_date: '2026-08-10' }]
        : [
            { id: 'bh1', location_id: 'LOC_A', bill_date: '2026-08-05' }, // within period
            { id: 'bh2', location_id: 'LOC_A', bill_date: '2026-09-15' }, // AFTER period end → excluded
            { id: 'bh3', location_id: 'LOC_B', bill_date: '2026-08-20' },
          ];
    case 'bank_accounts':
      return [
        { id: 'acct1', location_id: 'LOC_A' },
        { id: 'acct2', location_id: 'LOC_B' },
      ];
    case 'customer_payments':
      return [
        { id: 'pay1', amount_cents: 10000, bank_account_id: 'acct1' }, // fully applied → not open
        { id: 'pay2', amount_cents: 5000, bank_account_id: 'acct1' }, // partially applied → 3000 open
        { id: 'pay3', amount_cents: 8000, bank_account_id: 'acct2' }, // no applications → 8000 open
      ];
    case 'payment_applications':
      return [
        { payment_id: 'pay1', amount_cents: 10000 },
        { payment_id: 'pay2', amount_cents: 2000 },
      ];
    case 'approval_requests':
      return [
        { doc_type: 'JOURNAL_ENTRY', doc_id: 'je1' },
        { doc_type: 'BILL', doc_id: 'b_appr' },
      ];
    default:
      return [];
  }
};

describe('emptyOpenItems', () => {
  it('is a fully zeroed counts object', () => {
    expect(emptyOpenItems()).toEqual({
      unpostedDraftCount: 0,
      billsOnHoldCount: 0,
      unappliedPaymentCount: 0,
      unappliedPaymentCents: 0,
      pendingApprovalCount: 0,
    });
  });
});

describe('gatherOpenItemsByLocation — attribution', () => {
  it('returns a zeroed entry for every requested location even with no data', async () => {
    const empty = makeClient(() => []);
    const map = await gatherOpenItemsByLocation(empty, CONTEXTS);
    expect([...map.keys()].sort()).toEqual(['LOC_A', 'LOC_B', 'LOC_C']);
    for (const loc of ['LOC_A', 'LOC_B', 'LOC_C']) {
      expect(map.get(loc)).toEqual(emptyOpenItems());
    }
  });

  it('short-circuits to an empty map for empty contexts (no queries run)', async () => {
    let called = false;
    const spy = makeClient(() => {
      called = true;
      return [];
    });
    const map = await gatherOpenItemsByLocation(spy, []);
    expect(map.size).toBe(0);
    expect(called).toBe(false);
  });

  it('tallies drafts, on-hold bills (date-bounded), unapplied payments, and pending approvals per location', async () => {
    const map = await gatherOpenItemsByLocation(makeClient(resolver), CONTEXTS);

    const a = map.get('LOC_A')!;
    expect(a.unpostedDraftCount).toBe(2); // two P_A drafts (P_UNKNOWN ignored)
    expect(a.billsOnHoldCount).toBe(1); // bh1 within; bh2 (post period-end) excluded
    expect(a.unappliedPaymentCount).toBe(1); // pay2 only (pay1 fully applied)
    expect(a.unappliedPaymentCents).toBe(3000); // 5000 − 2000
    expect(a.pendingApprovalCount).toBe(1); // je1 → P_A

    const b = map.get('LOC_B')!;
    expect(b.unpostedDraftCount).toBe(1); // one P_B draft
    expect(b.billsOnHoldCount).toBe(1); // bh3
    expect(b.unappliedPaymentCount).toBe(1); // pay3
    expect(b.unappliedPaymentCents).toBe(8000);
    expect(b.pendingApprovalCount).toBe(1); // b_appr → LOC_B

    // LOC_C has a null period and no attributed rows → stays fully zeroed.
    expect(map.get('LOC_C')).toEqual(emptyOpenItems());
  });

  it('excludes a fully-applied payment from the unapplied tally (remainder must be > 0)', async () => {
    // Only pay1, fully applied → no location should record an unapplied payment.
    const client = makeClient((q) => {
      if (q.table === 'bank_accounts') return [{ id: 'acct1', location_id: 'LOC_A' }];
      if (q.table === 'customer_payments') return [{ id: 'pay1', amount_cents: 10000, bank_account_id: 'acct1' }];
      if (q.table === 'payment_applications') return [{ payment_id: 'pay1', amount_cents: 10000 }];
      return [];
    });
    const map = await gatherOpenItemsByLocation(client, CONTEXTS);
    expect(map.get('LOC_A')!.unappliedPaymentCount).toBe(0);
    expect(map.get('LOC_A')!.unappliedPaymentCents).toBe(0);
  });
});

describe('gatherEntityOpenItems — single-entity wrapper', () => {
  it('returns just the requested entity’s counts', async () => {
    const counts = await gatherEntityOpenItems(makeClient(resolver), CONTEXTS[0]);
    expect(counts.unpostedDraftCount).toBe(2);
    expect(counts.billsOnHoldCount).toBe(1);
    expect(counts.unappliedPaymentCents).toBe(3000);
    expect(counts.pendingApprovalCount).toBe(1);
  });

  it('degrades to zeroed counts for a location the scan returns nothing for', async () => {
    const counts = await gatherEntityOpenItems(makeClient(() => []), CONTEXTS[2]);
    expect(counts).toEqual(emptyOpenItems());
  });
});
