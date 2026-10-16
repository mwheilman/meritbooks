/**
 * Fiscal-period generation for a NEW company — pure (no I/O).
 *
 * A new company gets prior / current / next CALENDAR-year monthly periods
 * (36 rows). Periods are calendar months regardless of the fiscal-year start;
 * the fiscal year only changes how reports group them.
 *
 * STATUS RULE (FPB-onboarding B1): every month BEFORE the current month is
 * SOFT_CLOSE, the current month and later are OPEN. Never HARD_CLOSE — a
 * brand-new company has nothing closed yet, and a HARD_CLOSE month would block
 * posting its opening balances at the cutover date (the DB period lock, migration
 * 152, rejects POSTED entries into HARD_CLOSE). SOFT_CLOSE still accepts posts.
 *
 * Dates are formatted from integer year/month (never via toISOString), so a
 * server running in a non-UTC timezone can't shift a boundary by a day.
 */

export type NewPeriodStatus = 'OPEN' | 'SOFT_CLOSE';

export interface FiscalPeriodRow {
  org_id: string;
  location_id: string;
  period_year: number;
  period_month: number;
  start_date: string;
  end_date: string;
  status: NewPeriodStatus;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Days in a calendar month (month 1–12). */
export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month = last day of this month. UTC avoids DST/TZ drift.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Status for (year, month) relative to `now`'s calendar month. */
export function newCompanyPeriodStatus(year: number, month: number, now: Date): NewPeriodStatus {
  const cy = now.getUTCFullYear();
  const cm = now.getUTCMonth() + 1;
  return year < cy || (year === cy && month < cm) ? 'SOFT_CLOSE' : 'OPEN';
}

/** The 36 period rows (prior, current, next calendar year) for a new company. */
export function buildNewCompanyPeriods(orgId: string, locationId: string, now: Date = new Date()): FiscalPeriodRow[] {
  const cy = now.getUTCFullYear();
  const rows: FiscalPeriodRow[] = [];
  for (const year of [cy - 1, cy, cy + 1]) {
    for (let month = 1; month <= 12; month++) {
      rows.push({
        org_id: orgId,
        location_id: locationId,
        period_year: year,
        period_month: month,
        start_date: `${year}-${pad2(month)}-01`,
        end_date: `${year}-${pad2(month)}-${pad2(daysInMonth(year, month))}`,
        status: newCompanyPeriodStatus(year, month, now),
      });
    }
  }
  return rows;
}

/** Last day of the month before `now` (the default cutover / "take over" date), YYYY-MM-DD. */
export function defaultCutoverDate(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based current month == 1-based previous month
  const py = m === 0 ? y - 1 : y;
  const pm = m === 0 ? 12 : m;
  return `${py}-${pad2(pm)}-${pad2(daysInMonth(py, pm))}`;
}
