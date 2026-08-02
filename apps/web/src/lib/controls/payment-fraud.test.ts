/**
 * Payment-Run Fraud Screen — deterministic screener assertions.
 *
 * The verdict that gates a payment must be reproducible from numbers alone (the AI
 * only phrases it), so every screener is unit-tested against fixed fixtures. These
 * are the exact patterns that lose real money at release time.
 */

import { describe, it, expect } from 'vitest';
import {
  screenNewPayee,
  screenBankDetailChange,
  screenUnusualAmount,
  screenDuplicate,
  screenRoundDollarFirstLarge,
  assessPaymentRisk,
  requiresOverride,
  amountStats,
  LARGE_PAYMENT_CENTS,
  type PaymentToScreen,
  type VendorPaymentHistory,
  type VendorBankDetail,
  type RecentPayment,
} from './payment-fraud';

const payment = (over: Partial<PaymentToScreen> = {}): PaymentToScreen => ({
  paymentId: 'bill-subject',
  vendorId: 'v1',
  vendorName: 'Acme Supply',
  locationId: 'loc1',
  amountCents: 250_00,
  paymentDate: '2026-08-01',
  invoiceRef: 'INV-1001',
  ...over,
});

const history = (over: Partial<VendorPaymentHistory> = {}): VendorPaymentHistory => ({
  priorAmountsCents: [200_00, 210_00, 205_00, 198_00, 220_00],
  priorPaymentCount: 5,
  lastPaidDate: '2026-07-01',
  ...over,
});

const noBank: VendorBankDetail = {
  currentAccountMask: null,
  currentRoutingMask: null,
  priorAccountMask: null,
  priorRoutingMask: null,
  currentSignedAt: null,
  activeAuthCount: 0,
};

// ── amountStats ────────────────────────────────────────────────────────────────
describe('amountStats', () => {
  it('computes mean, median, max, and population std', () => {
    const s = amountStats([100, 200, 300]);
    expect(s.mean).toBe(200);
    expect(s.median).toBe(200);
    expect(s.max).toBe(300);
    expect(s.std).toBeCloseTo(81.65, 1);
  });
  it('returns zeros for empty input', () => {
    expect(amountStats([])).toEqual({ n: 0, mean: 0, std: 0, median: 0, max: 0 });
  });
});

// ── (1) NEW PAYEE ────────────────────────────────────────────────────────────
describe('screenNewPayee', () => {
  it('does not flag a vendor with payment history', () => {
    expect(screenNewPayee(payment(), history())).toBeNull();
  });
  it('flags a first-ever payment as warn', () => {
    const f = screenNewPayee(payment({ amountCents: 500_00 }), history({ priorAmountsCents: [], priorPaymentCount: 0 }));
    expect(f?.code).toBe('NEW_PAYEE');
    expect(f?.severity).toBe('warn');
  });
  it('escalates a large first-ever payment to critical', () => {
    const f = screenNewPayee(
      payment({ amountCents: LARGE_PAYMENT_CENTS + 1 }),
      history({ priorAmountsCents: [], priorPaymentCount: 0 }),
    );
    expect(f?.severity).toBe('critical');
  });
});

// ── (2) BANK-DETAIL CHANGE (BEC) ──────────────────────────────────────────────
describe('screenBankDetailChange', () => {
  it('flags a changed account mask as critical (BEC)', () => {
    const bank: VendorBankDetail = {
      ...noBank,
      currentAccountMask: '9999',
      priorAccountMask: '1234',
      currentRoutingMask: '4444',
      priorRoutingMask: '4444',
      activeAuthCount: 1,
    };
    const f = screenBankDetailChange(payment(), history(), bank);
    expect(f?.code).toBe('BANK_DETAIL_CHANGE');
    expect(f?.severity).toBe('critical');
  });
  it('does not flag when masks are unchanged', () => {
    const bank: VendorBankDetail = {
      ...noBank,
      currentAccountMask: '1234',
      priorAccountMask: '1234',
      currentRoutingMask: '4444',
      priorRoutingMask: '4444',
      activeAuthCount: 1,
    };
    expect(screenBankDetailChange(payment(), history(), bank)).toBeNull();
  });
  it('warns on new banking instructions for an existing paid vendor', () => {
    const bank: VendorBankDetail = {
      ...noBank,
      currentAccountMask: '5555',
      currentRoutingMask: '6666',
      activeAuthCount: 1,
    };
    const f = screenBankDetailChange(payment(), history(), bank);
    expect(f?.severity).toBe('warn');
  });
  it('warns when multiple active authorizations exist', () => {
    const bank: VendorBankDetail = {
      ...noBank,
      currentAccountMask: '1234',
      priorAccountMask: '1234',
      activeAuthCount: 3,
    };
    const f = screenBankDetailChange(payment(), history(), bank);
    expect(f?.severity).toBe('warn');
  });
});

// ── (3) UNUSUAL AMOUNT ────────────────────────────────────────────────────────
describe('screenUnusualAmount', () => {
  it('does not flag an amount within the vendor distribution', () => {
    expect(screenUnusualAmount(payment({ amountCents: 215_00 }), history())).toBeNull();
  });
  it('flags an amount far above the vendor history', () => {
    // history ~$200; a $5,000 payment is >5x the largest prior -> critical
    const f = screenUnusualAmount(payment({ amountCents: 5_000_00 }), history());
    expect(f?.code).toBe('UNUSUAL_AMOUNT');
    expect(f?.severity).toBe('critical');
  });
  it('does not flag when history is too sparse to judge', () => {
    const f = screenUnusualAmount(payment({ amountCents: 5_000_00 }), history({ priorAmountsCents: [200_00, 210_00], priorPaymentCount: 2 }));
    expect(f).toBeNull();
  });
  it('does not flag a smaller-than-usual amount', () => {
    expect(screenUnusualAmount(payment({ amountCents: 10_00 }), history())).toBeNull();
  });
});

// ── (4) DUPLICATE ─────────────────────────────────────────────────────────────
describe('screenDuplicate', () => {
  const recentPay = (over: Partial<RecentPayment> = {}): RecentPayment => ({
    id: 'pay-1',
    amountCents: 250_00,
    paymentDate: '2026-07-30',
    invoiceRef: 'INV-1001',
    kind: 'payment',
    ...over,
  });

  it('flags same invoice + same amount as a critical duplicate', () => {
    const f = screenDuplicate(payment(), [recentPay()]);
    expect(f?.code).toBe('DUPLICATE');
    expect(f?.severity).toBe('critical');
    expect(f?.detail.match_kind).toBe('payment');
  });
  it('flags identical amount within the near-date window', () => {
    const f = screenDuplicate(payment({ invoiceRef: 'OTHER' }), [recentPay({ invoiceRef: 'ZZZ', paymentDate: '2026-07-29' })]);
    expect(f?.code).toBe('DUPLICATE');
  });
  it('ignores its own subject id', () => {
    expect(screenDuplicate(payment(), [recentPay({ id: 'bill-subject' })])).toBeNull();
  });
  it('does not flag a different amount far apart with a different invoice', () => {
    const f = screenDuplicate(payment({ invoiceRef: 'OTHER' }), [
      recentPay({ amountCents: 900_00, paymentDate: '2026-01-01', invoiceRef: 'ZZZ' }),
    ]);
    expect(f).toBeNull();
  });
});

// ── (5) ROUND-DOLLAR FIRST-LARGE ─────────────────────────────────────────────
describe('screenRoundDollarFirstLarge', () => {
  it('flags a large, round, first-time payment as info', () => {
    const f = screenRoundDollarFirstLarge(
      payment({ amountCents: 25_000_00 }),
      history({ priorAmountsCents: [], priorPaymentCount: 0 }),
    );
    expect(f?.code).toBe('ROUND_DOLLAR_FIRST_LARGE');
    expect(f?.severity).toBe('info');
  });
  it('does not flag a non-round amount', () => {
    const f = screenRoundDollarFirstLarge(
      payment({ amountCents: 25_123_45 }),
      history({ priorAmountsCents: [], priorPaymentCount: 0 }),
    );
    expect(f).toBeNull();
  });
  it('does not flag when the vendor has history', () => {
    expect(screenRoundDollarFirstLarge(payment({ amountCents: 25_000_00 }), history())).toBeNull();
  });
});

// ── Verdict aggregation ──────────────────────────────────────────────────────
describe('assessPaymentRisk', () => {
  it('clears a routine payment to a known vendor', () => {
    const v = assessPaymentRisk(payment({ amountCents: 215_00, invoiceRef: 'INV-NEW' }), history(), noBank, []);
    expect(v.level).toBe('clear');
    expect(v.flags).toHaveLength(0);
    expect(requiresOverride(v)).toBe(false);
  });

  it('BLOCKS on a critical bank-detail change (BEC)', () => {
    const bank: VendorBankDetail = {
      ...noBank,
      currentAccountMask: '9999',
      priorAccountMask: '1234',
      currentRoutingMask: '4444',
      priorRoutingMask: '4444',
      activeAuthCount: 1,
    };
    const v = assessPaymentRisk(payment({ invoiceRef: 'INV-NEW' }), history(), bank, []);
    expect(v.level).toBe('block');
    expect(requiresOverride(v)).toBe(true);
    expect(v.flags.some((f) => f.code === 'BANK_DETAIL_CHANGE')).toBe(true);
  });

  it('BLOCKS on a duplicate of an already-disbursed payment', () => {
    const recent: RecentPayment[] = [
      { id: 'pay-1', amountCents: 250_00, paymentDate: '2026-07-30', invoiceRef: 'INV-1001', kind: 'payment' },
    ];
    const v = assessPaymentRisk(payment(), history(), noBank, recent);
    expect(v.level).toBe('block');
  });

  it('routes a new-payee (non-large) payment to REVIEW', () => {
    const v = assessPaymentRisk(
      payment({ amountCents: 500_00, invoiceRef: 'INV-NEW' }),
      history({ priorAmountsCents: [], priorPaymentCount: 0, lastPaidDate: null }),
      noBank,
      [],
    );
    expect(v.level).toBe('review');
    expect(requiresOverride(v)).toBe(true);
  });

  it('score rises with flag count and severity', () => {
    const clear = assessPaymentRisk(payment({ amountCents: 215_00, invoiceRef: 'INV-NEW' }), history(), noBank, []);
    const bank: VendorBankDetail = {
      ...noBank,
      currentAccountMask: '9999',
      priorAccountMask: '1234',
      currentRoutingMask: '4444',
      priorRoutingMask: '4444',
      activeAuthCount: 1,
    };
    const blocked = assessPaymentRisk(payment({ amountCents: 5_000_00, invoiceRef: 'INV-NEW' }), history(), bank, []);
    expect(blocked.score).toBeGreaterThan(clear.score);
  });
});
