/**
 * Variance decomposition.
 *
 *   budgetVsActual — account-level budget vs actual with favourable/unfavourable by
 *     account nature and a materiality filter ($ and/or %).
 *   priceVolumeMix — revenue (or cost) change split into price, volume and mix effects
 *     plus new / discontinued items; the effects sum EXACTLY to the total change.
 *
 * Inputs are integer cents; outputs are integer cents.
 */

import { roundCents, sum } from './numbers';

export type LineNature = 'income' | 'expense';

/** Revenue and other income are credit-natured ("income"); COGS / OPEX / other expense are "expense". */
export function natureOfAccountType(accountType: string, subType?: string): LineNature | null {
  switch (accountType) {
    case 'REVENUE':
      return 'income';
    case 'COGS':
    case 'OPEX':
      return 'expense';
    case 'OTHER':
      return subType === 'OTHER_INCOME' ? 'income' : 'expense';
    default:
      return null;
  }
}

export interface MaterialityRule {
  /** Absolute variance threshold in cents (0 / undefined = no $ test). */
  amountCents?: number;
  /** Relative threshold as a fraction of |base| (0.1 = 10%; undefined = no % test). */
  pct?: number;
  /** 'or' (default): material if EITHER test passes. 'and': BOTH must pass. */
  mode?: 'and' | 'or';
}

/**
 * Apply a materiality rule to a change against a base. A % test on a zero base
 * passes whenever the change is non-zero (a new line is infinitely large in %).
 */
export function isMaterial(changeCents: number, baseCents: number, rule: MaterialityRule): boolean {
  const tests: boolean[] = [];
  if (rule.amountCents !== undefined && rule.amountCents > 0) tests.push(Math.abs(changeCents) >= rule.amountCents);
  if (rule.pct !== undefined && rule.pct > 0) {
    tests.push(baseCents === 0 ? changeCents !== 0 : Math.abs(changeCents) / Math.abs(baseCents) >= rule.pct);
  }
  if (tests.length === 0) return changeCents !== 0;
  return (rule.mode ?? 'or') === 'and' ? tests.every(Boolean) : tests.some(Boolean);
}

export interface BvaInputRow {
  key: string;
  label: string;
  nature: LineNature;
  actualCents: number;
  budgetCents: number;
}

export interface BvaRow extends BvaInputRow {
  /** actual − budget (natural sign of the line). */
  varianceCents: number;
  /** Variance ÷ |budget|; null when the budget is 0. */
  variancePct: number | null;
  verdict: 'favourable' | 'unfavourable' | 'on_budget';
  material: boolean;
}

export interface BvaResult {
  rows: BvaRow[];
  totals: {
    incomeActualCents: number;
    incomeBudgetCents: number;
    expenseActualCents: number;
    expenseBudgetCents: number;
    /** (income − expense) actual − budget: positive = favourable to profit. */
    netVarianceCents: number;
  };
  materialCount: number;
}

/** Favourable: income above budget, or expense below budget. */
export function varianceVerdict(nature: LineNature, varianceCents: number): BvaRow['verdict'] {
  if (varianceCents === 0) return 'on_budget';
  const good = nature === 'income' ? varianceCents > 0 : varianceCents < 0;
  return good ? 'favourable' : 'unfavourable';
}

export function budgetVsActual(rows: BvaInputRow[], rule: MaterialityRule = {}): BvaResult {
  const out: BvaRow[] = rows.map((r) => {
    const varianceCents = r.actualCents - r.budgetCents;
    return {
      ...r,
      varianceCents,
      variancePct: r.budgetCents === 0 ? null : varianceCents / Math.abs(r.budgetCents),
      verdict: varianceVerdict(r.nature, varianceCents),
      material: isMaterial(varianceCents, r.budgetCents, rule),
    };
  });
  const inc = out.filter((r) => r.nature === 'income');
  const exp = out.filter((r) => r.nature === 'expense');
  const incomeActualCents = sum(inc.map((r) => r.actualCents));
  const incomeBudgetCents = sum(inc.map((r) => r.budgetCents));
  const expenseActualCents = sum(exp.map((r) => r.actualCents));
  const expenseBudgetCents = sum(exp.map((r) => r.budgetCents));
  return {
    rows: out,
    totals: {
      incomeActualCents,
      incomeBudgetCents,
      expenseActualCents,
      expenseBudgetCents,
      netVarianceCents: incomeActualCents - expenseActualCents - (incomeBudgetCents - expenseBudgetCents),
    },
    materialCount: out.filter((r) => r.material).length,
  };
}

export interface PvmItem {
  key: string;
  /** Units sold (any positive quantity: units, hours, jobs). */
  units: number;
  revenueCents: number;
}

export interface PvmResult {
  ok: true;
  priorCents: number;
  currentCents: number;
  totalChangeCents: number;
  priceCents: number;
  volumeCents: number;
  mixCents: number;
  newItemsCents: number;
  discontinuedCents: number;
  /** Per continuing item: its price effect (cents). */
  priceByItem: { key: string; cents: number }[];
}

export type PvmOutcome = PvmResult | { ok: false; reason: 'no_units' | 'no_continuing_items' };

/**
 * Price / volume / mix (FTI method) over continuing items, plus new and discontinued:
 *   Price  = Σ (P₁ − P₀) × Q₁
 *   Volume = (ΣQ₁ − ΣQ₀) × P̄₀           where P̄₀ = ΣR₀ ÷ ΣQ₀ (continuing items)
 *   Mix    = Σ Q₁ × P₀ − ΣQ₁ × P̄₀
 *   New    = R₁ of items with no prior units;  Discontinued = −R₀ of items with no current units.
 * Price and volume are rounded to cents; mix absorbs the sub-cent rounding so
 * price + volume + mix + new + discontinued = R₁ − R₀ exactly.
 */
export function priceVolumeMix(prior: PvmItem[], current: PvmItem[]): PvmOutcome {
  const all = [...prior, ...current];
  if (all.some((i) => !(i.units >= 0) || !Number.isInteger(i.revenueCents))) return { ok: false, reason: 'no_units' };
  const p = new Map(prior.map((i) => [i.key, i]));
  const c = new Map(current.map((i) => [i.key, i]));
  const continuing = [...c.keys()].filter((k) => (p.get(k)?.units ?? 0) > 0 && (c.get(k)?.units ?? 0) > 0);
  const priorCents = sum(prior.map((i) => i.revenueCents));
  const currentCents = sum(current.map((i) => i.revenueCents));
  const newItemsCents = sum(current.filter((i) => !continuing.includes(i.key)).map((i) => i.revenueCents));
  const discontinuedCents = -sum(prior.filter((i) => !continuing.includes(i.key)).map((i) => i.revenueCents));
  if (continuing.length === 0) {
    if (priorCents === 0 && currentCents === 0) return { ok: false, reason: 'no_continuing_items' };
    return {
      ok: true,
      priorCents,
      currentCents,
      totalChangeCents: currentCents - priorCents,
      priceCents: 0,
      volumeCents: 0,
      mixCents: 0,
      newItemsCents,
      discontinuedCents,
      priceByItem: [],
    };
  }
  const q0 = sum(continuing.map((k) => p.get(k)!.units));
  const q1 = sum(continuing.map((k) => c.get(k)!.units));
  const r0 = sum(continuing.map((k) => p.get(k)!.revenueCents));
  const r1 = sum(continuing.map((k) => c.get(k)!.revenueCents));
  const avgP0 = r0 / q0;
  const priceByItem = continuing.map((k) => {
    const a = p.get(k)!;
    const b = c.get(k)!;
    return { key: k, cents: roundCents((b.revenueCents / b.units - a.revenueCents / a.units) * b.units) };
  });
  const priceCents = sum(priceByItem.map((x) => x.cents));
  const volumeCents = roundCents((q1 - q0) * avgP0);
  const mixCents = r1 - r0 - priceCents - volumeCents;
  return {
    ok: true,
    priorCents,
    currentCents,
    totalChangeCents: currentCents - priorCents,
    priceCents,
    volumeCents,
    mixCents,
    newItemsCents,
    discontinuedCents,
    priceByItem,
  };
}
