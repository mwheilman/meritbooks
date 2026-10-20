/**
 * Unit sale + trade-in (FPB §3.4, §3.5, §3.9 retail rebate) — pure.
 *
 * Two posting modes:
 *  - DEAL (DMS deal / Books-recorded deal): the dealer pack posts the whole deal JE —
 *    receivable, revenue, sales tax, retail rebate receivable, trade-in, lien payoff and
 *    cost of sale — and the service creates the matching Books invoice for the
 *    customer-owed amount so the AR subledger ties to AR control by construction.
 *    A customer deposit is then applied to that invoice through the mig 140 flow
 *    (DR Customer deposits / CR AR) — net effect = FPB §3.4 to the cent.
 *  - BOOKS_INVOICE: an existing posted invoice already carries AR/revenue/tax; the
 *    pack only relieves inventory to cost of sale. Trades and rebates belong in DEAL.
 */

import { compactLegs, type JournalPlan, type RoleLeg } from '../journal';
import { salesRolesFor } from '../roles';
import { DealerEngineError, type DeptRole, type InventoryRole, type TradeValuationPolicy } from '../types';

export interface TradeValuation {
  recordedValueCents: number;
  overAllowanceCents: number;
  underAllowanceCents: number;
}

/** §3.5.2 valuation policy (per client). Mirrors the trade_ins CHECK + generated columns. */
export function valueTradeIn(input: { allowanceCents: number; acvCents: number; policy: TradeValuationPolicy }): TradeValuation {
  const { allowanceCents: a, acvCents: v } = input;
  if (!Number.isInteger(a) || a < 0 || !Number.isInteger(v) || v < 0) throw new DealerEngineError('Allowance and ACV must be non-negative cents');
  const recorded = input.policy === 'ACV' ? v : input.policy === 'ALLOWANCE' ? a : Math.min(a, v);
  return {
    recordedValueCents: recorded,
    overAllowanceCents: Math.max(a - recorded, 0),
    underAllowanceCents: Math.max(recorded - a, 0),
  };
}

export interface SaleUnit {
  inventoryRole: InventoryRole;
  condition: string;
  departmentRole: DeptRole;
}

export interface DealTrade {
  allowanceCents: number;
  valuation: TradeValuation;
  lienPayoffCents: number;
}

export interface DealInput {
  unit: SaleUnit;
  salePriceCents: number;
  taxCents: number;
  retailRebateCents: number;
  trade: DealTrade | null;
  /** The unit's posted cost (relieved to cost of sale). */
  costCents: number;
  memo: string;
}

export interface DealPlan {
  plan: JournalPlan;
  /** What the customer owes on the Books invoice (before any deposit). */
  receivableCents: number;
}

function nonNeg(n: number, what: string): void {
  if (!Number.isInteger(n) || n < 0) throw new DealerEngineError(`${what} must be non-negative cents`);
}

/** Customer-owed amount: price + tax − trade allowance + lien payoff − retail rebate. */
export function dealReceivable(input: Pick<DealInput, 'salePriceCents' | 'taxCents' | 'retailRebateCents' | 'trade'>): number {
  const allowance = input.trade?.allowanceCents ?? 0;
  const lien = input.trade?.lienPayoffCents ?? 0;
  return input.salePriceCents + input.taxCents - allowance + lien - input.retailRebateCents;
}

function cogsLegs(unit: SaleUnit, costCents: number): RoleLeg[] {
  const roles = salesRolesFor(unit.inventoryRole, unit.condition);
  return [
    { role: roles.cogs, effect: 'increase', amountCents: costCents, deptRole: unit.departmentRole, memo: 'Cost of unit sold' },
    { role: unit.inventoryRole, effect: 'decrease', amountCents: costCents, memo: 'Unit relieved from inventory' },
  ];
}

export function dealPlan(input: DealInput): DealPlan {
  nonNeg(input.salePriceCents, 'Sale price');
  nonNeg(input.taxCents, 'Tax');
  nonNeg(input.retailRebateCents, 'Retail rebate');
  nonNeg(input.costCents, 'Unit cost');
  const receivable = dealReceivable(input);
  if (receivable < 0) {
    throw new DealerEngineError(
      'The trade allowance and rebates exceed what the customer owes; record the customer refund separately before posting this deal.',
    );
  }
  const roles = salesRolesFor(input.unit.inventoryRole, input.unit.condition);
  const dept = input.unit.departmentRole;
  const legs: RoleLeg[] = [
    { role: 'AR_CONTROL', effect: 'increase', amountCents: receivable, memo: 'Customer owes on the deal' },
    { role: 'OEM_INCENTIVE_RECEIVABLE', effect: 'increase', amountCents: input.retailRebateCents, memo: 'Retail rebate due from manufacturer' },
    { role: roles.sales, effect: 'increase', amountCents: input.salePriceCents, deptRole: dept, memo: 'Unit sale' },
    { role: 'SALES_TAX_PAYABLE', effect: 'increase', amountCents: input.taxCents, memo: 'Sales tax on unit' },
  ];
  if (input.trade) {
    const t = input.trade;
    nonNeg(t.lienPayoffCents, 'Lien payoff');
    if (t.valuation.recordedValueCents + t.valuation.overAllowanceCents - t.valuation.underAllowanceCents !== t.allowanceCents) {
      throw new DealerEngineError('Trade valuation does not reconcile to the allowance');
    }
    legs.push(
      { role: 'USED_WHOLE_GOODS_INVENTORY', effect: 'increase', amountCents: t.valuation.recordedValueCents, deptRole: 'WG_USED', memo: 'Trade-in taken into used inventory' },
      { role: 'TRADE_IN_OVER_ALLOWANCE', effect: 'decrease', amountCents: t.valuation.overAllowanceCents, deptRole: dept, memo: 'Trade over-allowance' },
      { role: 'TRADE_IN_OVER_ALLOWANCE', effect: 'increase', amountCents: t.valuation.underAllowanceCents, deptRole: dept, memo: 'Trade under-allowance' },
      { role: 'TRADE_LIEN_PAYOFF', effect: 'increase', amountCents: t.lienPayoffCents, memo: "Payoff owed to the customer's lender" },
    );
  }
  legs.push(...cogsLegs(input.unit, input.costCents));
  return {
    plan: { entryType: 'UNIT_SALE', memo: input.memo, primaryDept: dept, legs: compactLegs(legs) },
    receivableCents: receivable,
  };
}

/** BOOKS_INVOICE mode: the invoice already booked revenue — relieve cost only. */
export function costOfSalePlan(input: { unit: SaleUnit; costCents: number; memo: string }): JournalPlan {
  nonNeg(input.costCents, 'Unit cost');
  if (input.costCents === 0) throw new DealerEngineError('Unit has no posted cost to relieve');
  return {
    entryType: 'UNIT_SALE',
    memo: input.memo,
    primaryDept: input.unit.departmentRole,
    legs: compactLegs(cogsLegs(input.unit, input.costCents)),
  };
}

/** Deposit applied to the deal invoice (mig 140 flow) — modelled here for net-effect tests. */
export function depositApplicationPlan(amountCents: number, dept: DeptRole): JournalPlan {
  nonNeg(amountCents, 'Deposit');
  return {
    entryType: 'UNIT_SALE',
    memo: 'Customer deposit applied',
    primaryDept: dept,
    legs: compactLegs([
      { role: 'CUSTOMER_DEPOSITS', effect: 'decrease', amountCents, memo: 'Deposit applied' },
      { role: 'AR_CONTROL', effect: 'decrease', amountCents, memo: 'Deposit applied' },
    ]),
  };
}

/** §3.5.3 Lien payoff paid: DR trade lien payoff / CR bank. */
export function lienPayoffPlan(amountCents: number, dept: DeptRole, memo: string): JournalPlan {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new DealerEngineError('Lien payoff must be positive cents');
  return {
    entryType: 'TRADE_IN',
    memo,
    primaryDept: dept,
    legs: [
      { role: 'TRADE_LIEN_PAYOFF', effect: 'decrease', amountCents, memo: 'Lien paid off' },
      { role: 'OPERATING_BANK', effect: 'decrease', amountCents, memo: "Paid to customer's lender" },
    ],
  };
}

/** Over-allowance as a share of the sale, in bps (DL-11 input). */
export function overAllowanceBps(overAllowanceCents: number, salePriceCents: number): number {
  if (salePriceCents <= 0) return 0;
  return Math.round((overAllowanceCents * 10_000) / salePriceCents);
}
