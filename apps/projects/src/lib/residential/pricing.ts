/**
 * Residential proposal arithmetic — the exact mirror of migration 1119's pm.tg_res_proposal_line_price
 * and pm._res_proposal_totals (and the selection / allowance math of pm.res_selection_preview). Integer
 * cents on BigInt over the decimal digits (never floating point), rounded once, half away from zero, so
 * the builder's live preview and the stored proposal are always the same number. Pure; parity-tested
 * against the database in packages/projects-access/test/residential.test.ts.
 *
 *   labor line   cost = round(hours × (pay + burden))           → the budget (1108 rule)
 *                overhead = round(hours × estimating rate) − cost → recovered in margin, never in cost
 *                price = round(hours × unit sell); unit sell = explicit ?? sell(estimating rate)
 *   other line   cost = round(qty × (1 + waste) × unit cost)
 *                price = explicit unit sell ? round(qty × unit sell) : sell(cost)
 *   sell(x)      margin ? round(x ÷ (1 − margin)) : round(x × (1 + markup))
 *   allowance    with no cost: cost = price
 */
import { decimalParts } from '../pm/money/aia';

export type ContractType =
  | 'FIXED_PRICE' | 'COST_PLUS_PCT' | 'COST_PLUS_FEE' | 'COST_PLUS_GMP' | 'TIME_MATERIALS' | 'DESIGN_AGREEMENT' | 'PURCHASE_AGREEMENT';
export type TaxForm = 'LUMP_SUM_IMPROVEMENT' | 'RETAIL_PLUS_INSTALL' | 'EXEMPT';
export type TaxCategory = 'MATERIAL' | 'LABOR' | 'SUBCONTRACT' | 'DESIGN_FEE' | 'EQUIPMENT' | 'PERMIT_FEE' | 'OTHER';

export const COST_PLUS: ReadonlySet<ContractType> = new Set(['COST_PLUS_PCT', 'COST_PLUS_FEE', 'COST_PLUS_GMP', 'TIME_MATERIALS']);

type Dec = number | string;

function divRound(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError('Division by zero');
  if (b < 0n) { a = -a; b = -b; }
  const q = a / b;
  const r = a % b;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= b) return a < 0n ? q - 1n : q + 1n;
  return q;
}

/** round(Π factors) where the first factor is integer cents. */
export function roundProduct(cents: number, ...factors: Dec[]): number {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`Cents must be an integer: ${cents}`);
  let num = BigInt(cents);
  let scale = 1n;
  for (const f of factors) {
    const d = decimalParts(f);
    num *= d.num;
    scale *= d.scale;
  }
  return Number(divRound(num, scale));
}

/** 1 + p, digit-exact. */
function onePlus(p: Dec): string {
  const d = decimalParts(p);
  const n = d.scale + d.num;
  const digits = d.scale.toString().length - 1;
  if (digits === 0) return n.toString();
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().padStart(digits + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, -digits)}.${s.slice(-digits)}`;
}

/** sell(cost): margin wins (cost ÷ (1 − margin)), else markup (cost × (1 + markup)). */
export function sell(costCents: number, markup: Dec | null | undefined, margin: Dec | null | undefined): number {
  if (margin != null) {
    const g = decimalParts(margin);
    if (g.num < g.scale) return Number(divRound(BigInt(costCents) * g.scale, g.scale - g.num));
  }
  return roundProduct(costCents, onePlus(markup ?? 0));
}

export interface LaborRate {
  costRateCents: number;        // pay × (1 + burden)
  estimatingRateCents: number;  // pay × (1 + burden) × (1 + overhead)
}

export interface LineInput {
  qty: Dec;
  wastePct?: Dec;
  unitCostCents: number;
  markupPct?: Dec | null;
  marginPct?: Dec | null;
  unitPriceCents?: number | null;
  isAllowance?: boolean;
  /** Set for a labor (rate card) line; qty = hours. */
  labor?: LaborRate | null;
  laborHours?: Dec | null;
}

export interface LineAmounts {
  costCents: number;
  overheadCents: number;
  priceCents: number;
  /** labor lines: the unit sell per hour */
  unitSellCents: number | null;
}

export function priceLine(l: LineInput): LineAmounts {
  if (l.labor) {
    const hours = l.laborHours ?? l.qty;
    const cost = roundProduct(l.labor.costRateCents, hours);
    const est = roundProduct(l.labor.estimatingRateCents, hours);
    const unit = l.unitPriceCents ?? sell(l.labor.estimatingRateCents, l.markupPct, l.marginPct);
    return { costCents: cost, overheadCents: est - cost, priceCents: roundProduct(unit, hours), unitSellCents: unit };
  }
  let cost = roundProduct(l.unitCostCents, l.qty, onePlus(l.wastePct ?? 0));
  const price = l.unitPriceCents != null ? roundProduct(l.unitPriceCents, l.qty) : sell(cost, l.markupPct, l.marginPct);
  if (l.isAllowance && cost === 0) cost = price;
  return { costCents: cost, overheadCents: 0, priceCents: price, unitSellCents: null };
}

export interface TotalsLine {
  optionId: string | null;
  priceCents: number;
  costCents: number;
  overheadCents: number;
  isAllowance: boolean;
  isContingency: boolean;
  taxCategory: TaxCategory;
}

export interface TotalsHeader {
  contractType: ContractType;
  feePct?: Dec | null;
  feeCents?: number | null;
  taxForm: TaxForm;
  taxRate: Dec;
  contingencyPct?: Dec | null;
  depositPct?: Dec | null;
  depositCents?: number | null;
  retainerCreditCents?: number;
}

export interface StateRule {
  laborTaxable: boolean;
  designFeeTaxable: boolean;
  depositCapPct?: Dec | null;
  depositCapCents?: number | null;
}

export interface ProposalTotals {
  basePriceCents: number;
  optionsPriceCents: number;
  allowanceCents: number;
  contingencyCents: number;
  feeTotalCents: number;
  taxCents: number;
  useTaxCents: number;
  totalCents: number;
  grandTotalCents: number;
  costCents: number;
  overheadCents: number;
  depositDueCents: number;
  /** (total − cost) ÷ total, 4 places; null when the total is 0. */
  marginPct: number | null;
}

export function isTaxable(cat: TaxCategory, form: TaxForm, st: StateRule | null): boolean {
  if (form !== 'RETAIL_PLUS_INSTALL') return false;
  return cat === 'MATERIAL' || cat === 'EQUIPMENT' || (cat === 'LABOR' && !!st?.laborTaxable) || (cat === 'DESIGN_FEE' && !!st?.designFeeTaxable);
}

/** Totals over the base scope + the selected options (the caller passes only included lines). */
export function proposalTotals(h: TotalsHeader, included: ReadonlyArray<TotalsLine>, st: StateRule | null = null): ProposalTotals {
  let scope = 0, opt = 0, allow = 0, cont = 0, cost = 0, oh = 0, taxable = 0, baseNonAllow = 0, matCost = 0;
  for (const l of included) {
    scope += l.priceCents;
    if (l.optionId) opt += l.priceCents;
    if (l.isAllowance) allow += l.priceCents;
    if (l.isContingency) cont += l.priceCents;
    cost += l.costCents;
    oh += l.overheadCents;
    if (l.taxCategory === 'MATERIAL' || l.taxCategory === 'EQUIPMENT' || (l.taxCategory === 'LABOR' && st?.laborTaxable) || (l.taxCategory === 'DESIGN_FEE' && st?.designFeeTaxable)) taxable += l.priceCents;
    if (!l.isAllowance && !l.isContingency) baseNonAllow += l.priceCents;
    if (l.taxCategory === 'MATERIAL' || l.taxCategory === 'EQUIPMENT') matCost += l.costCents;
  }
  const contAuto = h.contingencyPct != null ? roundProduct(baseNonAllow, h.contingencyPct) : 0;
  let fee = 0;
  if (h.contractType === 'COST_PLUS_PCT' || h.contractType === 'COST_PLUS_GMP') fee = roundProduct(cost, h.feePct ?? 0);
  else if (h.contractType === 'COST_PLUS_FEE') fee = h.feeCents ?? 0;
  const total = scope + contAuto + fee;
  const tax = h.taxForm === 'RETAIL_PLUS_INSTALL' ? roundProduct(taxable, h.taxRate) : 0;
  const useTax = h.taxForm === 'LUMP_SUM_IMPROVEMENT' ? roundProduct(matCost, h.taxRate) : 0;
  let dep = h.depositCents ?? roundProduct(total, h.depositPct ?? 0);
  if (st?.depositCapPct != null) dep = Math.min(dep, roundProduct(total, st.depositCapPct));
  if (st?.depositCapCents != null) dep = Math.min(dep, st.depositCapCents);
  dep = Math.max(dep - (h.retainerCreditCents ?? 0), 0);
  return {
    basePriceCents: scope - opt, optionsPriceCents: opt, allowanceCents: allow, contingencyCents: cont + contAuto, feeTotalCents: fee,
    taxCents: tax, useTaxCents: useTax, totalCents: total, grandTotalCents: total + tax, costCents: cost, overheadCents: oh, depositDueCents: dep,
    marginPct: total > 0 ? Math.round(((total - cost) / total) * 10000) / 10000 : null,
  };
}

/** Pin payment schedule amounts: each row its amount or round(total × pct); the last row takes the remainder. */
export function pinPaymentSchedule(totalCents: number, rows: ReadonlyArray<{ pct?: Dec | null; amountCents?: number | null }>): number[] {
  const out: number[] = [];
  let sum = 0;
  rows.forEach((r, i) => {
    const amt = i === rows.length - 1 ? totalCents - sum : r.amountCents ?? roundProduct(totalCents, r.pct ?? 0);
    out.push(amt);
    sum += amt;
  });
  return out;
}

/** Σ pct + Σ fixed ÷ total — must be 1 (± 0.0001) before a proposal is sent. */
export function scheduleCoverage(totalCents: number, rows: ReadonlyArray<{ pct?: number | null; amountCents?: number | null }>): number {
  let s = 0;
  for (const r of rows) s += (r.pct ?? 0) + (totalCents > 0 && r.amountCents ? r.amountCents / totalCents : 0);
  return s;
}

export interface AllowanceDelta {
  /** The change-order amount if this option is chosen. */
  overCents: number;
  /** Credit at reconciliation. */
  underCents: number;
  remainingCents: number;
}

/** "+$1,840 over your allowance" BEFORE choosing; shared allowances pass what other choices used. */
export function allowanceDelta(optionCents: number, allowanceCents: number | null, usedByOthersCents = 0): AllowanceDelta | null {
  if (allowanceCents == null) return null;
  const remaining = allowanceCents - usedByOthersCents;
  return { overCents: Math.max(0, optionCents - Math.max(remaining, 0)), underCents: Math.max(0, remaining - optionCents), remainingCents: remaining };
}

/** Needed-by = install task start − vendor lead time − buffer (calendar days, ISO dates). */
export function neededBy(installStartIso: string, leadDays: number, bufferDays: number): string {
  const d = new Date(`${installStartIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - leadDays - bufferDays);
  return d.toISOString().slice(0, 10);
}

/** Re-plan a chain after a step's actual date: each later unfinished step = previous + its lead days. */
export function replanChain<T extends { leadDays: number; done: boolean }>(steps: ReadonlyArray<T>, fromIndex: number, actualIso: string): string[] {
  const out: string[] = [];
  const d = new Date(`${actualIso}T00:00:00Z`);
  for (let i = fromIndex + 1; i < steps.length; i++) {
    if (steps[i]!.done) break;
    d.setUTCDate(d.getUTCDate() + steps[i]!.leadDays);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Design-center stage ranks (pm.res_stage_rank). An option is open while the house is at or before its cutoff. */
export const STAGE_RANK = { PRE_START: 1, PRE_FRAME: 2, PRE_DRYWALL: 3, PRE_TRIM: 4, CLOSEOUT: 5, ANYTIME: 9 } as const;
export type CutoffStage = keyof typeof STAGE_RANK;

export function cutoffState(houseStage: CutoffStage, cutoff: CutoffStage, structural: boolean): 'open' | 'late_fee' | 'closed' {
  const past = STAGE_RANK[houseStage] > STAGE_RANK[cutoff];
  if (!past) return 'open';
  return structural ? 'closed' : 'late_fee';
}
