/**
 * Reporting-deadline tiles (FPB §18.5 G-10). PURE.
 *
 * A deadline is "N days after the end of each monthly / quarterly / annual period" (e.g. the
 * monthly package within 45 days, quarterly within 60, the annual within 90). The tile shows
 * the most recent ENDED period of that cadence (or an older one still overdue), its due date,
 * and whether the scope released it on time. Quarters and years follow the fiscal year start month.
 */

import { addDays, addMonths, daysBetween, monthEnd, monthLabel, parsePeriodKey } from './periods';
import type { DeadlineDef, PeriodKey } from './types';

export type DeadlineState = 'met' | 'met_late' | 'due' | 'due_soon' | 'overdue';

export interface DeadlineTile {
  key: string;
  label: string;
  recipient: string | null;
  cadence: DeadlineDef['cadence'];
  /** The period this tile is about (its last month). */
  periodKey: PeriodKey;
  periodLabel: string;
  dueDate: string;
  state: DeadlineState;
  /** Positive = days left; negative = days overdue. */
  daysLeft: number;
  /** When the scope's numbers for the period were released (ISO date), if they were. */
  releasedOn: string | null;
  text: string;
}

/** Is `month` the last month of a period of this cadence, given the FY start month? */
export function isPeriodEnd(month: number, cadence: DeadlineDef['cadence'], fyStartMonth: number): boolean {
  if (cadence === 'monthly') return true;
  const offset = (month - fyStartMonth + 12) % 12; // 0 = first FY month
  if (cadence === 'quarterly') return offset % 3 === 2;
  return offset === 11;
}

/** The most recent period end (of this cadence) on or before `today`. */
export function latestEndedPeriod(today: string, cadence: DeadlineDef['cadence'], fyStartMonth: number): PeriodKey {
  let k = addMonths(today.slice(0, 7), -1); // the current month has not ended
  for (let i = 0; i < 13; i++) {
    if (isPeriodEnd(parsePeriodKey(k).month, cadence, fyStartMonth)) return k;
    k = addMonths(k, -1);
  }
  return k;
}

export function deadlineTiles(
  defs: readonly DeadlineDef[],
  opts: {
    today: string;
    fyStartMonth: number;
    /** When were ALL of the scope's months through `periodKey` released? (ISO date or null.) */
    releasedOn: (periodKey: PeriodKey, def: DeadlineDef) => string | null;
    dueSoonDays?: number;
    /** Does the scope have books for this period at all? (Older candidates only.) */
    exists?: (periodKey: PeriodKey) => boolean;
  },
): DeadlineTile[] {
  const soon = opts.dueSoonDays ?? 7;
  return defs.map((d) => {
    // The most recent ended period — unless an EARLIER one is still unreleased past its due
    // date (an overdue package must not scroll off the tile when the next month ends).
    const latest = latestEndedPeriod(opts.today, d.cadence, opts.fyStartMonth);
    const step = d.cadence === 'monthly' ? 1 : d.cadence === 'quarterly' ? 3 : 12;
    let pk = latest;
    for (const back of [2, 1]) {
      const cand = addMonths(latest, -step * back);
      const candDue = addDays(monthEnd(cand), d.daysAfterPeriodEnd);
      if ((opts.exists?.(cand) ?? true) && !opts.releasedOn(cand, d) && candDue < opts.today) { pk = cand; break; }
    }
    const due = addDays(monthEnd(pk), d.daysAfterPeriodEnd);
    const left = daysBetween(opts.today, due);
    const rel = opts.releasedOn(pk, d);
    let state: DeadlineState;
    if (rel) state = rel.slice(0, 10) <= due ? 'met' : 'met_late';
    else if (left < 0) state = 'overdue';
    else if (left <= soon) state = 'due_soon';
    else state = 'due';
    const what = d.cadence === 'monthly' ? monthLabel(pk) : d.cadence === 'quarterly' ? `quarter to ${monthLabel(pk)}` : `year to ${monthLabel(pk)}`;
    const text =
      state === 'met'
        ? `${what} released on time.`
        : state === 'met_late'
          ? `${what} released ${daysBetween(due, rel as string)} days late.`
          : state === 'overdue'
            ? `${what} is ${-left} day${left === -1 ? '' : 's'} overdue.`
            : `${what} due in ${left} day${left === 1 ? '' : 's'}.`;
    return {
      key: d.key,
      label: d.label,
      recipient: d.recipient ?? null,
      cadence: d.cadence,
      periodKey: pk,
      periodLabel: monthLabel(pk),
      dueDate: due,
      state,
      daysLeft: left,
      releasedOn: rel,
      text,
    };
  });
}

/** The standard preset the UI offers (generic — no tenant-specific agreement is assumed). */
export const STANDARD_DEADLINES: DeadlineDef[] = [
  { key: 'monthly-package', label: 'Monthly package', cadence: 'monthly', daysAfterPeriodEnd: 45 },
  { key: 'quarterly-statements', label: 'Quarterly statements', cadence: 'quarterly', daysAfterPeriodEnd: 60 },
  { key: 'annual-statements', label: 'Annual statements', cadence: 'annual', daysAfterPeriodEnd: 90 },
];

