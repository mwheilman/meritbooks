/**
 * Deterministic driver computers for the CASH-FLOW statement and
 * BUDGET-VS-ACTUAL (M7 — Narrative & Explanation), a sibling of `variance.ts`.
 *
 * Same correctness guarantee as the flux narrative: EVERY figure the board
 * narrative can cite is computed HERE, in code — the model is only ever handed
 * these already-computed drivers and asked to PHRASE them. Pure and side-effect
 * free (raw GL / budget rows in → ranked drivers out) so it is exhaustively
 * unit-testable.
 *
 * The cash-flow classifier is a faithful port of the accumulation logic in
 * `app/api/reports/cash-flow/route.ts` (indirect method), lifted here so the
 * narrative layer produces the SAME sources/uses of cash the on-screen statement
 * does. Money is bigint cents throughout; percentages are the only derived float
 * and are `null` (never Infinity / 0) when the base is zero.
 */

import {
  pctChange,
  type Direction,
  type VarianceDriver,
  type VarianceResult,
  type SectionTotal,
} from './variance';

function directionOf(deltaCents: number): Direction {
  if (deltaCents > 0) return 'up';
  if (deltaCents < 0) return 'down';
  return 'flat';
}

// ════════════════════════════════════════════════════════════════════════════
// CASH FLOW (indirect method) — period-over-period sources/uses of cash
// ════════════════════════════════════════════════════════════════════════════

/** Raw GL line (already scoped to a period + org by the caller). */
export interface CashFlowInputLine {
  account_id: string;
  debit_cents: number;
  credit_cents: number;
}

/** Per-account classification metadata (from `accounts`). */
export interface CashFlowAcctMeta {
  type: string; // REVENUE | COGS | OPEX | OTHER | ASSET | LIABILITY | EQUITY
  subType: string;
  isBank: boolean;
  name: string;
}

/** Account-id families resolved BY ROLE (never by number range). */
export interface CashFlowRoleSets {
  cashIds: Set<string>;
  arIds: Set<string>;
  apIds: Set<string>;
}

export type CashFlowSection = 'OPERATING' | 'INVESTING' | 'FINANCING';

/** One flat cash-flow line, stable-keyed across periods. Signed cash
 *  contribution: positive = source of cash, negative = use of cash. */
export interface CashFlowLine {
  key: string;
  label: string;
  section: CashFlowSection;
  amountCents: number;
}

export interface CashFlowSnapshot {
  lines: CashFlowLine[];
  operatingCents: number;
  investingCents: number;
  financingCents: number;
  netChangeCents: number;
}

const isDepreciationName = (name: string) => {
  const n = name.toLowerCase();
  return n.includes('depreciation') || n.includes('amortization');
};
const isAccumulatedDepreciation = (name: string) => {
  const n = name.toLowerCase();
  return n.includes('accumulated') && isDepreciationName(n);
};

/**
 * Reduce a period's raw GL lines into the indirect-method cash-flow statement,
 * as a flat, stable-keyed set of signed cash contributions. Faithful port of
 * the cash-flow report route so the narrative ties to the on-screen statement.
 */
export function computeCashFlowSnapshot(
  lines: CashFlowInputLine[],
  acctMeta: Map<string, CashFlowAcctMeta>,
  roles: CashFlowRoleSets,
): CashFlowSnapshot {
  let revenue = 0,
    cogs = 0,
    opex = 0,
    otherIncome = 0,
    otherExpense = 0,
    depreciation = 0;
  let arChange = 0,
    otherCurrentAssetChange = 0;
  let apChange = 0,
    otherCurrentLiabChange = 0;
  let fixedAssetChange = 0;
  let debtChange = 0,
    equityChange = 0;

  for (const line of lines) {
    const m = acctMeta.get(line.account_id);
    if (!m) continue;
    const debit = Number(line.debit_cents ?? 0);
    const credit = Number(line.credit_cents ?? 0);

    // Cash itself is the reconciling item — never a line in the sections.
    if (roles.cashIds.has(line.account_id)) continue;

    switch (m.type) {
      case 'REVENUE':
        revenue += credit - debit;
        break;
      case 'COGS':
        cogs += debit - credit;
        break;
      case 'OPEX':
        opex += debit - credit;
        if (isDepreciationName(m.name)) depreciation += debit - credit; // non-cash add-back
        break;
      case 'OTHER':
        if (m.subType === 'OTHER_INCOME') otherIncome += credit - debit;
        else otherExpense += debit - credit;
        break;
      case 'ASSET':
        if (m.subType === 'FIXED_ASSET' || m.subType === 'OTHER_ASSET') {
          if (!isAccumulatedDepreciation(m.name)) fixedAssetChange += debit - credit;
        } else if (roles.arIds.has(line.account_id)) {
          arChange += debit - credit;
        } else {
          otherCurrentAssetChange += debit - credit;
        }
        break;
      case 'LIABILITY':
        if (m.subType === 'LONG_TERM_LIABILITY') {
          debtChange += credit - debit;
        } else if (roles.apIds.has(line.account_id)) {
          apChange += credit - debit;
        } else {
          otherCurrentLiabChange += credit - debit;
        }
        break;
      case 'EQUITY':
        equityChange += credit - debit;
        break;
      default:
        break;
    }
  }

  const netIncome = revenue - cogs - opex + otherIncome - otherExpense;
  const operatingCents =
    netIncome + depreciation - arChange - otherCurrentAssetChange + apChange + otherCurrentLiabChange;
  const investingCents = -fixedAssetChange;
  const financingCents = debtChange + equityChange;

  // Flat, stable-keyed cash contributions (mirror the statement's line items).
  const lineDefs: CashFlowLine[] = [
    { key: 'OPERATING:net_income', label: 'Net Income', section: 'OPERATING', amountCents: netIncome },
    { key: 'OPERATING:dep_amort', label: 'Depreciation & Amortization', section: 'OPERATING', amountCents: depreciation },
    { key: 'OPERATING:ar', label: 'Accounts Receivable', section: 'OPERATING', amountCents: -arChange },
    { key: 'OPERATING:other_current_assets', label: 'Other Current Assets', section: 'OPERATING', amountCents: -otherCurrentAssetChange },
    { key: 'OPERATING:ap', label: 'Accounts Payable', section: 'OPERATING', amountCents: apChange },
    { key: 'OPERATING:other_current_liabilities', label: 'Other Current Liabilities', section: 'OPERATING', amountCents: otherCurrentLiabChange },
    { key: 'INVESTING:capex', label: 'Capital Expenditures', section: 'INVESTING', amountCents: -fixedAssetChange },
    { key: 'FINANCING:debt', label: 'Debt Proceeds / (Payments)', section: 'FINANCING', amountCents: debtChange },
    { key: 'FINANCING:equity', label: 'Equity Transactions', section: 'FINANCING', amountCents: equityChange },
  ];

  return {
    lines: lineDefs,
    operatingCents,
    investingCents,
    financingCents,
    netChangeCents: operatingCents + investingCents + financingCents,
  };
}

/**
 * Rank the period-over-period movement of each cash-flow line — the biggest
 * sources/uses of the change in cash. Favorable = the line contributed MORE
 * cash this period than the prior (delta > 0).
 */
export function computeCashFlowVariance(
  current: CashFlowSnapshot,
  prior: CashFlowSnapshot,
  topN = 8,
): VarianceResult {
  const priMap = new Map<string, CashFlowLine>();
  for (const l of prior.lines) priMap.set(l.key, l);
  const curMap = new Map<string, CashFlowLine>();
  for (const l of current.lines) curMap.set(l.key, l);

  const keys = new Set<string>([...curMap.keys(), ...priMap.keys()]);
  const drivers: VarianceDriver[] = [];
  for (const key of keys) {
    const cur = curMap.get(key);
    const pri = priMap.get(key);
    const currentCents = cur?.amountCents ?? 0;
    const priorCents = pri?.amountCents ?? 0;
    const deltaCents = currentCents - priorCents;
    if (deltaCents === 0) continue;
    const section = cur?.section ?? pri?.section ?? 'OPERATING';
    drivers.push({
      key,
      line: cur?.label ?? pri?.label ?? key,
      section,
      currentCents,
      priorCents,
      deltaCents,
      pct: pctChange(currentCents, priorCents),
      direction: directionOf(deltaCents),
      favorable: deltaCents > 0, // more cash = favorable
    });
  }

  drivers.sort((a, b) => {
    const d = Math.abs(b.deltaCents) - Math.abs(a.deltaCents);
    if (d !== 0) return d;
    const c = Math.abs(b.currentCents) - Math.abs(a.currentCents);
    if (c !== 0) return c;
    return a.key.localeCompare(b.key);
  });

  const sectionTotals: SectionTotal[] = [
    { section: 'OPERATING', currentCents: current.operatingCents, priorCents: prior.operatingCents, deltaCents: current.operatingCents - prior.operatingCents },
    { section: 'INVESTING', currentCents: current.investingCents, priorCents: prior.investingCents, deltaCents: current.investingCents - prior.investingCents },
    { section: 'FINANCING', currentCents: current.financingCents, priorCents: prior.financingCents, deltaCents: current.financingCents - prior.financingCents },
  ];

  return {
    drivers: drivers.slice(0, topN),
    sectionTotals,
    netCurrentCents: current.netChangeCents,
    netPriorCents: prior.netChangeCents,
    netDeltaCents: current.netChangeCents - prior.netChangeCents,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// BUDGET VS ACTUAL — largest favorable / unfavorable variances vs budget
// ════════════════════════════════════════════════════════════════════════════

/** One P&L line with its budget and (sign-normalized) actual, per the
 *  budget-vs-actual route's conventions. */
export interface BudgetInputRow {
  /** Stable identifier — the account number. */
  key: string;
  label: string;
  /** Account type: REVENUE | COGS | OPEX | OTHER. */
  section: string;
  budgetCents: number;
  /** Presentation actual (revenue already flipped positive by the caller). */
  actualCents: number;
}

const BUDGET_REVENUE = 'REVENUE';
const BUDGET_COSTS = ['COGS', 'OPEX'];

/** Is an actual-vs-budget delta favorable for this section?
 *  Revenue over budget = good; every other P&L section under budget = good. */
export function isBudgetFavorable(section: string, budgetCents: number, actualCents: number): boolean {
  if (section === BUDGET_REVENUE) return actualCents > budgetCents;
  return actualCents < budgetCents;
}

/**
 * Rank budget rows by the absolute size of their actual-vs-budget variance and
 * tag each favorable/unfavorable. `deltaCents` = actual − budget (positive =
 * over budget); `pct` = that delta as a share of |budget| (null when budget 0).
 */
export function computeBudgetVariance(rows: BudgetInputRow[], topN = 8): VarianceResult {
  const drivers: VarianceDriver[] = [];
  for (const r of rows) {
    const deltaCents = r.actualCents - r.budgetCents;
    if (deltaCents === 0) continue;
    drivers.push({
      key: r.key,
      line: r.label,
      section: r.section,
      currentCents: r.actualCents,
      priorCents: r.budgetCents,
      deltaCents,
      pct: pctChange(r.actualCents, r.budgetCents),
      direction: directionOf(deltaCents),
      favorable: isBudgetFavorable(r.section, r.budgetCents, r.actualCents),
    });
  }

  drivers.sort((a, b) => {
    const d = Math.abs(b.deltaCents) - Math.abs(a.deltaCents);
    if (d !== 0) return d;
    const c = Math.abs(b.currentCents) - Math.abs(a.currentCents);
    if (c !== 0) return c;
    return a.key.localeCompare(b.key);
  });

  // Net income (budget vs actual): Revenue − COGS − OPEX + Other (Other carries
  // its own sign), matching the budget-vs-actual workspace's net calculation.
  const sumWhere = (pick: (r: BudgetInputRow) => number, sections: string[]) =>
    rows.filter((r) => sections.includes(r.section)).reduce((s, r) => s + pick(r), 0);
  const netOf = (pick: (r: BudgetInputRow) => number) =>
    sumWhere(pick, [BUDGET_REVENUE]) - sumWhere(pick, ['COGS']) - sumWhere(pick, ['OPEX']) + sumWhere(pick, ['OTHER']);
  const netCurrentCents = netOf((r) => r.actualCents);
  const netPriorCents = netOf((r) => r.budgetCents);

  // Section totals (budget = prior, actual = current).
  const sectionKeys = new Set<string>(rows.map((r) => r.section));
  const sectionTotals: SectionTotal[] = [];
  for (const section of sectionKeys) {
    const actual = sumWhere((r) => r.actualCents, [section]);
    const budget = sumWhere((r) => r.budgetCents, [section]);
    sectionTotals.push({ section, currentCents: actual, priorCents: budget, deltaCents: actual - budget });
  }

  return {
    drivers: drivers.slice(0, topN),
    sectionTotals,
    netCurrentCents,
    netPriorCents,
    netDeltaCents: netCurrentCents - netPriorCents,
  };
}
