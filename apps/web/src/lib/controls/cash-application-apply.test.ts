/**
 * Cash-application APPLY amount rules + AR subledger↔GL tie-out — pure logic.
 *
 * Locks the four apply cases (single, sum-to-total, partial, over-apply guard)
 * and the tie-out variance computation. No Supabase, no clock.
 */

import { describe, it, expect } from 'vitest';
import {
  validateCashApplyPlan,
  computeArTieOut,
  type CashApplyLine,
} from './cash-application';

function line(over: Partial<CashApplyLine>): CashApplyLine {
  return { invoiceId: 'i1', amountCents: 500_000, balanceCents: 500_000, ...over };
}

describe('validateCashApplyPlan', () => {
  it('SINGLE: one invoice applied at its full balance, exact to the deposit', () => {
    const r = validateCashApplyPlan(500_000, [line({})]);
    expect(r.ok).toBe(true);
    expect(r.totalAppliedCents).toBe(500_000);
    expect(r.unappliedCents).toBe(0);
  });

  it('SUM-TO-TOTAL: several invoices whose amounts sum exactly to the deposit', () => {
    const r = validateCashApplyPlan(1_250_000, [
      line({ invoiceId: 'i1', amountCents: 750_000, balanceCents: 750_000 }),
      line({ invoiceId: 'i2', amountCents: 500_000, balanceCents: 500_000 }),
    ]);
    expect(r.ok).toBe(true);
    expect(r.totalAppliedCents).toBe(1_250_000);
    expect(r.unappliedCents).toBe(0);
  });

  it('PARTIAL of an invoice: a line below its balance is allowed', () => {
    const r = validateCashApplyPlan(300_000, [line({ amountCents: 300_000, balanceCents: 500_000 })]);
    expect(r.ok).toBe(true);
    expect(r.totalAppliedCents).toBe(300_000);
  });

  it('PARTIAL of the deposit: applying less than the deposit leaves an on-account remainder', () => {
    const r = validateCashApplyPlan(500_000, [line({ amountCents: 400_000, balanceCents: 400_000 })]);
    expect(r.ok).toBe(true);
    expect(r.totalAppliedCents).toBe(400_000);
    expect(r.unappliedCents).toBe(100_000);
  });

  it('OVER-APPLY guard 1: a line may never exceed its invoice balance', () => {
    const r = validateCashApplyPlan(600_000, [line({ amountCents: 600_000, balanceCents: 500_000 })]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/exceeds/i);
  });

  it('OVER-APPLY guard 2: the applied total may not exceed the deposit', () => {
    const r = validateCashApplyPlan(500_000, [
      line({ invoiceId: 'i1', amountCents: 400_000, balanceCents: 400_000 }),
      line({ invoiceId: 'i2', amountCents: 300_000, balanceCents: 300_000 }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/exceeds the .* deposit/i);
  });

  it('rejects an empty plan, a non-positive deposit, a non-positive amount, and duplicate invoices', () => {
    expect(validateCashApplyPlan(500_000, []).ok).toBe(false);
    expect(validateCashApplyPlan(0, [line({})]).ok).toBe(false);
    expect(validateCashApplyPlan(-1, [line({})]).ok).toBe(false);
    expect(validateCashApplyPlan(500_000, [line({ amountCents: 0 })]).ok).toBe(false);
    expect(validateCashApplyPlan(500_000, [line({ amountCents: 1.5 })]).ok).toBe(false);
    expect(
      validateCashApplyPlan(500_000, [
        line({ invoiceId: 'dup', amountCents: 100_000, balanceCents: 500_000 }),
        line({ invoiceId: 'dup', amountCents: 100_000, balanceCents: 500_000 }),
      ]).ok,
    ).toBe(false);
  });
});

describe('computeArTieOut', () => {
  it('ties out when the subledger equals the GL control balance', () => {
    const t = computeArTieOut(1_250_000, 1_250_000);
    expect(t.tiesOut).toBe(true);
    expect(t.varianceCents).toBe(0);
  });

  it('surfaces a positive reconciling item when the GL exceeds the subledger', () => {
    const t = computeArTieOut(1_000_000, 1_250_000);
    expect(t.tiesOut).toBe(false);
    expect(t.varianceCents).toBe(250_000); // GL − subledger
  });

  it('surfaces a negative reconciling item when the subledger exceeds the GL', () => {
    const t = computeArTieOut(1_250_000, 1_000_000);
    expect(t.tiesOut).toBe(false);
    expect(t.varianceCents).toBe(-250_000);
  });
});
