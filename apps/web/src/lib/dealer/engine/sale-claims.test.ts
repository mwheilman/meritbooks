import { describe, it, expect } from 'vitest';
import { dealPlan, valueTradeIn, costOfSalePlan, depositApplicationPlan, lienPayoffPlan, dealReceivable } from './sale';
import {
  computeClaim,
  recognitionPlan,
  receivableSettlementPlan,
  warrantyWriteOffPlan,
  warrantyDebitPlan,
  statusAfterSettlement,
  assertClaimFoots,
  assertSettleable,
} from './warranty';
import { incentiveAccrualPlan, incentiveWriteOffPlan, defaultTreatment } from './incentive';
import { canonicalLines, assertBalanced, netByRole, totals } from '../journal';

const lines = (p: Parameters<typeof canonicalLines>[0]) => canonicalLines(p).map((l) => [l.role, l.debitCents, l.creditCents]);
const NEW_UNIT = { inventoryRole: 'WHOLE_GOODS_INVENTORY' as const, condition: 'NEW', departmentRole: 'WG_NEW' as const };

describe('unit sale (FPB §3.4, AC5)', () => {
  it('deal + deposit application nets to the FPB lines exactly', () => {
    const deal = dealPlan({ unit: NEW_UNIT, salePriceCents: 1_350_000, taxCents: 0, retailRebateCents: 0, trade: null, costCents: 1_040_000, memo: 'U-1' });
    expect(deal.receivableCents).toBe(1_350_000);
    assertBalanced(deal.plan);
    const net = netByRole([deal.plan, depositApplicationPlan(100_000, 'WG_NEW')]);
    expect(Object.fromEntries(net)).toEqual({
      CUSTOMER_DEPOSITS: 100_000,
      AR_CONTROL: 1_250_000,
      WHOLE_GOODS_SALES: -1_350_000,
      WHOLE_GOODS_COGS: 1_040_000,
      WHOLE_GOODS_INVENTORY: -1_040_000,
    });
  });

  it('sales tax goes to the invoice receivable and sales tax payable', () => {
    const deal = dealPlan({ unit: NEW_UNIT, salePriceCents: 1_000_000, taxCents: 70_000, retailRebateCents: 0, trade: null, costCents: 800_000, memo: 't' });
    expect(deal.receivableCents).toBe(1_070_000);
    expect(lines(deal.plan)).toContainEqual(['SALES_TAX_PAYABLE', 0, 70_000]);
  });

  it('a used unit sells through used sales / used COGS', () => {
    const deal = dealPlan({
      unit: { inventoryRole: 'USED_WHOLE_GOODS_INVENTORY', condition: 'USED', departmentRole: 'WG_USED' },
      salePriceCents: 300_000, taxCents: 0, retailRebateCents: 0, trade: null, costCents: 250_000, memo: 'used',
    });
    expect(lines(deal.plan)).toEqual([
      ['AR_CONTROL', 300_000, 0],
      ['USED_GOODS_SALES', 0, 300_000],
      ['USED_GOODS_COGS', 250_000, 0],
      ['USED_WHOLE_GOODS_INVENTORY', 0, 250_000],
    ]);
  });

  it('BOOKS_INVOICE mode relieves cost only', () => {
    expect(lines(costOfSalePlan({ unit: NEW_UNIT, costCents: 1_040_000, memo: 'inv' }))).toEqual([
      ['WHOLE_GOODS_COGS', 1_040_000, 0],
      ['WHOLE_GOODS_INVENTORY', 0, 1_040_000],
    ]);
  });

  it('retail rebate (transaction price) replaces part of AR (FPB §3.9, AC10)', () => {
    const deal = dealPlan({ unit: NEW_UNIT, salePriceCents: 1_350_000, taxCents: 0, retailRebateCents: 50_000, trade: null, costCents: 1_040_000, memo: 'r' });
    expect(lines(deal.plan).slice(0, 3)).toEqual([
      ['AR_CONTROL', 1_300_000, 0],
      ['OEM_INCENTIVE_RECEIVABLE', 50_000, 0],
      ['WHOLE_GOODS_SALES', 0, 1_350_000],
    ]);
  });
});

describe('trade-in (FPB §3.5, AC7)', () => {
  const valuation = valueTradeIn({ allowanceCents: 300_000, acvCents: 250_000, policy: 'LOWER_OF_ACV_AND_ALLOWANCE' });

  it('values the trade at the lower of ACV and allowance', () => {
    expect(valuation).toEqual({ recordedValueCents: 250_000, overAllowanceCents: 50_000, underAllowanceCents: 0 });
    expect(valueTradeIn({ allowanceCents: 200_000, acvCents: 250_000, policy: 'LOWER_OF_ACV_AND_ALLOWANCE' }).underAllowanceCents).toBe(0);
    expect(valueTradeIn({ allowanceCents: 200_000, acvCents: 250_000, policy: 'ACV' })).toEqual({
      recordedValueCents: 250_000, overAllowanceCents: 0, underAllowanceCents: 50_000,
    });
    expect(valueTradeIn({ allowanceCents: 300_000, acvCents: 250_000, policy: 'ALLOWANCE' }).recordedValueCents).toBe(300_000);
  });

  it('posts the five deal lines that balance at 1,470,000, plus cost of sale', () => {
    const deal = dealPlan({
      unit: NEW_UNIT, salePriceCents: 1_350_000, taxCents: 0, retailRebateCents: 0,
      trade: { allowanceCents: 300_000, valuation, lienPayoffCents: 120_000 }, costCents: 1_040_000, memo: 'trade',
    });
    expect(deal.receivableCents).toBe(1_170_000);
    const all = lines(deal.plan);
    const dealLines = all.filter(([role]) => role !== 'WHOLE_GOODS_COGS' && role !== 'WHOLE_GOODS_INVENTORY');
    expect(dealLines).toEqual([
      ['AR_CONTROL', 1_170_000, 0],
      ['WHOLE_GOODS_SALES', 0, 1_350_000],
      ['USED_WHOLE_GOODS_INVENTORY', 250_000, 0],
      ['TRADE_IN_OVER_ALLOWANCE', 50_000, 0],
      ['TRADE_LIEN_PAYOFF', 0, 120_000],
    ]);
    const t = dealLines.reduce((s, [, d, c]) => ({ d: s.d + (d as number), c: s.c + (c as number) }), { d: 0, c: 0 });
    expect(t).toEqual({ d: 1_470_000, c: 1_470_000 });
    assertBalanced(deal.plan);
    expect(canonicalLines(deal.plan).find((l) => l.role === 'USED_WHOLE_GOODS_INVENTORY')!.deptRole).toBe('WG_USED');
  });

  it('lien payoff: DR trade lien payoff / CR bank 120,000', () => {
    expect(lines(lienPayoffPlan(120_000, 'WG_NEW', 'lien'))).toEqual([
      ['TRADE_LIEN_PAYOFF', 120_000, 0],
      ['OPERATING_BANK', 0, 120_000],
    ]);
  });

  it('refuses a deal where the trade exceeds what the customer owes', () => {
    expect(dealReceivable({ salePriceCents: 100, taxCents: 0, retailRebateCents: 0, trade: { allowanceCents: 200, valuation: valueTradeIn({ allowanceCents: 200, acvCents: 200, policy: 'ACV' }), lienPayoffCents: 0 } })).toBe(-100);
    expect(() =>
      dealPlan({ unit: NEW_UNIT, salePriceCents: 100, taxCents: 0, retailRebateCents: 0, trade: { allowanceCents: 200, valuation: valueTradeIn({ allowanceCents: 200, acvCents: 200, policy: 'ACV' }), lienPayoffCents: 0 }, costCents: 50, memo: 'x' }),
    ).toThrow(/refund/);
  });
});

describe('warranty claim (FPB §3.8, AC9)', () => {
  const c = computeClaim({ laborHours: '2.0', laborRateCents: 9_500, partsCostCents: 8_000, partsMarkupBps: 3_000, subletCents: 0, freightCents: 0, otherCents: 0 });

  it('claims 29,400 = 19,000 labor + 10,400 parts', () => {
    expect(c).toMatchObject({ laborCents: 19_000, partsCents: 10_400, claimedCents: 29_400 });
    expect(() => assertClaimFoots({ labor_cents: 19_000, parts_cents: 10_400, sublet_cents: 0, freight_cents: 0, other_cents: 0, claimed_cents: 29_000 })).toThrow();
  });

  it('recognition posts receivable split 19,000 / 10,400 and relieves parts at cost', () => {
    const plan = recognitionPlan({ ...c, partsCostCents: 8_000, relieveParts: true, memo: 'W-1' });
    expect(lines(plan)).toEqual([
      ['WARRANTY_RECEIVABLE', 29_400, 0],
      ['WARRANTY_LABOR_SALES', 0, 19_000],
      ['WARRANTY_PARTS_SALES', 0, 10_400],
      ['INVENTORY_COGS', 8_000, 0],
      ['INVENTORY_ASSET', 0, 8_000],
    ]);
    const depts = canonicalLines(plan).map((l) => l.deptRole);
    expect(depts).toEqual(['SERVICE', 'SERVICE', 'PARTS', 'PARTS', 'PARTS']);
  });

  it('a 27,000 credit leaves the claim PARTIAL; accepting the 2,400 short-pay nets to the FPB lines', () => {
    expect(statusAfterSettlement({ claimed_cents: 29_400, settled_cents: 27_000, written_off_cents: 0 })).toBe('PARTIAL');
    const credit = receivableSettlementPlan({ receivableRole: 'WARRANTY_RECEIVABLE', amountCents: 27_000, method: 'STATEMENT_CREDIT', memo: 'credit' });
    const short = warrantyWriteOffPlan(2_400, 'short-pay');
    expect(Object.fromEntries(netByRole([credit, short]))).toEqual({
      AP_CONTROL: 27_000,
      WARRANTY_POLICY_EXPENSE: 2_400,
      WARRANTY_RECEIVABLE: -29_400,
    });
    expect(statusAfterSettlement({ claimed_cents: 29_400, settled_cents: 27_000, written_off_cents: 2_400 })).toBe('PAID');
    expect(statusAfterSettlement({ claimed_cents: 29_400, settled_cents: 0, written_off_cents: 29_400 })).toBe('WRITTEN_OFF');
    expect(() => statusAfterSettlement({ claimed_cents: 100, settled_cents: 101, written_off_cents: 0 })).toThrow();
  });

  it('cash settlement debits the bank; a later debit hits AP', () => {
    expect(lines(receivableSettlementPlan({ receivableRole: 'WARRANTY_RECEIVABLE', amountCents: 500, method: 'CASH', memo: 'c' }))[0]).toEqual(['OPERATING_BANK', 500, 0]);
    expect(lines(warrantyDebitPlan(700, 'd'))).toEqual([
      ['WARRANTY_POLICY_EXPENSE', 700, 0],
      ['AP_CONTROL', 0, 700],
    ]);
    expect(() => assertSettleable('DRAFT')).toThrow();
  });
});

describe('incentives (FPB §3.9, AC10)', () => {
  const base = { programType: 'DEALER_REBATE' as const, paidDirect: false, amountCents: 20_000, costReductionInStock: 'REDUCE_UNIT_COST' as const, coOpRoleMapped: true, memo: 'r' };

  it('dealer rebate on a SOLD unit credits WG COGS', () => {
    const r = incentiveAccrualPlan({ ...base, treatment: 'COST_REDUCTION', unit: { inventoryRole: 'WHOLE_GOODS_INVENTORY', condition: 'NEW', sold: true } });
    expect(lines(r.plan)).toEqual([
      ['OEM_INCENTIVE_RECEIVABLE', 20_000, 0],
      ['WHOLE_GOODS_COGS', 0, 20_000],
    ]);
    expect(r.unitCostReductionCents).toBe(0);
  });

  it('dealer rebate on an IN-STOCK unit reduces that unit\'s cost', () => {
    const r = incentiveAccrualPlan({ ...base, treatment: 'COST_REDUCTION', unit: { inventoryRole: 'WHOLE_GOODS_INVENTORY', condition: 'NEW', sold: false } });
    expect(lines(r.plan)).toEqual([
      ['OEM_INCENTIVE_RECEIVABLE', 20_000, 0],
      ['WHOLE_GOODS_INVENTORY', 0, 20_000],
    ]);
    expect(r.unitCostReductionCents).toBe(20_000);
    const r2 = incentiveAccrualPlan({ ...base, costReductionInStock: 'REDUCE_COGS', treatment: 'COST_REDUCTION', unit: { inventoryRole: 'WHOLE_GOODS_INVENTORY', condition: 'NEW', sold: false } });
    expect(r2.targetRole).toBe('WHOLE_GOODS_COGS');
  });

  it('co-op, interest subsidy, pass-through, and the unmapped co-op fallback', () => {
    expect(incentiveAccrualPlan({ ...base, programType: 'CO_OP', treatment: 'EXPENSE_REIMBURSEMENT', unit: null }).targetRole).toBe('CO_OP_ADVERTISING_RECOVERY');
    expect(incentiveAccrualPlan({ ...base, programType: 'INTEREST_SUBSIDY', treatment: 'EXPENSE_REIMBURSEMENT', unit: null }).targetRole).toBe('FLOOR_PLAN_INTEREST');
    const pt = incentiveAccrualPlan({ ...base, programType: 'SPIFF', treatment: 'PASS_THROUGH', unit: null });
    expect(lines(pt.plan)).toEqual([
      ['OEM_INCENTIVE_RECEIVABLE', 20_000, 0],
      ['ACCRUED_EXPENSES', 0, 20_000],
    ]);
    const fb = incentiveAccrualPlan({ ...base, programType: 'CO_OP', treatment: 'EXPENSE_REIMBURSEMENT', coOpRoleMapped: false, unit: null });
    expect(fb.targetRole).toBe('WHOLE_GOODS_COGS');
    expect(fb.warnings).toHaveLength(1);
  });

  it('refuses retail rebates and paid-direct programs as stand-alone accruals', () => {
    expect(() => incentiveAccrualPlan({ ...base, treatment: 'TRANSACTION_PRICE', unit: null })).toThrow(/unit sale/);
    expect(() => incentiveAccrualPlan({ ...base, paidDirect: true, treatment: 'COST_REDUCTION', unit: null })).toThrow(/directly/);
    expect(defaultTreatment('RETAIL_REBATE')).toBe('TRANSACTION_PRICE');
    expect(defaultTreatment('VOLUME_BONUS')).toBe('COST_REDUCTION');
  });

  it('write-off reverses into the account the accrual credited', () => {
    const w = incentiveWriteOffPlan({ targetRole: 'WHOLE_GOODS_COGS', amountCents: 5_000, unit: null, memo: 'w' });
    expect(lines(w.plan)).toEqual([
      ['WHOLE_GOODS_COGS', 5_000, 0],
      ['OEM_INCENTIVE_RECEIVABLE', 0, 5_000],
    ]);
    const sold = incentiveWriteOffPlan({ targetRole: 'WHOLE_GOODS_INVENTORY', amountCents: 5_000, unit: { inventoryRole: 'WHOLE_GOODS_INVENTORY', condition: 'NEW', sold: true }, memo: 'w' });
    expect(sold.role).toBe('WHOLE_GOODS_COGS');
    const stock = incentiveWriteOffPlan({ targetRole: 'WHOLE_GOODS_INVENTORY', amountCents: 5_000, unit: { inventoryRole: 'WHOLE_GOODS_INVENTORY', condition: 'NEW', sold: false }, memo: 'w' });
    expect(stock.addBackToUnitCents).toBe(5_000);
    const retail = incentiveWriteOffPlan({ targetRole: 'WHOLE_GOODS_SALES', amountCents: 5_000, unit: null, memo: 'w' });
    expect(lines(retail.plan)).toEqual([
      ['WHOLE_GOODS_SALES', 5_000, 0],
      ['OEM_INCENTIVE_RECEIVABLE', 0, 5_000],
    ]);
    const pt = incentiveWriteOffPlan({ targetRole: 'ACCRUED_EXPENSES', amountCents: 5_000, unit: null, memo: 'w' });
    expect(totals(assertBalanced(pt.plan)).debit).toBe(5_000);
    expect(lines(pt.plan)[0]).toEqual(['ACCRUED_EXPENSES', 5_000, 0]);
  });
});
