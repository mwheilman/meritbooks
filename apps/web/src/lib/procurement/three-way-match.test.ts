import { describe, it, expect } from 'vitest';
import {
  runThreeWayMatch,
  DEFAULT_TOLERANCE,
  type PoLineInput,
  type BillLineInput,
} from './three-way-match';

// Helpers to build lines tersely.
function po(partial: Partial<PoLineInput> & { id: string }): PoLineInput {
  return {
    id: partial.id,
    description: partial.description ?? 'Widget',
    accountId: partial.accountId ?? 'acct-1',
    itemId: partial.itemId ?? null,
    orderedQty: partial.orderedQty ?? 10,
    unitCostCents: partial.unitCostCents ?? 1000,
    receivedQty: partial.receivedQty ?? 10,
  };
}
function bill(partial: Partial<BillLineInput> & { id: string }): BillLineInput {
  const billedQty = partial.billedQty ?? 10;
  const unitCostCents = partial.unitCostCents ?? 1000;
  return {
    id: partial.id,
    description: partial.description ?? 'Widget',
    accountId: partial.accountId ?? 'acct-1',
    itemId: partial.itemId ?? null,
    billedQty,
    unitCostCents,
    amountCents: partial.amountCents ?? Math.round(billedQty * unitCostCents),
  };
}

describe('runThreeWayMatch', () => {
  it('PASSES a clean match (ordered = received = billed, price within tolerance)', () => {
    const res = runThreeWayMatch({
      poLines: [po({ id: 'p1', orderedQty: 10, receivedQty: 10, unitCostCents: 1000 })],
      billLines: [bill({ id: 'b1', billedQty: 10, unitCostCents: 1000 })],
    });
    expect(res.verdict).toBe('PASS');
    expect(res.amountAtRiskCents).toBe(0);
    expect(res.lines[0].verdict).toBe('PASS');
    expect(res.flags).not.toContain('PRICE_VARIANCE');
    expect(res.totals.billedCents).toBe(10000);
  });

  it('PASSES a price difference within the 5% tolerance band', () => {
    // PO $10.00, bill $10.40 = 4% > absolute but < 5% → pass.
    const res = runThreeWayMatch({
      poLines: [po({ id: 'p1', unitCostCents: 1000 })],
      billLines: [bill({ id: 'b1', unitCostCents: 1040 })],
    });
    expect(res.verdict).toBe('PASS');
    expect(res.lines[0].priceVarianceCents).toBe(40);
    expect(res.lines[0].flags).not.toContain('PRICE_VARIANCE');
  });

  it('flags PRICE_VARIANCE beyond tolerance and quantifies the overcharge', () => {
    // PO $10.00, bill $11.00 = 10% > 5% tolerance; 10 units → $10.00 at risk.
    const res = runThreeWayMatch({
      poLines: [po({ id: 'p1', unitCostCents: 1000, orderedQty: 10, receivedQty: 10 })],
      billLines: [bill({ id: 'b1', unitCostCents: 1100, billedQty: 10 })],
    });
    expect(res.verdict).toBe('EXCEPTION');
    expect(res.lines[0].flags).toContain('PRICE_VARIANCE');
    expect(res.lines[0].priceVarianceCents).toBe(100);
    expect(res.amountAtRiskCents).toBe(1000);
    expect(res.reasons[0]).toMatch(/PO price/);
  });

  it('flags OVER_BILL when billed qty exceeds received qty', () => {
    // Ordered 10, received 6, billed 10 → over-billed 4 units × $10 = $40 at risk.
    const res = runThreeWayMatch({
      poLines: [po({ id: 'p1', orderedQty: 10, receivedQty: 6, unitCostCents: 1000 })],
      billLines: [bill({ id: 'b1', billedQty: 10, unitCostCents: 1000 })],
    });
    expect(res.verdict).toBe('EXCEPTION');
    expect(res.lines[0].flags).toContain('OVER_BILL');
    expect(res.amountAtRiskCents).toBe(4000);
  });

  it('flags QTY_NOT_YET_RECEIVED when billing precedes any receipt', () => {
    const res = runThreeWayMatch({
      poLines: [po({ id: 'p1', orderedQty: 10, receivedQty: 0, unitCostCents: 1000 })],
      billLines: [bill({ id: 'b1', billedQty: 10, unitCostCents: 1000 })],
    });
    expect(res.verdict).toBe('EXCEPTION');
    expect(res.lines[0].flags).toContain('QTY_NOT_YET_RECEIVED');
    expect(res.lines[0].flags).not.toContain('OVER_BILL');
  });

  it('flags OVER_RECEIPT when received exceeds ordered', () => {
    // Ordered 10, received 12, billed 10 (within received) → over-receipt only.
    const res = runThreeWayMatch({
      poLines: [po({ id: 'p1', orderedQty: 10, receivedQty: 12, unitCostCents: 1000 })],
      billLines: [bill({ id: 'b1', billedQty: 10, unitCostCents: 1000 })],
    });
    expect(res.verdict).toBe('EXCEPTION');
    expect(res.lines[0].flags).toContain('OVER_RECEIPT');
  });

  it('treats a partial delivery (billed only for what arrived) as PASS with UNDER_RECEIPT', () => {
    // Ordered 10, received 6, billed 6 → under-receipt is informational, not a fail.
    const res = runThreeWayMatch({
      poLines: [po({ id: 'p1', orderedQty: 10, receivedQty: 6, unitCostCents: 1000 })],
      billLines: [bill({ id: 'b1', billedQty: 6, unitCostCents: 1000 })],
    });
    expect(res.verdict).toBe('PASS');
    expect(res.lines[0].flags).toContain('UNDER_RECEIPT');
    expect(res.amountAtRiskCents).toBe(0);
  });

  it('flags UNMATCHED_BILL_LINE when a bill line has no PO counterpart', () => {
    const res = runThreeWayMatch({
      poLines: [po({ id: 'p1', accountId: 'acct-1', itemId: null })],
      billLines: [
        bill({ id: 'b1', accountId: 'acct-1' }),
        bill({ id: 'b2', accountId: 'acct-ZZZ', description: 'Surprise fee', amountCents: 5000 }),
      ],
    });
    expect(res.verdict).toBe('EXCEPTION');
    const unmatched = res.lines.find((l) => l.billLineId === 'b2');
    expect(unmatched?.flags).toContain('UNMATCHED_BILL_LINE');
    expect(res.amountAtRiskCents).toBe(5000);
  });

  it('matches on item_id in preference to account_id', () => {
    const res = runThreeWayMatch({
      poLines: [
        po({ id: 'p1', itemId: 'item-A', accountId: 'acct-1', unitCostCents: 1000, orderedQty: 5, receivedQty: 5 }),
        po({ id: 'p2', itemId: 'item-B', accountId: 'acct-1', unitCostCents: 2000, orderedQty: 5, receivedQty: 5 }),
      ],
      billLines: [bill({ id: 'b1', itemId: 'item-B', accountId: 'acct-1', unitCostCents: 2000, billedQty: 5 })],
    });
    expect(res.verdict).toBe('PASS');
    expect(res.lines[0].poLineId).toBe('p2');
  });

  it('respects a tightened custom price tolerance', () => {
    // 4% variance passes at 5% default but fails at a 2% tolerance.
    const input = {
      poLines: [po({ id: 'p1', unitCostCents: 1000 })],
      billLines: [bill({ id: 'b1', unitCostCents: 1040 })],
    };
    expect(runThreeWayMatch(input).verdict).toBe('PASS');
    expect(runThreeWayMatch({ ...input, tolerance: { pricePct: 0.02 } }).verdict).toBe('EXCEPTION');
  });

  it('rolls up ordered / received / billed totals in cents', () => {
    const res = runThreeWayMatch({
      poLines: [
        po({ id: 'p1', orderedQty: 10, receivedQty: 8, unitCostCents: 1000 }),
        po({ id: 'p2', orderedQty: 4, receivedQty: 4, unitCostCents: 2500, accountId: 'acct-2' }),
      ],
      billLines: [
        bill({ id: 'b1', billedQty: 8, unitCostCents: 1000 }),
        bill({ id: 'b2', billedQty: 4, unitCostCents: 2500, accountId: 'acct-2' }),
      ],
    });
    expect(res.totals.orderedCents).toBe(10 * 1000 + 4 * 2500); // 20000
    expect(res.totals.receivedCents).toBe(8 * 1000 + 4 * 2500); // 18000
    expect(res.totals.billedCents).toBe(8 * 1000 + 4 * 2500); // 18000
    expect(res.verdict).toBe('PASS');
  });

  it('uses the documented default tolerance', () => {
    expect(DEFAULT_TOLERANCE.pricePct).toBe(0.05);
  });
});
