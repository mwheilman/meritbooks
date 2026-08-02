/**
 * AI adjusting-entry classifier guardrail (FPB Bank Reconciliation, Dimension 6).
 *
 * Proves the two things that matter about drafting adjustments from unmatched bank
 * lines:
 *   1. Common causes (bank fee, interest, NSF, sub-dollar FX/rounding) each earn a
 *      correctly-directed proposal — DR/CR side derived from the cash effect.
 *   2. The plug-vs-adjustment line: a line with NO explainable cause is NEVER
 *      proposed (returns null / lands in `unexplainedLineIds`) — canon: "a
 *      reconciliation forced to zero by a plug is NOT a reconciliation."
 */

import { describe, it, expect } from 'vitest';
import {
  classifyBankLine,
  draftAdjustmentProposals,
  type ClassifiableBankLine,
} from './reconciliation-adjustment-classify';

const line = (id: string, description: string, amountCents: number): ClassifiableBankLine => ({
  id,
  description,
  amountCents,
});

describe('classifyBankLine — explainable causes get a directed proposal', () => {
  it('books a bank service charge (outflow) as DR Bank Fees / CR Cash', () => {
    const p = classifyBankLine(line('t1', 'MONTHLY SERVICE CHARGE', -1500));
    expect(p).not.toBeNull();
    expect(p!.category).toBe('bank_fee');
    expect(p!.adjustmentType).toBe('bank_fee');
    expect(p!.cashEffect).toBe('decrease');
    expect(p!.amountCents).toBe(1500);
    expect(p!.offsetRole).toBe('MERCHANT_FEE_EXPENSE');
  });

  it('books interest earned (inflow) as an interest adjustment with a human-chosen income account', () => {
    const p = classifyBankLine(line('t2', 'Credit Interest Paid', 342));
    expect(p).not.toBeNull();
    expect(p!.category).toBe('interest');
    expect(p!.adjustmentType).toBe('interest');
    expect(p!.cashEffect).toBe('increase');
    expect(p!.amountCents).toBe(342);
    // interest income account is the human's choice → no auto-resolved role.
    expect(p!.offsetRole).toBeNull();
  });

  it('books an NSF / returned-item fee (outflow) as a bank-fee charge', () => {
    const p = classifyBankLine(line('t3', 'NSF RETURNED ITEM FEE', -3500));
    expect(p).not.toBeNull();
    expect(p!.category).toBe('nsf');
    expect(p!.adjustmentType).toBe('bank_fee');
    expect(p!.cashEffect).toBe('decrease');
    expect(p!.offsetRole).toBe('MERCHANT_FEE_EXPENSE');
  });

  it('proposes a sub-dollar FX/rounding correction only with a rounding-ish description', () => {
    const p = classifyBankLine(line('t4', 'FX rounding difference', -7));
    expect(p).not.toBeNull();
    expect(p!.category).toBe('fx_rounding');
    expect(p!.adjustmentType).toBe('other');
    expect(p!.cashEffect).toBe('decrease');
    expect(p!.amountCents).toBe(7);
  });
});

describe('classifyBankLine — never guesses (plug vs adjustment)', () => {
  it('does NOT propose for an unlabeled line, even a tiny one', () => {
    expect(classifyBankLine(line('u1', 'POS PURCHASE 12345', -6))).toBeNull();
  });

  it('does NOT propose a bank fee for an INFLOW (wrong direction)', () => {
    expect(classifyBankLine(line('u2', 'MONTHLY SERVICE CHARGE', 1500))).toBeNull();
  });

  it('does NOT propose interest for an OUTFLOW', () => {
    expect(classifyBankLine(line('u3', 'INTEREST', -100))).toBeNull();
  });

  it('does NOT treat a large unlabeled residual as FX/rounding (that would be a plug)', () => {
    expect(classifyBankLine(line('u4', 'unknown', -25000))).toBeNull();
  });

  it('ignores a zero-amount line', () => {
    expect(classifyBankLine(line('u5', 'SERVICE CHARGE', 0))).toBeNull();
  });
});

describe('draftAdjustmentProposals — partitions explainable vs unexplained', () => {
  it('splits proposals from the unexplained leftovers and never invents a plug', () => {
    const lines = [
      line('a', 'MONTHLY SERVICE FEE', -1200), // fee → proposal
      line('b', 'Interest Earned', 500), // interest → proposal
      line('c', 'ACH DEBIT VENDOR 88', -49000), // unexplained
      line('d', 'CHECK 1042', -22000), // unexplained
    ];
    const { proposals, unexplainedLineIds } = draftAdjustmentProposals(lines);
    expect(proposals.map((p) => p.sourceTransactionId).sort()).toEqual(['a', 'b']);
    expect(unexplainedLineIds.sort()).toEqual(['c', 'd']);
  });

  it('orders proposals by confidence then magnitude', () => {
    const lines = [
      line('small-fee', 'BANK FEE', -200),
      line('rounding', 'rounding adjustment', -3),
      line('big-fee', 'WIRE FEE', -4500),
    ];
    const { proposals } = draftAdjustmentProposals(lines);
    // fees (0.85) before rounding (0.55); within fees, larger first.
    expect(proposals.map((p) => p.sourceTransactionId)).toEqual(['big-fee', 'small-fee', 'rounding']);
  });
});
