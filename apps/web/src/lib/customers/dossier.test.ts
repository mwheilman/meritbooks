/**
 * Customer dossier math — locks the deterministic payment-behavior + credit +
 * risk computation. These figures drive the credit decision and the risk badge,
 * so the assertions pin every derived number. The AI layer only rephrases these
 * values, so as long as the math is right the model can't introduce a number.
 *
 * Pure logic only — fixed ISO dates, no Date.now, no Supabase.
 */

import { describe, it, expect } from 'vitest';
import {
  computePaymentBehavior,
  computeCreditProfile,
  computeRiskAssessment,
  buildDossier,
  RISK_THRESHOLDS,
  type DossierInvoice,
  type DossierPayment,
} from './dossier';

const ASOF = '2026-08-01';

const payments: DossierPayment[] = [
  { invoiceDate: '2026-01-01', dueDate: '2026-01-31', paymentDate: '2026-02-05', amountCents: 100000 }, // 35d, 5 late
  { invoiceDate: '2026-03-01', dueDate: '2026-03-31', paymentDate: '2026-03-20', amountCents: 50000 }, // 19d, on time
  { invoiceDate: '2026-04-01', dueDate: '2026-05-01', paymentDate: '2026-06-30', amountCents: 300000 }, // 90d, 60 late
];

const invoices: DossierInvoice[] = [
  { invoiceDate: '2026-01-01', dueDate: '2026-01-31', totalCents: 100000, balanceCents: 0, status: 'PAID' },
  { invoiceDate: '2026-03-01', dueDate: '2026-03-31', totalCents: 50000, balanceCents: 0, status: 'PAID' },
  { invoiceDate: '2026-04-01', dueDate: '2026-05-01', totalCents: 300000, balanceCents: 0, status: 'PAID' },
  { invoiceDate: '2026-06-01', dueDate: '2026-07-01', totalCents: 200000, balanceCents: 200000, status: 'OVERDUE' },
  { invoiceDate: '2026-07-15', dueDate: '2026-08-15', totalCents: 80000, balanceCents: 80000, status: 'SENT' },
];

describe('computePaymentBehavior', () => {
  const b = computePaymentBehavior(invoices, payments, { termsDays: 30, asOf: ASOF });

  it('derives days-to-pay statistics', () => {
    expect(b.paidApplicationCount).toBe(3);
    expect(b.avgDaysToPay).toBe(48); // (35+19+90)/3
    expect(b.medianDaysToPay).toBe(35);
    expect(b.worstDaysToPay).toBe(90);
    expect(b.lastDaysToPay).toBe(90); // most recent payment (2026-06-30)
    expect(b.lastPaymentDate).toBe('2026-06-30');
  });

  it('derives on-time + beyond-terms measures', () => {
    expect(b.onTimeRate).toBeCloseTo(1 / 3, 5);
    expect(b.avgDaysBeyondTerms).toBe(22); // (5+0+60)/3 = 21.67 → 22
  });

  it('sums TTM revenue and the open/overdue picture', () => {
    expect(b.ttmRevenueCents).toBe(730000); // all five invoices are within the trailing year
    expect(b.openBalanceCents).toBe(280000); // 200000 + 80000
    expect(b.overdueBalanceCents).toBe(200000);
    expect(b.overdueInvoiceCount).toBe(1);
    expect(b.maxOverdueDays).toBe(31); // due 2026-07-01 → asOf 2026-08-01
  });

  it('handles a customer with no history', () => {
    const empty = computePaymentBehavior([], [], { termsDays: 30, asOf: ASOF });
    expect(empty.paidApplicationCount).toBe(0);
    expect(empty.avgDaysToPay).toBeNull();
    expect(empty.onTimeRate).toBeNull();
    expect(empty.openBalanceCents).toBe(0);
  });
});

describe('computeCreditProfile', () => {
  it('computes utilization and available credit against the limit', () => {
    const p = computeCreditProfile({ creditLimitCents: 250000, openArCents: 280000 });
    expect(p.utilizationPct).toBeCloseTo(1.12, 5);
    expect(p.availableCreditCents).toBe(-30000); // over limit
  });

  it('is null-safe when no limit is configured', () => {
    const p = computeCreditProfile({ creditLimitCents: null, openArCents: 280000 });
    expect(p.creditLimitCents).toBeNull();
    expect(p.utilizationPct).toBeNull();
    expect(p.availableCreditCents).toBeNull();
    expect(p.openArCents).toBe(280000);
  });

  it('treats a zero limit as no limit', () => {
    const p = computeCreditProfile({ creditLimitCents: 0, openArCents: 100 });
    expect(p.creditLimitCents).toBeNull();
    expect(p.utilizationPct).toBeNull();
  });
});

describe('computeRiskAssessment', () => {
  const behavior = computePaymentBehavior(invoices, payments, { termsDays: 30, asOf: ASOF });

  it('flags slow-pay, over-limit, delinquent, and concentration → high', () => {
    const credit = computeCreditProfile({ creditLimitCents: 250000, openArCents: behavior.openBalanceCents });
    const r = computeRiskAssessment('Acme Corp', behavior, credit, 0.73);
    expect(r.flags).toContain('SLOW_PAY');
    expect(r.flags).toContain('OVER_LIMIT');
    expect(r.flags).toContain('DELINQUENT');
    expect(r.flags).toContain('CONCENTRATION');
    expect(r.level).toBe('high');
    expect(r.summary).toContain('Acme Corp');
  });

  it('flags approaching-limit (soft) at high utilization → medium', () => {
    const clean = computePaymentBehavior(
      [{ invoiceDate: '2026-07-20', dueDate: '2026-08-20', totalCents: 90000, balanceCents: 90000, status: 'SENT' }],
      [],
      { termsDays: 30, asOf: ASOF },
    );
    const credit = computeCreditProfile({ creditLimitCents: 100000, openArCents: clean.openBalanceCents });
    const r = computeRiskAssessment('Beta LLC', clean, credit, null);
    expect(r.flags).toContain('APPROACHING_LIMIT');
    expect(r.flags).not.toContain('OVER_LIMIT');
    expect(r.level).toBe('medium');
  });

  it('a prompt-paying, in-limit customer has no flags → low + healthy summary', () => {
    const good = computePaymentBehavior(
      [
        { invoiceDate: '2026-05-01', dueDate: '2026-05-31', totalCents: 100000, balanceCents: 0, status: 'PAID' },
        { invoiceDate: '2026-06-01', dueDate: '2026-07-01', totalCents: 100000, balanceCents: 0, status: 'PAID' },
        { invoiceDate: '2026-06-15', dueDate: '2026-07-15', totalCents: 100000, balanceCents: 0, status: 'PAID' },
      ],
      [
        { invoiceDate: '2026-05-01', dueDate: '2026-05-31', paymentDate: '2026-05-20', amountCents: 100000 },
        { invoiceDate: '2026-06-01', dueDate: '2026-07-01', paymentDate: '2026-06-20', amountCents: 100000 },
        { invoiceDate: '2026-06-15', dueDate: '2026-07-15', paymentDate: '2026-07-01', amountCents: 100000 },
      ],
      { termsDays: 30, asOf: ASOF },
    );
    const credit = computeCreditProfile({ creditLimitCents: 1000000, openArCents: good.openBalanceCents });
    const r = computeRiskAssessment('Gamma Inc', good, credit, 0.05);
    expect(r.flags).toEqual([]);
    expect(r.level).toBe('low');
    expect(r.summary.toLowerCase()).toContain('healthy');
  });

  it('does not fire pay-speed flags below the minimum sample', () => {
    const tiny = computePaymentBehavior(
      [{ invoiceDate: '2026-01-01', dueDate: '2026-01-31', totalCents: 1000, balanceCents: 0, status: 'PAID' }],
      [{ invoiceDate: '2026-01-01', dueDate: '2026-01-31', paymentDate: '2026-06-01', amountCents: 1000 }], // very late, but 1 sample
      { termsDays: 30, asOf: ASOF },
    );
    const credit = computeCreditProfile({ creditLimitCents: null, openArCents: 0 });
    const r = computeRiskAssessment('Delta', tiny, credit, null);
    expect(r.flags).not.toContain('SLOW_PAY');
    expect(RISK_THRESHOLDS.minPaymentSample).toBeGreaterThan(1);
  });
});

describe('buildDossier', () => {
  it('assembles behavior + credit + concentration + risk end to end', () => {
    const d = buildDossier({
      customerName: 'Acme Corp',
      creditLimitCents: 250000,
      termsDays: 30,
      invoices,
      payments,
      orgTtmRevenueCents: 1000000,
      asOf: ASOF,
    });
    expect(d.behavior.openBalanceCents).toBe(280000);
    expect(d.credit.utilizationPct).toBeCloseTo(1.12, 5);
    expect(d.concentrationPct).toBeCloseTo(0.73, 5); // 730000 / 1000000
    expect(d.risk.level).toBe('high');
  });

  it('null concentration when the org booked no TTM revenue', () => {
    const d = buildDossier({
      customerName: 'Zed',
      creditLimitCents: null,
      termsDays: 30,
      invoices: [],
      payments: [],
      orgTtmRevenueCents: 0,
      asOf: ASOF,
    });
    expect(d.concentrationPct).toBeNull();
    expect(d.risk.level).toBe('low');
  });
});
