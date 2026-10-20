/**
 * AIA G702 / G703 client math must equal the SQL (pm.generate_sov_billing, pm.v_pay_application,
 * pm.generate_progress_billing). Numbers from the 1102 migration harness (/home/claude/pmtest/out-money.txt):
 *   app #1: 21.0M gross · 2.1M retainage · 18.9M due (G702 4=21.0M 5a=1.9M 5b=0.2M 5=2.1M 6=18.9M 7=0 8=18.9M 9=81.1M)
 *   app #2: 39.5M · 3.95M · 35.55M · 18.9M · 16.65M (9=64.45M), line 2 stored 2M → 0.5M bills 3.5M
 */
import { describe, expect, it } from 'vitest';
import {
  decimalParts, extendCents, g702, g702FromView, g703FromStored, g703Line, previousApplications, priceFromMarkup, priorByLineage, progressPreview, ratio6, roundMul,
  type G703Prior,
} from '@/lib/pm/money/aia';
import { estimateLineValues } from '@/lib/pm/money/estimate-lines';

const ZERO: G703Prior = { previousWorkCents: 0, previousStoredCents: 0, previousRetainageCents: 0 };
const RATE = 0.1; // contract retention 10% (harness: "retention_pct":"0.1000")

describe('Postgres round(numeric) semantics', () => {
  it('rounds half away from zero on the decimal digits, not the float', () => {
    expect(roundMul(5, '0.5')).toBe(3);
    expect(roundMul(-5, '0.5')).toBe(-3);
    expect(roundMul(1999, 2.5)).toBe(4998);
    expect(roundMul(100, 1.005)).toBe(101); // Math.round(100 * 1.005) === 100
    expect(roundMul(60_000_000, 0.25)).toBe(15_000_000);
    expect(roundMul(40_000_000, 0.333333)).toBe(13_333_320);
  });
  it('parses plain and exponent decimals', () => {
    expect(decimalParts('0.1000')).toEqual({ num: 1000n, scale: 10000n });
    expect(decimalParts(1e-7).scale).toBe(10n ** 12n);
    expect(() => decimalParts('abc')).toThrow();
  });
  it('G ÷ C to six places like round(g::numeric / c, 6)', () => {
    expect(ratio6(9_500_000, 40_000_000)).toBe(0.2375);
    expect(ratio6(1, 3)).toBe(0.333333);
    expect(ratio6(2, 3)).toBe(0.666667);
    expect(ratio6(5, 0)).toBeNull();
  });
});

describe('G703 continuation sheet — application #1', () => {
  const l1 = g703Line({ scheduledCents: 60_000_000, rate: RATE, prior: ZERO, entry: { pctComplete: 0.25 } });
  const l2 = g703Line({ scheduledCents: 40_000_000, rate: RATE, prior: ZERO, entry: { pctComplete: 0.1, storedMaterialsCents: 2_000_000 } });

  it('line 1: E 15,000,000 · G 15,000,000 · 25% · H 45,000,000 · ret 1,500,000', () => {
    expect(l1).toMatchObject({ scheduled: 60_000_000, previous: 0, thisPeriod: 15_000_000, stored: 0, completedStored: 15_000_000, pct: 0.25, balance: 45_000_000, billed: 15_000_000 });
    expect([l1.retainageWorkToDate, l1.retainageStoredToDate, l1.retainageThisPeriod]).toEqual([1_500_000, 0, 1_500_000]);
    expect(l1.error).toBeNull();
  });

  it('line 2: E 4,000,000 + F 2,000,000 = 6,000,000 · 15% · H 34,000,000 · ret 400,000 + 200,000', () => {
    expect(l2).toMatchObject({ thisPeriod: 4_000_000, stored: 2_000_000, completedStored: 6_000_000, pct: 0.15, balance: 34_000_000, billed: 6_000_000 });
    expect([l2.retainageWorkToDate, l2.retainageStoredToDate, l2.retainageThisPeriod]).toEqual([400_000, 200_000, 600_000]);
  });

  it('G702 #1: 4=21.0M 5a=1.9M 5b=0.2M 5=2.1M 6=18.9M 7=0 8=18.9M 9=81.1M; request 21.0M − 2.1M = 18.9M', () => {
    const s = g702([l1, l2], { originalContractCents: 100_000_000, previousCertificatesCents: 0, previousRetainageHeldCents: 0 });
    expect(s).toEqual({
      originalContract: 100_000_000, netChangeByCo: 0, contractSumToDate: 100_000_000, completedStoredToDate: 21_000_000,
      retainageWork: 1_900_000, retainageStored: 200_000, retainageTotal: 2_100_000, earnedLessRetainage: 18_900_000,
      previousCertificates: 0, currentPaymentDue: 18_900_000, balanceToFinishInclRetainage: 81_100_000,
      grossThisPeriod: 21_000_000, retainageThisPeriod: 2_100_000, netThisPeriod: 18_900_000,
    });
  });
});

describe('G703 / G702 — application #2 from the stored lines of #1', () => {
  // billing_request_lines of app #1 as the generator wrote them, plus noise the generator ignores
  const app1 = { status: 'EMITTED', application_no: 1, created_at: '2026-09-30T12:00:00Z' };
  const stored = [
    { sov_lineage_id: 'L1', line_type: 'STANDARD', this_period_work_cents: 15_000_000, stored_materials_cents: 0, retainage_this_period_cents: 1_500_000, request: app1 },
    { sov_lineage_id: 'L2', line_type: 'STANDARD', this_period_work_cents: 4_000_000, stored_materials_cents: 2_000_000, retainage_this_period_cents: 600_000, request: app1 },
    { sov_lineage_id: null, line_type: 'RETAINAGE', this_period_work_cents: null, stored_materials_cents: null, retainage_this_period_cents: 0, request: app1 },
    { sov_lineage_id: 'L1', line_type: 'STANDARD', this_period_work_cents: 9_999_999, stored_materials_cents: 0, retainage_this_period_cents: 1, request: { status: 'VOID', application_no: 2, created_at: '2026-10-01T00:00:00Z' } },
    { sov_lineage_id: 'L2', line_type: 'STANDARD', this_period_work_cents: 1, stored_materials_cents: 7, retainage_this_period_cents: 1, request: { status: 'DRAFT', application_no: 2, created_at: '2026-10-02T00:00:00Z' } },
  ];
  const prior = priorByLineage(stored);

  it('previous work, stored and held retainage per lineage count only counted applications', () => {
    expect(prior.get('L1')).toEqual({ previousWorkCents: 15_000_000, previousStoredCents: 0, previousRetainageCents: 1_500_000 });
    expect(prior.get('L2')).toEqual({ previousWorkCents: 4_000_000, previousStoredCents: 2_000_000, previousRetainageCents: 600_000 });
  });

  const l1 = g703Line({ scheduledCents: 60_000_000, rate: RATE, prior: prior.get('L1')!, entry: { pctComplete: 0.5 } });
  const l2 = g703Line({ scheduledCents: 40_000_000, rate: RATE, prior: prior.get('L2')!, entry: { pctComplete: 0.225, storedMaterialsCents: 500_000 } });

  it('line 1: D 15M · E 15M · G 30M · H 30M · ret 1.5M', () => {
    expect(l1).toMatchObject({ previous: 15_000_000, thisPeriod: 15_000_000, stored: 0, completedStored: 30_000_000, balance: 30_000_000, billed: 15_000_000, pct: 0.5 });
    expect([l1.retainageWorkToDate, l1.retainageStoredToDate, l1.retainageThisPeriod]).toEqual([3_000_000, 0, 1_500_000]);
  });

  it('line 2: D 4M · E 5M · F 0.5M (was 2M) → billed 3.5M · G 9.5M · 23.75% · ret 950,000 − 600,000 = 350,000', () => {
    expect(l2).toMatchObject({ previous: 4_000_000, thisPeriod: 5_000_000, stored: 500_000, previousStored: 2_000_000, completedStored: 9_500_000, pct: 0.2375, balance: 30_500_000, billed: 3_500_000 });
    expect([l2.retainageWorkToDate, l2.retainageStoredToDate, l2.retainageThisPeriod]).toEqual([900_000, 50_000, 350_000]);
  });

  it('G702 #2: 4=39.5M 5=3.95M 6=35.55M 7=18.9M 8=16.65M 9=64.45M; request 18.5M − 1.85M = 16.65M', () => {
    const prev = previousApplications(
      [
        { id: 'a1', billing_subtype: 'SOV', status: 'ISSUED', application_no: 1, net_cents: 18_900_000, retainage_cents: 2_100_000 },
        { id: 'v', billing_subtype: 'SOV', status: 'VOID', application_no: 2, net_cents: 1, retainage_cents: 1 },
        { id: 'p', billing_subtype: null, status: 'ISSUED', application_no: null, net_cents: 5, retainage_cents: 5 },
      ],
      2,
    );
    expect(prev).toEqual({ previousCertificatesCents: 18_900_000, previousRetainageHeldCents: 2_100_000 });
    const s = g702([l1, l2], { originalContractCents: 100_000_000, ...prev });
    expect(s.completedStoredToDate).toBe(39_500_000);
    expect(s.retainageWork).toBe(3_900_000);
    expect(s.retainageStored).toBe(50_000);
    expect(s.retainageTotal).toBe(3_950_000);
    expect(s.earnedLessRetainage).toBe(35_550_000);
    expect(s.previousCertificates).toBe(18_900_000);
    expect(s.currentPaymentDue).toBe(16_650_000);
    expect(s.balanceToFinishInclRetainage).toBe(64_450_000);
    expect([s.grossThisPeriod, s.retainageThisPeriod, s.netThisPeriod]).toEqual([18_500_000, 1_850_000, 16_650_000]);
    expect(s.currentPaymentDue).toBe(s.netThisPeriod); // line 8 = the request's net (no retention cap)
  });

  it('the stored-line and view mappings give the same G702 the preview computed', () => {
    const view = {
      original_contract_cents: 100_000_000, net_change_by_co_cents: 0, contract_sum_to_date_cents: 100_000_000, total_completed_stored_cents: 39_500_000,
      retainage_work_cents: 3_900_000, retainage_stored_cents: 50_000, retainage_total_cents: 3_950_000, total_earned_less_retainage_cents: 35_550_000,
      previous_certificates_cents: 18_900_000, current_payment_due_cents: 16_650_000, balance_to_finish_incl_retainage_cents: 64_450_000,
    };
    const fromView = g702FromView(view, { gross_earned_cents: 18_500_000, retainage_cents: 1_850_000, net_cents: 16_650_000 });
    expect(fromView).toEqual(g702([l1, l2], { originalContractCents: 100_000_000, previousCertificatesCents: 18_900_000, previousRetainageHeldCents: 2_100_000 }));
    const back = g703FromStored({
      scheduled_value_cents: 40_000_000, previous_work_cents: 4_000_000, this_period_work_cents: 5_000_000, stored_materials_cents: 500_000, previous_stored_cents: 2_000_000,
      total_completed_cents: 9_500_000, pct_complete: 0.2375, balance_to_finish_cents: 30_500_000, amount_cents: 3_500_000,
      retainage_work_to_date_cents: 900_000, retainage_stored_to_date_cents: 50_000, retainage_this_period_cents: 350_000,
    });
    expect(back).toEqual(l2);
  });
});

describe('G703 entry rules (carry forward and errors, as the generator raises them)', () => {
  const prior: G703Prior = { previousWorkCents: 4_000_000, previousStoredCents: 2_000_000, previousRetainageCents: 600_000 };
  it('an omitted line carries forward: E 0, F = F′, nothing billed', () => {
    const l = g703Line({ scheduledCents: 40_000_000, rate: RATE, prior, entry: null });
    expect(l).toMatchObject({ thisPeriod: 0, stored: 2_000_000, billed: 0, retainageThisPeriod: 0 });
  });
  it('work to date and this period are alternatives to percent', () => {
    expect(g703Line({ scheduledCents: 40_000_000, rate: RATE, prior, entry: { workToDateCents: 9_000_000 } }).thisPeriod).toBe(5_000_000);
    expect(g703Line({ scheduledCents: 40_000_000, rate: RATE, prior, entry: { thisPeriodCents: 1_000_000 } }).thisPeriod).toBe(1_000_000);
  });
  it('PM_SOV_OVER_SCHEDULED, PM_SOV_NEGATIVE and PM_SOV_PCT have client equivalents', () => {
    expect(g703Line({ scheduledCents: 40_000_000, rate: RATE, prior, entry: { pctComplete: 1, storedMaterialsCents: 1 } }).error).toBe('OVER_SCHEDULED');
    expect(g703Line({ scheduledCents: 40_000_000, rate: RATE, prior, entry: { thisPeriodCents: -5_000_000 } }).error).toBe('NEGATIVE');
    expect(g703Line({ scheduledCents: 40_000_000, rate: RATE, prior, entry: { pctComplete: 1.2 } }).error).toBe('PCT_RANGE');
  });
});

describe('progress % billing (pm.generate_progress_billing)', () => {
  it('standalone harness: 40% × 5,000,000 = 2,000,000; then 100% bills the remaining 3,000,000', () => {
    const a = progressPreview({ revisedContractCents: 5_000_000, pct: 0.4, billedToDateCents: 0, rate: 0, heldToDateCents: 0 });
    expect(a).toMatchObject({ earnedToDate: 2_000_000, thisBill: 2_000_000, retainageThisPeriod: 0, net: 2_000_000, nothing: false });
    const b = progressPreview({ revisedContractCents: 5_000_000, pct: 1, billedToDateCents: 2_000_000, rate: 0, heldToDateCents: 0 });
    expect(b.thisBill).toBe(3_000_000);
  });
  it('retainage this period = round(earned × rate) − held to date', () => {
    const r = progressPreview({ revisedContractCents: 5_000_000, pct: 0.6, billedToDateCents: 2_000_000, rate: '0.1000', heldToDateCents: 200_000 });
    expect(r).toMatchObject({ earnedToDate: 3_000_000, thisBill: 1_000_000, retainageThisPeriod: 100_000, net: 900_000 });
  });
  it('never bills past earned (PRECONDITION_NOTHING_TO_BILL)', () => {
    expect(progressPreview({ revisedContractCents: 5_000_000, pct: 0.3, billedToDateCents: 2_000_000, rate: 0, heldToDateCents: 0 }).nothing).toBe(true);
  });
});

describe('estimate and commitment line extension (trigger rounding)', () => {
  it('qty × unit cost → cost; markup sets the unit price; qty × price → amount', () => {
    expect(extendCents('12.5', 1999)).toBe(24_988);
    expect(priceFromMarkup(1999, 0.2)).toBe(2399);
    expect(estimateLineValues({ qty: '12.5', unitCostCents: 1999, unitPriceCents: null, markupPct: 0.2, costCents: null, amountCents: null }))
      .toEqual({ qty: '12.5', unit_cost_cents: 1999, unit_price_cents: 2399, cost_cents: 24_988, amount_cents: 29_988, markup: 0.2 });
  });
  it('lump sums: cost plus markup, or the amount typed', () => {
    expect(estimateLineValues({ qty: null, unitCostCents: null, unitPriceCents: null, markupPct: 0.15, costCents: 100_000, amountCents: null }).amount_cents).toBe(115_000);
    expect(estimateLineValues({ qty: null, unitCostCents: null, unitPriceCents: null, markupPct: null, costCents: null, amountCents: 50_000 }))
      .toMatchObject({ cost_cents: null, amount_cents: 50_000, markup: null });
  });
  it('an explicit unit price wins over markup', () => {
    expect(estimateLineValues({ qty: '2', unitCostCents: 1000, unitPriceCents: 1500, markupPct: 0.9, costCents: null, amountCents: null }).amount_cents).toBe(3000);
  });
});
