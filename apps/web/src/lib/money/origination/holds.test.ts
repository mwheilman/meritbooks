/**
 * Security review M3 — money already RELEASED is re-checked (read-only) for vendor holds
 * before it reaches the rail: held lines are kept off a new origination batch, and a batch
 * whose vendor went on hold after creation is refused at submit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeSupabase, type FakeCall, type FakeResp } from '@/test/fake-supabase';
import { SandboxOriginationProvider } from './sandbox';

const reasons = new Map<string, string>();
vi.mock('@/lib/services/vendor-compliance', () => ({
  paymentBlockKey: (v: string, b?: string | null) => `${v}|${b ?? ''}`,
  paymentBlockReasons: vi.fn(async () => reasons),
}));

import {
  assembleReleasedDisbursements,
  createOriginationBatch,
  NothingToOriginateError,
  OriginationHeldError,
  submitOriginationBatch,
} from './service';

const ok = (data: unknown): FakeResp => ({ data, error: null });

function releasedDb() {
  return fakeSupabase((c: FakeCall) => {
    if (c.table === 'approvals') {
      return ok([
        { id: 'a1', subject_id: 'b1', amount_cents: 1000, provider_correlation_id: 'bill_payment:11111111-1111-1111-1111-111111111111', status: 'RELEASED' },
        { id: 'a2', subject_id: 'b2', amount_cents: 2000, provider_correlation_id: null, status: 'RELEASED' },
      ]);
    }
    if (c.table === 'payment_origination_items' && c.op === 'select') return ok([]);
    if (c.table === 'bills') return ok([
      { id: 'b1', vendor_id: 'v1', location_id: 'L', payment_method: 'ACH' },
      { id: 'b2', vendor_id: 'v2', location_id: 'L', payment_method: 'ACH' },
    ]);
    return ok([]);
  });
}

beforeEach(() => reasons.clear());

describe('assembleReleasedDisbursements — vendor holds after release', () => {
  it('without orgId nothing is re-checked (back-compat)', async () => {
    reasons.set('v2|b2', 'held');
    const r = await assembleReleasedDisbursements(releasedDb().client);
    expect(r.lines.map((l) => l.approvalId)).toEqual(['a1', 'a2']);
    expect(r.held).toEqual([]);
  });

  it('with orgId a held vendor is kept off the rail with its plain-English reason', async () => {
    reasons.set('v2|b2', "This vendor's bank details changed on 2026-10-20.");
    const r = await assembleReleasedDisbursements(releasedDb().client, { orgId: 'org' });
    expect(r.lines.map((l) => l.approvalId)).toEqual(['a1']);
    expect(r.held).toEqual([{ approvalId: 'a2', vendorId: 'v2', amountCents: 2000, reason: "This vendor's bank details changed on 2026-10-20." }]);
  });
});

describe('createOriginationBatch — everything held', () => {
  it('throws NothingToOriginateError carrying the held lines and the reason', async () => {
    reasons.set('v1|b1', 'Vendor went on compliance hold');
    reasons.set('v2|b2', 'Vendor went on compliance hold');
    const d = releasedDb();
    const err = await createOriginationBatch(d.client, 'org', { provider: 'SANDBOX', rail: 'ACH', writer: d.client }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NothingToOriginateError);
    expect((err as NothingToOriginateError).held).toHaveLength(2);
    expect((err as Error).message).toMatch(/held/);
    expect(d.calls.some((c) => c.op === 'insert')).toBe(false); // nothing written
  });
});

describe('submitOriginationBatch — re-check at hand-off', () => {
  function createdBatchDb() {
    return fakeSupabase((c: FakeCall) => {
      if (c.table === 'payment_origination_batches' && c.op === 'select') {
        return ok({ id: 'bt', org_id: 'org', location_id: 'L', provider: 'SANDBOX', rail: 'ACH', status: 'CREATED', provider_batch_ref: null, total_cents: 1000, item_count: 1, effective_date: null, submitted_by: null, submitted_at: null, settled_at: null, created_at: '' });
      }
      if (c.table === 'payment_origination_items' && c.op === 'select') {
        return ok([{ id: 'i1', batch_id: 'bt', approval_id: 'a1', bill_payment_id: null, vendor_id: 'v1', amount_cents: 1000, status: 'PENDING', return_code: null }]);
      }
      if (c.table === 'approvals') return ok([{ id: 'a1', subject_id: 'b1' }]);
      if (c.table === 'bills') return ok([{ id: 'b1', location_id: 'L' }]);
      return ok([]);
    });
  }

  class Spy extends SandboxOriginationProvider {
    calls = 0;
    override async submitBatch(input: Parameters<SandboxOriginationProvider['submitBatch']>[0]) {
      this.calls += 1;
      return super.submitBatch(input);
    }
  }

  it('a vendor that went on hold after the batch was created stops the hand-off', async () => {
    reasons.set('v1|b1', "This vendor's bank details changed.");
    const d = createdBatchDb();
    const p = new Spy();
    const err = await submitOriginationBatch(d.client, 'org', 'bt', p, 'u1', { writer: d.client }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OriginationHeldError);
    expect((err as Error).message).toMatch(/bank details changed/);
    expect(p.calls).toBe(0); // the rail was never called
    expect(d.calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('no hold → submitted', async () => {
    const d = createdBatchDb();
    const p = new Spy();
    const out = await submitOriginationBatch(d.client, 'org', 'bt', p, 'u1', { writer: d.client });
    expect(out.submitted).toBe(true);
    expect(p.calls).toBe(1);
  });
});
