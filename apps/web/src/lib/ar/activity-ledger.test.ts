import { describe, it, expect } from 'vitest';
import { buildActivityLedger } from './activity-ledger';

describe('buildActivityLedger', () => {
  it('walks charges then payments into a running balance (no window)', () => {
    const l = buildActivityLedger(
      [
        { date: '2026-01-05', ref: 'INV-1', amountCents: 1000_00, status: 'PAID' },
        { date: '2026-02-10', ref: 'INV-2', amountCents: 500_00, status: 'SENT' },
      ],
      [{ date: '2026-01-20', ref: 'CHK-9', amountCents: 1000_00, method: 'CHECK' }],
    );
    expect(l.openingBalanceCents).toBe(0);
    expect(l.transactions.map((t) => t.balanceCents)).toEqual([1000_00, 0, 500_00]);
    expect(l.closingBalanceCents).toBe(500_00);
    expect(l.totalChargesCents).toBe(1500_00);
    expect(l.totalPaymentsCents).toBe(1000_00);
  });

  it('orders a same-day charge before its payment (never flashes negative)', () => {
    const l = buildActivityLedger(
      [{ date: '2026-03-01', ref: 'INV-3', amountCents: 300_00 }],
      [{ date: '2026-03-01', ref: '', amountCents: 300_00, method: 'ACH' }],
    );
    expect(l.transactions.map((t) => t.kind)).toEqual(['invoice', 'payment']);
    expect(l.transactions.map((t) => t.balanceCents)).toEqual([300_00, 0]);
  });

  it('rolls pre-window activity into the opening balance and hides those lines', () => {
    const l = buildActivityLedger(
      [
        { date: '2025-12-01', ref: 'INV-A', amountCents: 800_00 }, // before window
        { date: '2026-01-15', ref: 'INV-B', amountCents: 200_00 }, // in window
      ],
      [
        { date: '2025-12-20', ref: 'P0', amountCents: 300_00 }, // before window
        { date: '2026-01-25', ref: 'P1', amountCents: 100_00 }, // in window
      ],
      { from: '2026-01-01', to: '2026-01-31' },
    );
    // opening = 800 - 300 = 500
    expect(l.openingBalanceCents).toBe(500_00);
    // only in-window rows shown, running continues from opening
    expect(l.transactions.map((t) => t.ref)).toEqual(['INV-B', 'P1']);
    expect(l.transactions.map((t) => t.balanceCents)).toEqual([700_00, 600_00]);
    expect(l.closingBalanceCents).toBe(600_00);
  });

  it('ignores activity after the as-of edge (to)', () => {
    const l = buildActivityLedger(
      [{ date: '2026-02-15', ref: 'FUTURE', amountCents: 999_00 }],
      [],
      { from: '2026-01-01', to: '2026-01-31' },
    );
    expect(l.transactions).toHaveLength(0);
    expect(l.closingBalanceCents).toBe(0);
  });

  it('labels a credit distinctly from a cash payment', () => {
    const l = buildActivityLedger(
      [{ date: '2026-01-01', ref: 'INV-9', amountCents: 500_00 }],
      [{ date: '2026-01-10', ref: 'CM-1', amountCents: 50_00, isCredit: true }],
    );
    const credit = l.transactions.find((t) => t.kind === 'credit');
    expect(credit?.description).toContain('Credit');
    expect(l.closingBalanceCents).toBe(450_00);
  });
});
