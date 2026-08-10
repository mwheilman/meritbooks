import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SandboxOriginationProvider, SANDBOX_DEFAULT_RETURN_CODE } from './sandbox';
import type { OriginationProvider } from './provider';
import {
  summarizeLines,
  parseBillPaymentId,
  foldBatchStatus,
  submitOriginationBatch,
} from './service';

describe('summarizeLines — batch build totals/count (bigint cents)', () => {
  it('sums the total and counts items', () => {
    const s = summarizeLines([{ amountCents: 1000 }, { amountCents: 250 }, { amountCents: 99 }]);
    expect(s.itemCount).toBe(3);
    expect(s.totalCents).toBe(1349);
  });

  it('throws on a non-positive amount (money invariant, mirrors the items CHECK)', () => {
    expect(() => summarizeLines([{ amountCents: 1000 }, { amountCents: 0 }])).toThrow(/non-positive/);
    expect(() => summarizeLines([{ amountCents: -5 }])).toThrow(/non-positive/);
  });
});

describe('parseBillPaymentId — link the posted bill payment', () => {
  it('extracts the bill_payments id from the release correlation id', () => {
    expect(parseBillPaymentId('bill_payment:2f1c9b0e-1111-4a2b-9c3d-abcdef012345')).toBe(
      '2f1c9b0e-1111-4a2b-9c3d-abcdef012345',
    );
  });
  it('handles the check-annotated correlation id', () => {
    expect(parseBillPaymentId('bill_payment:abc12345-6789-4def-8123-456789abcdef|check:1042')).toBe(
      'abc12345-6789-4def-8123-456789abcdef',
    );
  });
  it('returns null when absent', () => {
    expect(parseBillPaymentId(null)).toBeNull();
    expect(parseBillPaymentId('unrelated')).toBeNull();
  });
});

describe('foldBatchStatus — status transition rollup', () => {
  it('all SETTLED → SETTLED', () => {
    expect(foldBatchStatus(['SETTLED', 'SETTLED'])).toBe('SETTLED');
  });
  it('any RETURNED dominates → RETURNED', () => {
    expect(foldBatchStatus(['SETTLED', 'RETURNED', 'SETTLED'])).toBe('RETURNED');
  });
  it('any FAILED (no returns) → FAILED', () => {
    expect(foldBatchStatus(['SETTLED', 'FAILED'])).toBe('FAILED');
  });
  it('still in flight → SUBMITTED', () => {
    expect(foldBatchStatus(['SUBMITTED', 'SETTLED'])).toBe('SUBMITTED');
    expect(foldBatchStatus([])).toBe('SUBMITTED');
  });
});

describe('SandboxOriginationProvider — interface conformance + deterministic lifecycle', () => {
  const provider = new SandboxOriginationProvider();

  it('conforms to the OriginationProvider interface', () => {
    const p: OriginationProvider = provider; // compile-time conformance
    expect(p.name).toBe('SANDBOX');
    expect(p.rails).toEqual(['ACH', 'WIRE']);
    expect(p.isConfigured()).toBe(true);
    expect(typeof p.submitBatch).toBe('function');
    expect(typeof p.getStatus).toBe('function');
  });

  it('submitBatch returns a deterministic ref and marks every line SUBMITTED', async () => {
    const res = await provider.submitBatch({
      batchId: 'batch-1',
      rail: 'ACH',
      effectiveDate: '2026-08-15',
      lines: [
        { itemId: 'i1', amountCents: 500, vendorId: 'v1' },
        { itemId: 'i2', amountCents: 700, vendorId: 'v2' },
      ],
    });
    expect(res.providerBatchRef).toBe('sbx_batch_batch-1');
    expect(res.status).toBe('SUBMITTED');
    expect(res.items.map((i) => i.status)).toEqual(['SUBMITTED', 'SUBMITTED']);
    expect(res.trace.adapter).toBe('SANDBOX');
    // determinism: same input → same ref
    const again = await provider.submitBatch({ batchId: 'batch-1', rail: 'ACH', effectiveDate: null, lines: [] });
    expect(again.providerBatchRef).toBe('sbx_batch_batch-1');
  });

  it('getStatus settles by default', async () => {
    const res = await provider.getStatus({
      providerBatchRef: 'sbx_batch_batch-1',
      lines: [{ itemId: 'i1', amountCents: 500, vendorId: 'v1' }],
    });
    expect(res.status).toBe('SETTLED');
    expect(res.items[0].status).toBe('SETTLED');
  });

  it('getStatus honors a simulated RETURN with its ACH return code', async () => {
    const res = await provider.getStatus({
      providerBatchRef: 'sbx_batch_batch-1',
      lines: [
        { itemId: 'i1', amountCents: 500, vendorId: 'v1' },
        { itemId: 'i2', amountCents: 700, vendorId: 'v2' },
      ],
      simulate: { returns: [{ itemId: 'i2', returnCode: 'R02' }] },
    });
    expect(res.status).toBe('RETURNED'); // a return dominates the batch rollup
    expect(res.items.find((i) => i.itemId === 'i1')?.status).toBe('SETTLED');
    const returned = res.items.find((i) => i.itemId === 'i2');
    expect(returned?.status).toBe('RETURNED');
    expect(returned?.returnCode).toBe('R02');
  });

  it('defaults the return code when a simulated return omits one', async () => {
    const res = await provider.getStatus({
      providerBatchRef: 'sbx_batch_x',
      lines: [{ itemId: 'i1', amountCents: 100, vendorId: null }],
      simulate: { returns: [{ itemId: 'i1', returnCode: '' }] },
    });
    expect(res.items[0].returnCode).toBe(SANDBOX_DEFAULT_RETURN_CODE);
  });
});

// ── Idempotent submit (fake DB) ──────────────────────────────────────────────

/** Minimal chainable Supabase stub: terminal reads resolve configured rows. */
function fakeDb(handlers: Record<string, { single?: unknown; list?: unknown }>): SupabaseClient {
  const make = (table: string) => {
    const h = handlers[table] ?? {};
    const list = h.list ?? { data: [], error: null };
    const single = h.single ?? { data: null, error: null };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    Object.assign(builder, {
      select: chain,
      eq: chain,
      in: chain,
      order: () => Promise.resolve(list),
      maybeSingle: () => Promise.resolve(single),
      single: () => Promise.resolve(single),
      update: chain,
      insert: chain,
      // thenable so `await db.from().update().eq()...` resolves
      then: (resolve: (v: unknown) => unknown) => resolve(list),
    });
    return builder;
  };
  return { from: (table: string) => make(table) } as unknown as SupabaseClient;
}

/** Provider spy that records whether the rail hand-off actually happened. */
class SpyProvider extends SandboxOriginationProvider {
  submitCalls = 0;
  override async submitBatch(input: Parameters<SandboxOriginationProvider['submitBatch']>[0]) {
    this.submitCalls += 1;
    return super.submitBatch(input);
  }
}

describe('submitOriginationBatch — idempotency', () => {
  it('does NOT resubmit a batch that is already SUBMITTED (no duplicate rail hand-off)', async () => {
    const db = fakeDb({
      payment_origination_batches: {
        single: {
          data: {
            id: 'b1',
            org_id: 'org1',
            location_id: null,
            provider: 'SANDBOX',
            rail: 'ACH',
            status: 'SUBMITTED', // already handed off
            provider_batch_ref: 'sbx_batch_b1',
            total_cents: 1200,
            item_count: 1,
            effective_date: null,
            submitted_by: 'u1',
            submitted_at: '2026-08-01T00:00:00Z',
            settled_at: null,
            created_at: '2026-08-01T00:00:00Z',
          },
          error: null,
        },
      },
      payment_origination_items: { list: { data: [], error: null } },
    });
    const provider = new SpyProvider();
    const outcome = await submitOriginationBatch(db, 'org1', 'b1', provider, 'u2');
    expect(outcome.submitted).toBe(false);
    expect(provider.submitCalls).toBe(0); // the rail was never called again
    expect(outcome.batch.status).toBe('SUBMITTED');
  });
});
