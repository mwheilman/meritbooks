/** JOB_COMMITMENT payload validation (migration 194) — pure. */
import { describe, it, expect } from 'vitest';
import { validateCommitmentPayload, type CommitmentPayload } from './commitments';
import { SeamRejection } from '@/lib/events/seam';
import { commitmentHoldText, scoreThreeWay } from './commitment-match';

const base = (): CommitmentPayload => ({
  event_id: 'e', job_id: '11111111-1111-4111-8111-111111111111', location_id: '22222222-2222-4222-8222-222222222222',
  commitment_id: '33333333-3333-4333-8333-333333333333', version: 2, commitment_type: 'SUBCONTRACT', vendor_id: null, number: 'SC-1',
  status: 'EXECUTED', retainage_pct: '0.0500', payment_hold: true, hold_reason: 'COMPLIANCE: W-9 missing', source_ref: 'pm:commit:x:v2',
  lines: [{ commitment_line_id: '44444444-4444-4444-8444-444444444444', amount_cents: 1_000, received_to_date_cents: null, cost_type: 'SUBCONTRACTOR', cost_code_id: 'not-a-uuid' }],
});

describe('validateCommitmentPayload', () => {
  it('normalizes a good snapshot', () => {
    const v = validateCommitmentPayload(base());
    expect(v).toMatchObject({ version: 2, status: 'EXECUTED', type: 'SUBCONTRACT', retainagePct: 0.05, hold: true });
    expect(v.lines[0]).toMatchObject({ received_to_date_cents: 0, cost_code_id: null, line_no: 1 });
  });
  it.each([
    [{ version: 0 }, 'INVALID_PAYLOAD'],
    [{ status: 'DRAFT' }, 'INVALID_PAYLOAD'],
    [{ retainage_pct: 1.5 }, 'INVALID_PAYLOAD'],
    [{ commitment_type: 'LEASE' }, 'INVALID_PAYLOAD'],
    [{ source_ref: '' }, 'MISSING_SOURCE_REF'],
    [{ lines: [{ commitment_line_id: '44444444-4444-4444-8444-444444444444', amount_cents: -1 }] }, 'INVALID_AMOUNT'],
    [{ lines: [{ commitment_line_id: '44444444-4444-4444-8444-444444444444', amount_cents: 1 }, { commitment_line_id: '44444444-4444-4444-8444-444444444444', amount_cents: 1 }] }, 'INVALID_PAYLOAD'],
  ])('rejects %j with %s', (over, code) => {
    try {
      validateCommitmentPayload({ ...base(), ...(over as Partial<CommitmentPayload>) });
      throw new Error('expected a rejection');
    } catch (e) {
      expect(e).toBeInstanceOf(SeamRejection);
      expect((e as SeamRejection).code).toBe(code);
    }
  });
});

describe('3-way + hold text', () => {
  it('scores OVER_COMMITTED before receipts; receipts only matter for a PO with receiving in use', () => {
    expect(scoreThreeWay({ commitmentType: 'PO', amountCents: 100, receivedCents: 0, billedCents: 150, receivingInUse: true })).toEqual({ status: 'OVER_COMMITTED', varianceCents: 50 });
    expect(scoreThreeWay({ commitmentType: 'PO', amountCents: 100, receivedCents: 0, billedCents: 50, receivingInUse: true })).toEqual({ status: 'NO_RECEIPT', varianceCents: 50 });
    expect(scoreThreeWay({ commitmentType: 'PO', amountCents: 100, receivedCents: 40, billedCents: 50, receivingInUse: true })).toEqual({ status: 'BILLED_OVER_RECEIVED', varianceCents: 10 });
    expect(scoreThreeWay({ commitmentType: 'PO', amountCents: 100, receivedCents: 0, billedCents: 50, receivingInUse: false }).status).toBe('OK');
  });
  it('hold text names the commitment and reason', () => {
    expect(commitmentHoldText('PO-1', 'COI expired')).toBe('Projects commitment PO-1 is on payment hold: COI expired');
    expect(commitmentHoldText('PO-1', null)).toBe('Projects commitment PO-1 is on payment hold');
  });
});
