/**
 * Rolling reforecast — pure blend engine.
 *
 * No I/O. The forward-looking half of FP&A (`docs/discovery/segments/
 * budgeting-fpna.md` group B1): blend closed-period ACTUALS (from the owned GL)
 * with a forward PROJECTION for the still-open months into one continuously-
 * updated, full-year "latest estimate", and measure it against the original
 * budget. Because MeritBooks owns the ledger, "actualize the closed month and
 * roll the rest forward" is a deterministic transform, not a workbook rebuild.
 *
 * Money is bigint cents throughout — never floating point.
 *
 * Sign convention: callers pass `actualByMonth` already normalized to the
 * account's NATURAL sign (revenue positive, expense positive) so budget and
 * actual are directly comparable — the same normalization the budget-vs-actual
 * route applies (revenue = credits − debits; expense = debits − credits).
 */

import { MONTHS_IN_YEAR, type AccountType } from './drivers';

export type ReforecastMethod = 'budget_remaining' | 'run_rate';

export interface ReforecastAccountInput {
  accountId: string;
  accountNumber: string;
  accountName: string;
  accountType: AccountType;
  /** Original budget by month (1..12 → index 0..11), cents. */
  budgetByMonth: number[];
  /** Posted actuals by month, cents, natural sign. */
  actualByMonth: number[];
}

export interface ReforecastOptions {
  /**
   * Months 1..`closedThroughPeriod` are treated as ACTUAL; the rest are
   * projected. 0 = nothing closed yet (pure budget), 12 = fully actualized.
   */
  closedThroughPeriod: number;
  /**
   * How open months are projected:
   *  - `budget_remaining`: open month = its original budget (default).
   *  - `run_rate`: open month = average monthly actual of the closed months
   *    (falls back to budget when nothing is closed yet).
   */
  method: ReforecastMethod;
}

export interface ReforecastMonthCell {
  month: number; // 1..12
  isActual: boolean;
  actualCents: number; // 0 for still-open months
  budgetCents: number;
  reforecastCents: number;
}

export interface ReforecastAccountResult {
  accountId: string;
  accountNumber: string;
  accountName: string;
  accountType: AccountType;
  actualToDateCents: number;
  budgetToDateCents: number;
  budgetFullYearCents: number;
  projectedRemainingCents: number;
  reforecastFullYearCents: number;
  /** reforecast − budget (signed). */
  varianceCents: number;
  variancePct: number;
  /** True when the reforecast is better than plan (more revenue / less spend). */
  isFavorable: boolean;
  months: ReforecastMonthCell[];
}

export interface ReforecastTotals {
  budgetFullYearCents: number;
  actualToDateCents: number;
  reforecastFullYearCents: number;
  varianceCents: number;
}

export interface ReforecastResult {
  closedThroughPeriod: number;
  method: ReforecastMethod;
  accounts: ReforecastAccountResult[];
  totalsByType: Record<AccountType, ReforecastTotals>;
  grandTotals: ReforecastTotals;
}

const ALL_TYPES: AccountType[] = ['REVENUE', 'COGS', 'OPEX', 'OTHER'];

function clampClosed(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MONTHS_IN_YEAR, Math.trunc(n)));
}

function at(arr: number[], i: number): number {
  return arr[i] ?? 0;
}

/**
 * Blend one account's 12 months into actual-for-closed + projection-for-open.
 * Exported for direct unit testing of the core rule.
 */
export function blendMonthly(
  budgetByMonth: number[],
  actualByMonth: number[],
  closedThroughPeriod: number,
  method: ReforecastMethod
): number[] {
  const closed = clampClosed(closedThroughPeriod);

  // Run-rate = mean monthly actual across closed months (rounded to cents).
  let runRate = 0;
  if (method === 'run_rate' && closed > 0) {
    let s = 0;
    for (let m = 0; m < closed; m++) s += at(actualByMonth, m);
    runRate = Math.round(s / closed);
  }

  const out = new Array<number>(MONTHS_IN_YEAR).fill(0);
  for (let m = 0; m < MONTHS_IN_YEAR; m++) {
    const isActual = m < closed;
    if (isActual) {
      out[m] = at(actualByMonth, m);
    } else if (method === 'run_rate' && closed > 0) {
      out[m] = runRate;
    } else {
      out[m] = at(budgetByMonth, m);
    }
  }
  return out;
}

function isFavorableFor(
  accountType: AccountType,
  reforecast: number,
  budget: number
): boolean {
  // Revenue: beating (exceeding) plan is favorable. Cost lines (COGS/OPEX and
  // OTHER, treated conservatively as expense-like): under-running plan is favorable.
  return accountType === 'REVENUE' ? reforecast > budget : reforecast < budget;
}

export function buildReforecast(
  inputs: ReforecastAccountInput[],
  options: ReforecastOptions
): ReforecastResult {
  const closed = clampClosed(options.closedThroughPeriod);
  const method = options.method;

  const accounts: ReforecastAccountResult[] = inputs.map((acct) => {
    const blended = blendMonthly(acct.budgetByMonth, acct.actualByMonth, closed, method);

    let actualToDate = 0;
    let budgetToDate = 0;
    let budgetFullYear = 0;
    let projectedRemaining = 0;
    const months: ReforecastMonthCell[] = [];

    for (let m = 0; m < MONTHS_IN_YEAR; m++) {
      const isActual = m < closed;
      const budgetCents = at(acct.budgetByMonth, m);
      const actualCents = isActual ? at(acct.actualByMonth, m) : 0;
      const reforecastCents = blended[m];

      budgetFullYear += budgetCents;
      if (isActual) {
        actualToDate += actualCents;
        budgetToDate += budgetCents;
      } else {
        projectedRemaining += reforecastCents;
      }

      months.push({ month: m + 1, isActual, actualCents, budgetCents, reforecastCents });
    }

    const reforecastFullYear = actualToDate + projectedRemaining;
    const varianceCents = reforecastFullYear - budgetFullYear;
    const variancePct =
      budgetFullYear !== 0
        ? Math.round((varianceCents / Math.abs(budgetFullYear)) * 10000) / 100
        : 0;

    return {
      accountId: acct.accountId,
      accountNumber: acct.accountNumber,
      accountName: acct.accountName,
      accountType: acct.accountType,
      actualToDateCents: actualToDate,
      budgetToDateCents: budgetToDate,
      budgetFullYearCents: budgetFullYear,
      projectedRemainingCents: projectedRemaining,
      reforecastFullYearCents: reforecastFullYear,
      varianceCents,
      variancePct,
      isFavorable: isFavorableFor(acct.accountType, reforecastFullYear, budgetFullYear),
      months,
    };
  });

  const emptyTotals = (): ReforecastTotals => ({
    budgetFullYearCents: 0,
    actualToDateCents: 0,
    reforecastFullYearCents: 0,
    varianceCents: 0,
  });

  const totalsByType = ALL_TYPES.reduce<Record<AccountType, ReforecastTotals>>(
    (acc, t) => {
      acc[t] = emptyTotals();
      return acc;
    },
    {} as Record<AccountType, ReforecastTotals>
  );
  const grandTotals = emptyTotals();

  for (const a of accounts) {
    const bucket = totalsByType[a.accountType];
    bucket.budgetFullYearCents += a.budgetFullYearCents;
    bucket.actualToDateCents += a.actualToDateCents;
    bucket.reforecastFullYearCents += a.reforecastFullYearCents;
    bucket.varianceCents += a.varianceCents;

    grandTotals.budgetFullYearCents += a.budgetFullYearCents;
    grandTotals.actualToDateCents += a.actualToDateCents;
    grandTotals.reforecastFullYearCents += a.reforecastFullYearCents;
    grandTotals.varianceCents += a.varianceCents;
  }

  return { closedThroughPeriod: closed, method, accounts, totalsByType, grandTotals };
}
