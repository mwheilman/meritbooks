import { describe, it, expect } from 'vitest';
import {
  addDaysUTC,
  addMonthsUTC,
  advanceRecurringDate,
  planRecurringRuns,
  type RecurringPlanInput,
} from './recurring-invoices';

// ─── Date math ────────────────────────────────────────────────────────

describe('addDaysUTC / addMonthsUTC', () => {
  it('adds days across a month boundary', () => {
    expect(addDaysUTC('2026-01-28', 7)).toBe('2026-02-04');
  });

  it('adds months and clamps the day to the target month (Jan 31 → Feb 28)', () => {
    expect(addMonthsUTC('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('does not clamp when the target month is long enough (Jan 15 → Feb 15)', () => {
    expect(addMonthsUTC('2026-01-15', 1)).toBe('2026-02-15');
  });

  it('rolls the year over on a December add', () => {
    expect(addMonthsUTC('2026-12-10', 1)).toBe('2027-01-10');
  });
});

describe('advanceRecurringDate (cadence step = interval_count × frequency unit)', () => {
  it('WEEKLY advances 7 days', () => {
    expect(advanceRecurringDate('2026-01-01', 'WEEKLY', 1)).toBe('2026-01-08');
  });
  it('BIWEEKLY advances 14 days', () => {
    expect(advanceRecurringDate('2026-01-01', 'BIWEEKLY', 1)).toBe('2026-01-15');
  });
  it('MONTHLY advances one month', () => {
    expect(advanceRecurringDate('2026-01-15', 'MONTHLY', 1)).toBe('2026-02-15');
  });
  it('QUARTERLY advances three months', () => {
    expect(advanceRecurringDate('2026-01-15', 'QUARTERLY', 1)).toBe('2026-04-15');
  });
  it('SEMIANNUAL advances six months', () => {
    expect(advanceRecurringDate('2026-01-15', 'SEMIANNUAL', 1)).toBe('2026-07-15');
  });
  it('ANNUAL advances twelve months', () => {
    expect(advanceRecurringDate('2026-01-15', 'ANNUAL', 1)).toBe('2027-01-15');
  });
  it('honors interval_count (every 2 weeks / every 2 months)', () => {
    expect(advanceRecurringDate('2026-01-01', 'WEEKLY', 2)).toBe('2026-01-15');
    expect(advanceRecurringDate('2026-01-15', 'MONTHLY', 2)).toBe('2026-03-15');
  });
  it('treats a zero/invalid interval as 1', () => {
    expect(advanceRecurringDate('2026-01-15', 'MONTHLY', 0)).toBe('2026-02-15');
  });
});

// ─── Planner: due-selection ───────────────────────────────────────────

const base: RecurringPlanInput = {
  frequency: 'MONTHLY',
  interval_count: 1,
  start_date: '2026-01-01',
  next_run_date: '2026-01-01',
  end_date: null,
  occurrences_remaining: null,
  is_active: true,
};

describe('planRecurringRuns — due selection', () => {
  it('generates nothing when next_run_date is in the future', () => {
    const plan = planRecurringRuns({ ...base, next_run_date: '2026-06-01' }, '2026-05-15');
    expect(plan.runDates).toEqual([]);
    expect(plan.nextRunDate).toBe('2026-06-01');
    expect(plan.deactivate).toBe(false);
  });

  it('generates exactly one run when due today and advances next_run_date', () => {
    const plan = planRecurringRuns({ ...base, next_run_date: '2026-05-01' }, '2026-05-01');
    expect(plan.runDates).toEqual(['2026-05-01']);
    expect(plan.nextRunDate).toBe('2026-06-01');
  });

  it('catches up every missed monthly period through asOf, in order', () => {
    const plan = planRecurringRuns({ ...base, next_run_date: '2026-01-01' }, '2026-04-15');
    expect(plan.runDates).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']);
    expect(plan.nextRunDate).toBe('2026-05-01');
  });

  it('falls back to start_date when next_run_date is null', () => {
    const plan = planRecurringRuns({ ...base, next_run_date: null }, '2026-01-01');
    expect(plan.runDates).toEqual(['2026-01-01']);
  });

  it('produces no runs for an inactive template', () => {
    const plan = planRecurringRuns({ ...base, is_active: false }, '2026-12-01');
    expect(plan.runDates).toEqual([]);
    expect(plan.deactivate).toBe(false);
  });

  it('respects a catch-up cap', () => {
    const plan = planRecurringRuns({ ...base, next_run_date: '2020-01-01' }, '2026-01-01', 5);
    expect(plan.runDates).toHaveLength(5);
  });
});

// ─── Planner: end_date + occurrence exhaustion ────────────────────────

describe('planRecurringRuns — end_date', () => {
  it('stops at end_date and does not run past it', () => {
    const plan = planRecurringRuns(
      { ...base, next_run_date: '2026-01-01', end_date: '2026-03-15' },
      '2026-12-01',
    );
    expect(plan.runDates).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    expect(plan.deactivate).toBe(true); // next (2026-04-01) is past end_date
  });

  it('does not deactivate while future runs remain within the window', () => {
    const plan = planRecurringRuns(
      { ...base, next_run_date: '2026-01-01', end_date: '2026-12-31' },
      '2026-02-15',
    );
    expect(plan.runDates).toEqual(['2026-01-01', '2026-02-01']);
    expect(plan.nextRunDate).toBe('2026-03-01');
    expect(plan.deactivate).toBe(false);
  });
});

describe('planRecurringRuns — occurrence exhaustion', () => {
  it('generates at most occurrences_remaining runs and deactivates at zero', () => {
    const plan = planRecurringRuns(
      { ...base, next_run_date: '2026-01-01', occurrences_remaining: 3 },
      '2026-12-01',
    );
    expect(plan.runDates).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    expect(plan.occurrencesRemaining).toBe(0);
    expect(plan.deactivate).toBe(true);
  });

  it('decrements but does not deactivate when occurrences remain', () => {
    const plan = planRecurringRuns(
      { ...base, next_run_date: '2026-01-01', occurrences_remaining: 5 },
      '2026-02-15',
    );
    expect(plan.runDates).toHaveLength(2);
    expect(plan.occurrencesRemaining).toBe(3);
    expect(plan.deactivate).toBe(false);
  });

  it('takes the tighter of end_date and occurrences', () => {
    // 10 occurrences allowed but end_date cuts it to 2.
    const plan = planRecurringRuns(
      { ...base, next_run_date: '2026-01-01', end_date: '2026-02-10', occurrences_remaining: 10 },
      '2026-12-01',
    );
    expect(plan.runDates).toEqual(['2026-01-01', '2026-02-01']);
    expect(plan.occurrencesRemaining).toBe(8);
    expect(plan.deactivate).toBe(true);
  });
});
