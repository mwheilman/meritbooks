import { describe, expect, it } from 'vitest';
import { cardLineReceiptStatus, needsReceipt, olderUnreceiptedCharges } from './charges';
import type { CardAccount, ChargeTxn } from './types';

const NOW = new Date('2026-10-24T12:00:00Z');
const CARD: CardAccount = { id: 'cc', location_id: 'L', account_type: 'CREDIT_CARD', account_mask: '4242', account_name: 'Amex', is_active: true };
const CHK: CardAccount = { id: 'chk', location_id: 'L', account_type: 'CHECKING', account_mask: '1111', account_name: 'Operating', is_active: true };

const txn = (id: string, date: string, cents: number, description = 'HOME DEPOT #123', extra: Partial<ChargeTxn> = {}): ChargeTxn => ({
  id,
  org_id: 'O',
  location_id: 'L',
  bank_account_id: 'cc',
  transaction_date: date,
  description,
  amount_cents: cents,
  matched_receipt_id: null,
  matched_bill_id: null,
  ...extra,
});

describe('cardLineReceiptStatus', () => {
  it('payments, autopay and "thank you" lines never say "No receipt"', () => {
    for (const d of ['AUTOMATIC PAYMENT - THANK', 'AUTOPAY PAYMENT', 'ONLINE PAYMENT, THANK YOU', 'PAYMENT RECEIVED']) {
      expect(cardLineReceiptStatus(txn('t', '2026-10-01', -50_00, d), null), d).toBe('NOT_APPLICABLE');
    }
  });

  it('refunds and credits (amount ≥ 0) are not purchases', () => {
    expect(cardLineReceiptStatus(txn('t', '2026-10-01', 25_00, 'AMAZON REFUND'), null)).toBe('NOT_APPLICABLE');
    expect(cardLineReceiptStatus(txn('t', '2026-10-01', 0, 'ADJUSTMENT'), null)).toBe('NOT_APPLICABLE');
  });

  it('maps a purchase through the chase state', () => {
    expect(cardLineReceiptStatus(txn('t', '2026-10-01', -50_00), null)).toBe('MISSING');
    expect(cardLineReceiptStatus(txn('t', '2026-10-01', -50_00), 'requested')).toBe('PENDING');
    expect(cardLineReceiptStatus(txn('t', '2026-10-01', -50_00), 'below_threshold')).toBe('NOT_REQUIRED');
    expect(cardLineReceiptStatus(txn('t', '2026-10-01', -50_00), 'matched')).toBe('MATCHED');
    expect(cardLineReceiptStatus(txn('t', '2026-10-01', -50_00, 'X', { matched_receipt_id: 'r' }), null)).toBe('MATCHED');
    expect(cardLineReceiptStatus(txn('t', '2026-10-01', -50_00, 'X', { matched_bill_id: 'b' }), null)).toBe('NOT_REQUIRED');
  });

  it('needsReceipt is true only for MISSING / PENDING', () => {
    expect(needsReceipt('MISSING')).toBe(true);
    expect(needsReceipt('PENDING')).toBe(true);
    expect(needsReceipt('NOT_APPLICABLE')).toBe(false);
    expect(needsReceipt('MATCHED')).toBe(false);
  });
});

describe('olderUnreceiptedCharges', () => {
  const policyFor = () => ({ chaseWindowDays: 60, receiptRequiredOverCents: 75_00 });
  const base = {
    accounts: new Map([['cc', CARD], ['chk', CHK]]),
    assignments: [],
    tracked: new Set<string>(),
    withReceipt: new Set<string>(),
    policyFor,
    now: NOW,
  };

  it('counts purchases over the limit that are older than the chase window', () => {
    const txns = [
      txn('old', '2026-07-01', -120_00), // 115 days → outside window
      txn('recent', '2026-10-10', -120_00), // inside window → the chase handles it
      txn('small', '2026-07-01', -10_00), // under the receipt limit
      txn('pay', '2026-07-01', -500_00, 'AUTOMATIC PAYMENT - THANK'),
      txn('refund', '2026-07-01', 120_00),
      txn('chk', '2026-07-01', -120_00, 'CHECK 1001', { bank_account_id: 'chk' }), // not a card line
    ];
    expect(olderUnreceiptedCharges({ ...base, txns }).map((t) => t.id)).toEqual(['old']);
  });

  it('skips charges the chase already tracks or that have a receipt', () => {
    const txns = [txn('a', '2026-06-01', -200_00), txn('b', '2026-06-01', -200_00), txn('c', '2026-06-01', -200_00, 'X', { matched_receipt_id: 'r' })];
    expect(olderUnreceiptedCharges({ ...base, txns, tracked: new Set(['a']), withReceipt: new Set(['b']) })).toEqual([]);
  });
});
