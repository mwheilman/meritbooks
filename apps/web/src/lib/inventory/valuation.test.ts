import { describe, it, expect } from 'vitest';
import {
  emptyState,
  applyReceipt,
  applyIssue,
  applyAdjust,
  applyMovement,
  unitAverageCents,
  ValuationError,
  type ValuationState,
} from './valuation';

describe('weighted-average valuation', () => {
  it('a receipt increases qty and value and blends the average', () => {
    let s = emptyState();
    s = applyReceipt(s, 10, 100_00).state; // 10 @ $10.00
    expect(s.qty_on_hand).toBe(10);
    expect(s.total_value_cents).toBe(100_00);
    expect(unitAverageCents(s)).toBe(10_00);

    s = applyReceipt(s, 10, 200_00).state; // 10 @ $20.00 → blended $15.00
    expect(s.qty_on_hand).toBe(20);
    expect(s.total_value_cents).toBe(300_00);
    expect(unitAverageCents(s)).toBe(15_00);
  });

  it('an issue removes at the current average and reports COGS', () => {
    let s = emptyState();
    s = applyReceipt(s, 10, 100_00).state;
    s = applyReceipt(s, 10, 200_00).state; // avg $15.00
    const issue = applyIssue('WEIGHTED_AVG', s, 5);
    expect(issue.cogs_cents).toBe(75_00); // 5 @ $15.00
    expect(issue.unit_cost_cents).toBe(15_00);
    expect(issue.state.qty_on_hand).toBe(15);
    expect(issue.state.total_value_cents).toBe(225_00);
    expect(unitAverageCents(issue.state)).toBe(15_00);
  });

  it('a full issue clears value exactly (no rounding residue)', () => {
    let s = emptyState();
    s = applyReceipt(s, 3, 100_00).state; // avg 3333.33c → 3334/3333/3333 style
    const issue = applyIssue('WEIGHTED_AVG', s, 3);
    expect(issue.cogs_cents).toBe(100_00);
    expect(issue.state.qty_on_hand).toBe(0);
    expect(issue.state.total_value_cents).toBe(0);
    expect(issue.state.fifo_layers).toEqual([]);
  });

  it('value + COGS always reconciles across a partial issue with an ugly average', () => {
    let s = emptyState();
    s = applyReceipt(s, 7, 100_00).state; // 10000/7 = 1428.57c avg
    const before = s.total_value_cents;
    const issue = applyIssue('WEIGHTED_AVG', s, 2);
    expect(issue.state.total_value_cents + issue.cogs_cents).toBe(before);
  });

  it('refuses to issue more than is on hand (no negative inventory)', () => {
    let s = emptyState();
    s = applyReceipt(s, 5, 50_00).state;
    expect(() => applyIssue('WEIGHTED_AVG', s, 6)).toThrow(ValuationError);
  });
});

describe('FIFO valuation', () => {
  it('consumes the oldest layer first and prices COGS at that layer cost', () => {
    let s = emptyState();
    s = applyReceipt(s, 10, 100_00).state; // layer A: 10 @ $10
    s = applyReceipt(s, 10, 200_00).state; // layer B: 10 @ $20

    // Issue 15: 10 from A ($100) + 5 from B ($100) = $200 COGS.
    const issue = applyIssue('FIFO', s, 15);
    expect(issue.cogs_cents).toBe(200_00);
    expect(issue.state.qty_on_hand).toBe(5);
    expect(issue.state.total_value_cents).toBe(100_00); // 5 @ $20 left
    expect(issue.state.fifo_layers).toHaveLength(1);
    expect(issue.state.fifo_layers[0]).toEqual({ qty: 5, value_cents: 100_00 });
  });

  it('differs from weighted-average on the same history (the point of FIFO)', () => {
    const build = (): ValuationState => {
      let s = emptyState();
      s = applyReceipt(s, 10, 100_00).state; // $10
      s = applyReceipt(s, 10, 200_00).state; // $20
      return s;
    };
    const fifo = applyIssue('FIFO', build(), 10).cogs_cents; // oldest 10 @ $10 = $100
    const wavg = applyIssue('WEIGHTED_AVG', build(), 10).cogs_cents; // 10 @ $15 = $150
    expect(fifo).toBe(100_00);
    expect(wavg).toBe(150_00);
    expect(fifo).not.toBe(wavg);
  });

  it('partial layer consumption keeps integer cents and reconciles', () => {
    let s = emptyState();
    s = applyReceipt(s, 3, 100_00).state; // 3 @ 3333.33c
    const issue = applyIssue('FIFO', s, 1);
    expect(Number.isInteger(issue.cogs_cents)).toBe(true);
    expect(issue.state.total_value_cents + issue.cogs_cents).toBe(100_00);
    expect(issue.state.qty_on_hand).toBe(2);
  });

  it('refuses to over-issue', () => {
    let s = emptyState();
    s = applyReceipt(s, 4, 40_00).state;
    expect(() => applyIssue('FIFO', s, 5)).toThrow(ValuationError);
  });
});

describe('adjustments', () => {
  it('a positive adjustment behaves like a costed receipt', () => {
    let s = emptyState();
    s = applyReceipt(s, 10, 100_00).state;
    const adj = applyAdjust('WEIGHTED_AVG', s, 2, 12_00); // +2 @ $12
    expect(adj.cogs_cents).toBe(0);
    expect(adj.state.qty_on_hand).toBe(12);
    expect(adj.state.total_value_cents).toBe(124_00);
  });

  it('a negative adjustment (shrinkage) realizes COGS at cost', () => {
    let s = emptyState();
    s = applyReceipt(s, 10, 100_00).state;
    const adj = applyAdjust('WEIGHTED_AVG', s, -2);
    expect(adj.cogs_cents).toBe(20_00);
    expect(adj.state.qty_on_hand).toBe(8);
    expect(adj.state.total_value_cents).toBe(80_00);
  });

  it('a positive adjustment without a unit cost is refused', () => {
    const s = applyReceipt(emptyState(), 1, 10_00).state;
    expect(() => applyAdjust('WEIGHTED_AVG', s, 3)).toThrow(ValuationError);
  });
});

describe('applyMovement dispatch', () => {
  it('routes RECEIPT / ISSUE / ADJUST to the right primitive', () => {
    let s = emptyState();
    s = applyMovement('FIFO', s, { type: 'RECEIPT', qty: 5, totalCostCents: 50_00 }).state;
    expect(s.qty_on_hand).toBe(5);
    const issued = applyMovement('FIFO', s, { type: 'ISSUE', qty: 2 });
    expect(issued.cogs_cents).toBe(20_00);
    const adjusted = applyMovement('WEIGHTED_AVG', s, { type: 'ADJUST', qty: -1 });
    expect(adjusted.cogs_cents).toBe(10_00);
  });

  it('a RECEIPT with no cost is refused', () => {
    expect(() => applyMovement('FIFO', emptyState(), { type: 'RECEIPT', qty: 1 })).toThrow(ValuationError);
  });
});
