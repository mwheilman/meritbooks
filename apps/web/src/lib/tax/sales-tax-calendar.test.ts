import { describe, it, expect } from 'vitest';
import {
  dueDateForPeriodEnd,
  generateFilingPeriods,
  classifyFilingStatus,
  collectedForPeriod,
  lastDayOfMonth,
  defaultFrequencyForState,
  type FilingPeriod,
} from './sales-tax-calendar';

describe('due-date rules', () => {
  it('is the 20th of the month following period end (monthly)', () => {
    expect(dueDateForPeriodEnd('2026-03-31', 20)).toBe('2026-04-20');
    expect(dueDateForPeriodEnd('2026-01-31', 20)).toBe('2026-02-20');
  });
  it('rolls a December period into January of the next year', () => {
    expect(dueDateForPeriodEnd('2026-12-31', 20)).toBe('2027-01-20');
  });
  it('clamps the due day to the last day of a short following month', () => {
    // period ends Jan 31 → following month Feb 2026 has 28 days; day 31 clamps to 28.
    expect(dueDateForPeriodEnd('2026-01-31', 31)).toBe('2026-02-28');
  });
});

describe('lastDayOfMonth', () => {
  it('handles Feb in leap and non-leap years', () => {
    expect(lastDayOfMonth(2024, 1)).toBe(29); // 2024 leap
    expect(lastDayOfMonth(2026, 1)).toBe(28);
  });
});

describe('generateFilingPeriods', () => {
  it('emits one quarter per overlapping quarter with correct bounds + due date', () => {
    const periods = generateFilingPeriods('quarterly', '2026-01-01', '2026-06-30', 20);
    expect(periods.map((p) => p.periodKey)).toEqual(['2026-Q1', '2026-Q2']);
    expect(periods[0]).toMatchObject({
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      dueDate: '2026-04-20',
      label: 'Q1 2026',
    });
  });
  it('dedupes a quarter even when the window starts mid-quarter', () => {
    const periods = generateFilingPeriods('quarterly', '2026-02-15', '2026-02-20', 20);
    expect(periods.map((p) => p.periodKey)).toEqual(['2026-Q1']);
  });
  it('emits monthly periods across a year boundary', () => {
    const periods = generateFilingPeriods('monthly', '2026-11-01', '2027-01-31', 20);
    expect(periods.map((p) => p.periodKey)).toEqual(['2026-11', '2026-12', '2027-01']);
    expect(periods[1].dueDate).toBe('2027-01-20');
  });
  it('emits a single annual period', () => {
    const periods = generateFilingPeriods('annual', '2026-03-01', '2026-09-30', 20);
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ periodKey: '2026', periodStart: '2026-01-01', periodEnd: '2026-12-31', dueDate: '2027-01-20' });
  });
});

describe('classifyFilingStatus', () => {
  const today = '2026-04-15';
  it('is filed whenever a record exists, regardless of date', () => {
    expect(classifyFilingStatus('2026-01-20', true, today)).toBe('filed');
  });
  it('is overdue when the due date has passed and it is unfiled', () => {
    expect(classifyFilingStatus('2026-04-14', false, today)).toBe('overdue');
  });
  it('is due-soon within the 14-day window', () => {
    expect(classifyFilingStatus('2026-04-20', false, today)).toBe('due-soon');
    expect(classifyFilingStatus('2026-04-15', false, today)).toBe('due-soon');
  });
  it('is upcoming beyond the due-soon window', () => {
    expect(classifyFilingStatus('2026-05-20', false, today)).toBe('upcoming');
  });
});

describe('collectedForPeriod', () => {
  const q1: FilingPeriod = {
    periodKey: '2026-Q1',
    label: 'Q1 2026',
    frequency: 'quarterly',
    periodStart: '2026-01-01',
    periodEnd: '2026-03-31',
    dueDate: '2026-04-20',
  };
  it('sums only the months inside the period', () => {
    const byMonth = new Map<string, number>([
      ['2025-12', 5_000],
      ['2026-01', 10_000],
      ['2026-02', 20_000],
      ['2026-03', 30_000],
      ['2026-04', 40_000],
    ]);
    expect(collectedForPeriod(byMonth, q1)).toBe(60_000); // Jan+Feb+Mar only
  });
});

describe('defaultFrequencyForState', () => {
  it('defaults to quarterly', () => {
    expect(defaultFrequencyForState('IA')).toBe('quarterly');
  });
});
