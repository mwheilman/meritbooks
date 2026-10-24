/**
 * Number governance for the FP&A command center (PURE). /api/fpna/dashboard decides which
 * months the caller may see (lib/reports/governance/route-guard) and runs every figure
 * through these helpers before computing KPIs, the trend, the variance table and runway:
 * a withheld month's actuals never reach a figure.
 */

/** The widest window the dashboard computes (five years). */
export const MAX_FPNA_WINDOW_MONTHS = 60;

/** Zero the actual buckets of withheld months (in place). `shown[i]` = month i+1. */
export function withholdActualBuckets(accts: ReadonlyArray<{ actual: number[] }>, shown: readonly boolean[]): void {
  for (const a of accts) {
    for (let i = 0; i < a.actual.length; i++) if (!shown[i]) a.actual[i] = 0;
  }
}

/** The latest shown month (1-based), 0 when none. */
export function lastShownMonth(shown: readonly boolean[]): number {
  for (let i = shown.length - 1; i >= 0; i--) if (shown[i]) return i + 1;
  return 0;
}

/**
 * Months 1..N the reforecast may treat as ACTUAL. Finance: the as-of month. Otherwise never
 * past the latest shown month (later months are projected from budget, not actuals).
 */
export function governedClosedThrough(asOfMonth: number, shown: readonly boolean[], finance: boolean): number {
  if (finance) return asOfMonth;
  return Math.min(asOfMonth, lastShownMonth(shown));
}

/** Net income series for the burn average: elapsed AND shown months only. */
export function governedNetIncomeSeries(
  netIncomeByMonth: readonly number[],
  asOfMonth: number,
  shown: readonly boolean[],
): number[] {
  const out: number[] = [];
  for (let m = 0; m < Math.min(asOfMonth, netIncomeByMonth.length); m++) if (shown[m]) out.push(netIncomeByMonth[m]);
  return out;
}
