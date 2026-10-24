import { describe, expect, it } from 'vitest';
import {
  addMonths,
  clampSelection,
  fiscalQuarterOf,
  fiscalYearMonths,
  fiscalYearOf,
  matchPreset,
  monthEndDate,
  presetSelection,
  rangeName,
  resolvePeriod,
  toReportPeriodSpec,
  type PeriodContext,
} from './resolve';

const CAL: PeriodContext = { fyStartMonth: 1, currentMonth: '2026-10', closedThrough: '2026-08' };
const JUL: PeriodContext = { fyStartMonth: 7, currentMonth: '2026-10', closedThrough: '2026-08' };
const APR: PeriodContext = { fyStartMonth: 4, currentMonth: '2026-02', closedThrough: null };

describe('month arithmetic', () => {
  it('crosses year boundaries both ways', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2025-12', 1)).toBe('2026-01');
    expect(addMonths('2026-03', -27)).toBe('2023-12');
  });
  it('honours leap years in month-end dates', () => {
    expect(monthEndDate('2028-02')).toBe('2028-02-29');
    expect(monthEndDate('2026-02')).toBe('2026-02-28');
    expect(monthEndDate('2100-02')).toBe('2100-02-28'); // century rule
    expect(monthEndDate('2000-02')).toBe('2000-02-29');
    expect(monthEndDate('2026-09')).toBe('2026-09-30');
  });
});

describe('fiscal calendar', () => {
  it('names a fiscal year by the year it ends in', () => {
    expect(fiscalYearOf('2026-06', 7)).toBe(2026);
    expect(fiscalYearOf('2026-07', 7)).toBe(2027);
    expect(fiscalYearOf('2026-12', 1)).toBe(2026);
    expect(fiscalYearMonths(2027, 7)[0]).toBe('2026-07');
    expect(fiscalYearMonths(2027, 7)[11]).toBe('2027-06');
    expect(fiscalYearMonths(2026, 1)).toHaveLength(12);
  });
  it('counts fiscal quarters from the fiscal-year start', () => {
    expect(fiscalQuarterOf('2026-07', 7)).toBe(1);
    expect(fiscalQuarterOf('2026-09', 7)).toBe(1);
    expect(fiscalQuarterOf('2026-10', 7)).toBe(2);
    expect(fiscalQuarterOf('2027-06', 7)).toBe(4);
    expect(fiscalQuarterOf('2026-03', 4)).toBe(4); // Apr-start: Jan–Mar is Q4
    expect(fiscalQuarterOf('2026-09', 1)).toBe(3);
  });
});

describe('resolvePeriod — labels and months', () => {
  it('month', () => {
    const p = resolvePeriod({ basis: 'month', end: '2026-09' }, CAL);
    expect(p.label).toBe('Sep 2026');
    expect(p.months).toEqual(['2026-09']);
    expect(p.startDate).toBe('2026-09-01');
    expect(p.endDate).toBe('2026-09-30');
    expect(p.includesOpenMonths).toBe(true);
  });
  it('YTD, calendar and July fiscal years', () => {
    const c = resolvePeriod({ basis: 'ytd', end: '2026-09' }, CAL);
    expect(c.label).toBe('YTD 2026');
    expect(c.months).toHaveLength(9);
    expect(c.start).toBe('2026-01');
    const j = resolvePeriod({ basis: 'ytd', end: '2026-09' }, JUL);
    expect(j.label).toBe('YTD FY 2027');
    expect(j.start).toBe('2026-07');
    expect(j.months).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(j.fiscalYearLabel).toBe('FY 2027');
  });
  it('TTM spans 12 months across a year boundary', () => {
    const p = resolvePeriod({ basis: 'ttm', end: '2026-09' }, CAL);
    expect(p.label).toBe('TTM to Sep 2026');
    expect(p.start).toBe('2025-10');
    expect(p.months).toHaveLength(12);
    expect(p.spanLabel).toBe('Oct 2025 – Sep 2026 · 12 months');
  });
  it('quarter snaps to the whole fiscal quarter', () => {
    const p = resolvePeriod({ basis: 'quarter', end: '2026-08' }, CAL);
    expect(p.label).toBe('Q3 2026');
    expect([p.start, p.end]).toEqual(['2026-07', '2026-09']);
    const j = resolvePeriod({ basis: 'quarter', end: '2026-08' }, JUL);
    expect(j.label).toBe('Q1 FY 2027');
    expect([j.start, j.end]).toEqual(['2026-07', '2026-09']);
  });
  it('QTD reads "to date" until the quarter is complete', () => {
    expect(resolvePeriod({ basis: 'qtd', end: '2026-10' }, CAL).label).toBe('Q4 2026 to date');
    expect(resolvePeriod({ basis: 'qtd', end: '2026-09' }, CAL).label).toBe('Q3 2026');
  });
  it('fiscal year: "FY 2025", whole year even when it runs past today', () => {
    const p = resolvePeriod({ basis: 'fy', end: '2025-03' }, CAL);
    expect(p.label).toBe('FY 2025');
    expect([p.start, p.end]).toEqual(['2025-01', '2025-12']);
    const cur = resolvePeriod({ basis: 'fy', end: '2026-10' }, CAL);
    expect(cur.end).toBe('2026-12');
    expect(cur.includesFuture).toBe(true);
  });
  it('custom range labels', () => {
    expect(resolvePeriod({ basis: 'range', start: '2026-01', end: '2026-03' }, CAL).label).toBe('Jan–Mar 2026');
    expect(rangeName('2025-11', '2026-02')).toBe('Nov 2025–Feb 2026');
    // reversed input is normalised
    const r = resolvePeriod({ basis: 'range', start: '2026-05', end: '2026-02' }, CAL);
    expect([r.start, r.end]).toEqual(['2026-02', '2026-05']);
  });
  it('closed-through unknown → includesOpenMonths null; inside → false', () => {
    expect(resolvePeriod({ basis: 'month', end: '2026-01' }, APR).includesOpenMonths).toBeNull();
    expect(resolvePeriod({ basis: 'ytd', end: '2026-08' }, CAL).includesOpenMonths).toBe(false);
  });
});

describe('clamping — no future to-date windows', () => {
  it('pulls a future end back to the current month', () => {
    expect(clampSelection({ basis: 'month', end: '2027-01' }, CAL).end).toBe('2026-10');
    expect(clampSelection({ basis: 'range', start: '2026-12', end: '2027-02' }, CAL)).toMatchObject({ start: '2026-10', end: '2026-10' });
  });
  it('keeps a whole quarter that has started; drops one that has not', () => {
    expect(clampSelection({ basis: 'quarter', end: '2026-12' }, CAL).end).toBe('2026-12');
    expect(clampSelection({ basis: 'quarter', end: '2027-02' }, CAL).end).toBe('2026-10');
  });
});

describe('comparisons', () => {
  it('prior period steps by the window', () => {
    expect(resolvePeriod({ basis: 'month', end: '2026-01', compare: 'prior_period' }, CAL).comparison).toMatchObject({ start: '2025-12', end: '2025-12', label: 'Dec 2025', vsLabel: 'vs Dec 2025' });
    expect(resolvePeriod({ basis: 'quarter', end: '2026-02', compare: 'prior_period' }, CAL).comparison).toMatchObject({ start: '2025-10', end: '2025-12', label: 'Q4 2025' });
    expect(resolvePeriod({ basis: 'range', start: '2026-01', end: '2026-03', compare: 'prior_period' }, CAL).comparison).toMatchObject({ start: '2025-10', end: '2025-12' });
  });
  it('prior year shifts 12 months and keeps the basis label', () => {
    expect(resolvePeriod({ basis: 'ytd', end: '2026-09', compare: 'prior_year' }, CAL).comparison).toMatchObject({ start: '2025-01', end: '2025-09', label: 'YTD 2025', vsLabel: 'vs YTD 2025' });
    expect(resolvePeriod({ basis: 'ttm', end: '2026-09', compare: 'prior_year' }, CAL).comparison).toMatchObject({ start: '2024-10', end: '2025-09', label: 'TTM to Sep 2025' });
  });
  it('prior-year leap February ends on the 29th', () => {
    const c = resolvePeriod({ basis: 'month', end: '2029-02', compare: 'prior_year' }, { ...CAL, currentMonth: '2029-05' }).comparison;
    expect(c?.endDate).toBe('2028-02-29');
  });
  it('budget is the same months', () => {
    const c = resolvePeriod({ basis: 'ytd', end: '2026-09', compare: 'budget' }, CAL).comparison;
    expect(c).toMatchObject({ kind: 'budget', start: '2026-01', end: '2026-09', vsLabel: 'vs budget' });
  });
  it('none → null', () => {
    expect(resolvePeriod({ basis: 'month', end: '2026-09' }, CAL).comparison).toBeNull();
  });
});

describe('presets', () => {
  it('resolve against today, calendar year', () => {
    expect(resolvePeriod(presetSelection('this_month', CAL), CAL).label).toBe('Oct 2026');
    expect(resolvePeriod(presetSelection('last_month', CAL), CAL).label).toBe('Sep 2026');
    expect(resolvePeriod(presetSelection('this_quarter', CAL), CAL).label).toBe('Q4 2026 to date');
    expect(resolvePeriod(presetSelection('last_quarter', CAL), CAL).label).toBe('Q3 2026');
    expect(resolvePeriod(presetSelection('ytd', CAL), CAL).label).toBe('YTD 2026');
    expect(resolvePeriod(presetSelection('last_year', CAL), CAL).label).toBe('FY 2025');
    expect(resolvePeriod(presetSelection('ttm', CAL), CAL).label).toBe('TTM to Oct 2026');
    expect(resolvePeriod(presetSelection('last_12_closed', CAL), CAL).label).toBe('TTM to Aug 2026');
  });
  it('resolve against a July fiscal year', () => {
    expect(resolvePeriod(presetSelection('last_year', JUL), JUL)).toMatchObject({ label: 'FY 2026', start: '2025-07', end: '2026-06' });
    expect(resolvePeriod(presetSelection('last_quarter', JUL), JUL)).toMatchObject({ label: 'Q1 FY 2027', start: '2026-07', end: '2026-09' });
    expect(resolvePeriod(presetSelection('ytd', JUL), JUL).months).toHaveLength(4);
  });
  it('April fiscal year in February: last quarter is Q3 (Oct–Dec)', () => {
    expect(resolvePeriod(presetSelection('last_quarter', APR), APR)).toMatchObject({ start: '2025-10', end: '2025-12', label: 'Q3 FY 2026' });
    expect(resolvePeriod(presetSelection('ytd', APR), APR)).toMatchObject({ start: '2025-04', end: '2026-02' });
    // nothing closed → "last 12 closed" falls back to ending last month
    expect(presetSelection('last_12_closed', APR).end).toBe('2026-01');
  });
  it('matchPreset lights the preset for an equivalent URL selection', () => {
    expect(matchPreset({ basis: 'ytd', end: '2026-10' }, CAL)).toBe('ytd');
    expect(matchPreset({ basis: 'month', end: '2026-09' }, CAL)).toBe('last_month');
    expect(matchPreset({ basis: 'ttm', end: '2026-08' }, CAL)).toBe('last_12_closed');
    expect(matchPreset({ basis: 'month', end: '2026-03' }, CAL)).toBeNull();
  });
});

describe('toReportPeriodSpec', () => {
  it('maps onto the report engine preset vocabulary', () => {
    expect(toReportPeriodSpec(resolvePeriod({ basis: 'fy', end: '2025-05' }, CAL))).toEqual({ preset: 'year', asOf: '2025-12-31' });
    expect(toReportPeriodSpec(resolvePeriod({ basis: 'range', start: '2026-01', end: '2026-02' }, CAL))).toEqual({ preset: 'custom', asOf: '2026-02-28', start: '2026-01-01', end: '2026-02-28' });
  });
});
