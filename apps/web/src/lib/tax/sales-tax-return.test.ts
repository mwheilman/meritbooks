import { describe, it, expect } from 'vitest';
import {
  classifySale,
  aggregateByJurisdiction,
  effectiveRatePct,
  reconcileRate,
  reconcileToGl,
  buildReturnLine,
  buildWorksheet,
  SALES_TAX_TUNABLES,
  type ReturnInvoice,
} from './sales-tax-return';

// ── Fixtures ────────────────────────────────────────────────────────────────
// A small deterministic book of invoices across two states, mixing taxable,
// exempt, and non-taxable sales, with a known expected rate on the taxable ones.
function inv(partial: Partial<ReturnInvoice> & Pick<ReturnInvoice, 'invoiceId' | 'state' | 'grossSalesCents' | 'taxCents'>): ReturnInvoice {
  return {
    invoiceNumber: partial.invoiceId,
    source: partial.source ?? 'ship_to',
    localJurisdiction: partial.localJurisdiction ?? null,
    customerExempt: partial.customerExempt ?? false,
    expectedRatePct: partial.expectedRatePct ?? null,
    period: partial.period ?? '2026-03',
    ...partial,
  };
}

describe('classifySale', () => {
  it('is EXEMPT when the customer is tax-exempt, regardless of tax charged', () => {
    expect(classifySale({ customerExempt: true, taxCents: 0 })).toBe('EXEMPT');
    expect(classifySale({ customerExempt: true, taxCents: 500 })).toBe('EXEMPT');
  });
  it('is TAXABLE when tax was charged and the customer is not exempt', () => {
    expect(classifySale({ customerExempt: false, taxCents: 700 })).toBe('TAXABLE');
  });
  it('is NON_TAXABLE when no tax charged and not exempt', () => {
    expect(classifySale({ customerExempt: false, taxCents: 0 })).toBe('NON_TAXABLE');
  });
});

describe('aggregateByJurisdiction', () => {
  const invoices: ReturnInvoice[] = [
    // IA: taxable $1,000 @ 7% = $70 tax
    inv({ invoiceId: 'A', state: 'IA', grossSalesCents: 100_000, taxCents: 7_000, expectedRatePct: 7 }),
    // IA: taxable $2,000 @ 7% = $140 tax
    inv({ invoiceId: 'B', state: 'IA', grossSalesCents: 200_000, taxCents: 14_000, expectedRatePct: 7 }),
    // IA: exempt resale $5,000, no tax
    inv({ invoiceId: 'C', state: 'IA', grossSalesCents: 500_000, taxCents: 0, customerExempt: true }),
    // IA: non-taxable service $800, no tax, customer HQ fallback
    inv({ invoiceId: 'D', state: 'IA', grossSalesCents: 80_000, taxCents: 0, source: 'customer' }),
    // TX: taxable $10,000 @ 6.25% = $625, attributed by customer HQ (fallback)
    inv({ invoiceId: 'E', state: 'TX', grossSalesCents: 1_000_000, taxCents: 62_500, expectedRatePct: 6.25, source: 'customer' }),
    // unattributed — dropped
    inv({ invoiceId: 'F', state: null, grossSalesCents: 999_999, taxCents: 1 }),
  ];

  const byState = aggregateByJurisdiction(invoices);

  it('drops invoices with no resolvable state', () => {
    expect(byState.has('IA')).toBe(true);
    expect(byState.has('TX')).toBe(true);
    expect(byState.size).toBe(2);
  });

  it('splits taxable / exempt / non-taxable and sums gross + tax for IA', () => {
    const ia = byState.get('IA')!;
    expect(ia.grossSalesCents).toBe(100_000 + 200_000 + 500_000 + 80_000);
    expect(ia.taxableSalesCents).toBe(300_000);
    expect(ia.exemptSalesCents).toBe(500_000);
    expect(ia.nonTaxableSalesCents).toBe(80_000);
    expect(ia.taxCollectedCents).toBe(21_000);
    expect(ia.txnCount).toBe(4);
    expect(ia.taxableTxnCount).toBe(2);
    expect(ia.exemptTxnCount).toBe(1);
  });

  it('accumulates the expected-tax basis from the rated taxable sales', () => {
    const ia = byState.get('IA')!;
    expect(ia.ratedSalesCents).toBe(300_000);
    // 100000*7% + 200000*7% = 7000 + 14000
    expect(ia.expectedTaxCents).toBe(21_000);
  });

  it('tracks the customer-HQ fallback share only on the taxable base', () => {
    const ia = byState.get('IA')!;
    // only the non-taxable D used the fallback; it is NOT in taxable base
    expect(ia.fallbackSalesCents).toBe(0);
    const tx = byState.get('TX')!;
    expect(tx.fallbackSalesCents).toBe(1_000_000);
  });
});

describe('effectiveRatePct', () => {
  it('is tax collected over the taxable base', () => {
    expect(effectiveRatePct({ taxCollectedCents: 21_000, taxableSalesCents: 300_000 })).toBe(7);
  });
  it('is 0 when there is no taxable base', () => {
    expect(effectiveRatePct({ taxCollectedCents: 0, taxableSalesCents: 0 })).toBe(0);
  });
});

describe('reconcileRate', () => {
  it('reconciles cleanly when collected == expected at the statutory rate', () => {
    const r = reconcileRate({ taxCollectedCents: 21_000, taxableSalesCents: 300_000, ratedSalesCents: 300_000, expectedTaxCents: 21_000 });
    expect(r.hasExpectedRate).toBe(true);
    expect(r.expectedRatePct).toBe(7);
    expect(r.varianceCents).toBe(0);
    expect(r.flagged).toBe(false);
  });

  it('flags an under-collection beyond tolerance', () => {
    // taxable 300000 @7% should be 21000; only 15000 collected → 6000 short
    const r = reconcileRate({ taxCollectedCents: 15_000, taxableSalesCents: 300_000, ratedSalesCents: 300_000, expectedTaxCents: 21_000 });
    expect(r.varianceCents).toBe(-6_000);
    expect(r.flagged).toBe(true);
  });

  it('does not flag a penny-level rounding difference', () => {
    const r = reconcileRate({ taxCollectedCents: 21_050, taxableSalesCents: 300_000, ratedSalesCents: 300_000, expectedTaxCents: 21_000 });
    // 50c variance, tolerance = max($1, 0.5% of 300000=1500) → within tolerance
    expect(r.flagged).toBe(false);
  });

  it('cannot judge over/under when no expected rate is known', () => {
    const r = reconcileRate({ taxCollectedCents: 9_999, taxableSalesCents: 100_000, ratedSalesCents: 0, expectedTaxCents: 0 });
    expect(r.hasExpectedRate).toBe(false);
    expect(r.flagged).toBe(false);
    expect(r.expectedRatePct).toBeNull();
  });
});

describe('reconcileToGl', () => {
  it('reconciles when worksheet matches the GL net credit', () => {
    const r = reconcileToGl(83_500, 83_500);
    expect(r.varianceCents).toBe(0);
    expect(r.reconciled).toBe(true);
  });
  it('flags a variance when an invoice tax leg never posted', () => {
    const r = reconcileToGl(83_500, 70_000);
    expect(r.varianceCents).toBe(13_500);
    expect(r.reconciled).toBe(false);
  });
  it('tolerates penny rounding within $1', () => {
    expect(reconcileToGl(83_500, 83_300).reconciled).toBe(false); // $2 variance
    expect(reconcileToGl(83_500, 83_450).reconciled).toBe(true); // 50c within $1
  });
});

describe('buildReturnLine', () => {
  it('rolls exempt + non-taxable into a single deductions figure', () => {
    const byState = aggregateByJurisdiction([
      inv({ invoiceId: 'A', state: 'IA', grossSalesCents: 100_000, taxCents: 7_000, expectedRatePct: 7 }),
      inv({ invoiceId: 'C', state: 'IA', grossSalesCents: 500_000, taxCents: 0, customerExempt: true }),
      inv({ invoiceId: 'D', state: 'IA', grossSalesCents: 80_000, taxCents: 0 }),
    ]);
    const line = buildReturnLine(byState.get('IA')!);
    expect(line.taxableSalesCents).toBe(100_000);
    expect(line.deductionsCents).toBe(580_000);
    expect(line.exemptSalesCents).toBe(500_000);
    expect(line.nonTaxableSalesCents).toBe(80_000);
    expect(line.taxCollectedCents).toBe(7_000);
    expect(line.effectiveRatePct).toBe(7);
  });
});

describe('buildWorksheet', () => {
  const invoices: ReturnInvoice[] = [
    inv({ invoiceId: 'A', state: 'IA', grossSalesCents: 100_000, taxCents: 7_000, expectedRatePct: 7 }),
    inv({ invoiceId: 'B', state: 'IA', grossSalesCents: 200_000, taxCents: 14_000, expectedRatePct: 7 }),
    inv({ invoiceId: 'E', state: 'TX', grossSalesCents: 1_000_000, taxCents: 62_500, expectedRatePct: 6.25 }),
  ];

  it('sorts jurisdictions by tax liability descending and totals correctly', () => {
    const { lines, totals } = buildWorksheet(invoices);
    expect(lines.map((l) => l.jurisdiction)).toEqual(['TX', 'IA']);
    expect(totals.jurisdictionCount).toBe(2);
    expect(totals.taxCollectedCents).toBe(7_000 + 14_000 + 62_500);
    expect(totals.taxableSalesCents).toBe(100_000 + 200_000 + 1_000_000);
    expect(totals.rateFlaggedCount).toBe(0);
  });

  it('filters to a single jurisdiction when requested', () => {
    const { lines, totals } = buildWorksheet(invoices, { jurisdiction: 'IA' });
    expect(lines).toHaveLength(1);
    expect(lines[0].jurisdiction).toBe('IA');
    expect(totals.taxCollectedCents).toBe(21_000);
  });

  it('accepts a full state name for the jurisdiction filter', () => {
    const { lines } = buildWorksheet(invoices, { jurisdiction: 'texas' });
    expect(lines).toHaveLength(1);
    expect(lines[0].jurisdiction).toBe('TX');
  });

  it('counts a rate-flagged jurisdiction in totals', () => {
    // TX taxable 1,000,000 @6.25% should be 62,500; charge only 40,000 → flagged
    const under = [inv({ invoiceId: 'E', state: 'TX', grossSalesCents: 1_000_000, taxCents: 40_000, expectedRatePct: 6.25 })];
    const { totals, lines } = buildWorksheet(under);
    expect(lines[0].rateFlagged).toBe(true);
    expect(totals.rateFlaggedCount).toBe(1);
  });
});

describe('SALES_TAX_TUNABLES', () => {
  it('exposes a $1 absolute tolerance', () => {
    expect(SALES_TAX_TUNABLES.toleranceCents).toBe(100);
  });
});
