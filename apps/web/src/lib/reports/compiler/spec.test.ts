import { describe, it, expect } from 'vitest';
import {
  expandDescriptor,
  expandSpec,
  fiscalYearOf,
  fiscalYearRange,
  type PeriodDescriptor,
  type ReportSpec,
} from './spec';

// Fixed reference date so every case is deterministic: Aug 5, 2026.
const REF = '2026-08-05';

describe('fiscal-year math', () => {
  it('numbers a calendar-year FY by its calendar year', () => {
    expect(fiscalYearOf({ y: 2026, m: 8, d: 5 }, 1)).toBe(2026);
    const r = fiscalYearRange(2025, 1);
    expect(r.start).toEqual({ y: 2025, m: 1, d: 1 });
    expect(r.end).toEqual({ y: 2025, m: 12, d: 31 });
  });

  it('handles a July fiscal-year start (numbered by start year)', () => {
    // Aug 2026 is in FY starting 2026.
    expect(fiscalYearOf({ y: 2026, m: 8, d: 5 }, 7)).toBe(2026);
    // Mar 2026 is in FY starting 2025.
    expect(fiscalYearOf({ y: 2026, m: 3, d: 1 }, 7)).toBe(2025);
    const r = fiscalYearRange(2025, 7);
    expect(r.start).toEqual({ y: 2025, m: 7, d: 1 });
    expect(r.end).toEqual({ y: 2026, m: 6, d: 30 });
  });
});

describe('expandDescriptor — calendar filer', () => {
  const sm = 1;
  it('LAST_N_FISCAL_YEARS gives the N prior full years chronologically', () => {
    const d: PeriodDescriptor = { type: 'LAST_N_FISCAL_YEARS', n: 3 };
    const out = expandDescriptor(d, sm, REF);
    expect(out.map((r) => [r.startDate, r.endDate])).toEqual([
      ['2023-01-01', '2023-12-31'],
      ['2024-01-01', '2024-12-31'],
      ['2025-01-01', '2025-12-31'],
    ]);
    expect(out[2].tag).toBe('FY2025');
  });

  it('FISCAL_YTD through June = Jan 1 to Jun 30 of the current year', () => {
    const out = expandDescriptor({ type: 'FISCAL_YTD', throughMonth: 6 }, sm, REF);
    expect(out).toHaveLength(1);
    expect([out[0].startDate, out[0].endDate]).toEqual(['2026-01-01', '2026-06-30']);
  });

  it('FISCAL_YEAR offset 0 caps the (incomplete) current year at today', () => {
    const out = expandDescriptor({ type: 'FISCAL_YEAR', offset: 0 }, sm, REF);
    expect([out[0].startDate, out[0].endDate]).toEqual(['2026-01-01', '2026-08-05']);
  });

  it('FISCAL_YEAR offset -1 is the prior full year', () => {
    const out = expandDescriptor({ type: 'FISCAL_YEAR', offset: -1 }, sm, REF);
    expect([out[0].startDate, out[0].endDate]).toEqual(['2025-01-01', '2025-12-31']);
  });

  it('LAST_N_MONTHS is trailing whole months ending last month', () => {
    const out = expandDescriptor({ type: 'LAST_N_MONTHS', n: 12 }, sm, REF);
    expect([out[0].startDate, out[0].endDate]).toEqual(['2025-08-01', '2026-07-31']);
  });

  it('CALENDAR_YEAR resolves to that whole year', () => {
    const out = expandDescriptor({ type: 'CALENDAR_YEAR', year: 2023 }, sm, REF);
    expect([out[0].startDate, out[0].endDate]).toEqual(['2023-01-01', '2023-12-31']);
  });

  it('EXPLICIT passes the user-stated dates through (repairing inversion)', () => {
    const out = expandDescriptor({ type: 'EXPLICIT', startDate: '2024-03-31', endDate: '2024-01-01' }, sm, REF);
    expect([out[0].startDate, out[0].endDate]).toEqual(['2024-01-01', '2024-03-31']);
  });
});

describe('expandDescriptor — July fiscal filer', () => {
  const sm = 7;
  it('LAST_N_FISCAL_YEARS spans July–June years', () => {
    const out = expandDescriptor({ type: 'LAST_N_FISCAL_YEARS', n: 2 }, sm, REF);
    expect(out.map((r) => [r.startDate, r.endDate])).toEqual([
      ['2024-07-01', '2025-06-30'],
      ['2025-07-01', '2026-06-30'],
    ]);
  });

  it('FISCAL_YTD with no throughMonth runs FY start to today', () => {
    const out = expandDescriptor({ type: 'FISCAL_YTD' }, sm, REF);
    expect([out[0].startDate, out[0].endDate]).toEqual(['2026-07-01', '2026-08-05']);
  });
});

describe('expandSpec', () => {
  it('expands a 3-year balance sheet into three as-of periods', () => {
    const spec: ReportSpec = { report: 'BALANCE_SHEET', basis: 'ACCRUAL', periods: [{ type: 'LAST_N_FISCAL_YEARS', n: 3 }] };
    const r = expandSpec(spec, 1, REF);
    expect(r.periods).toHaveLength(3);
    expect(r.periods[2].asOfDate).toBe('2025-12-31');
    expect(r.periods[2].label).toContain('As of Dec 31, 2025');
    expect(r.cashWarning).toBeNull();
  });

  it('flags a cash-basis request on a report that has no cash path', () => {
    const spec: ReportSpec = { report: 'BALANCE_SHEET', basis: 'CASH', periods: [{ type: 'FISCAL_YEAR', offset: -1 }] };
    const r = expandSpec(spec, 1, REF);
    expect(r.cashWarning).toBeTruthy();
  });

  it('keeps a full cash-basis P&L request clean', () => {
    const spec: ReportSpec = { report: 'INCOME_STATEMENT', basis: 'CASH', periods: [{ type: 'FISCAL_YEAR', offset: -1 }] };
    const r = expandSpec(spec, 1, REF);
    expect(r.cashWarning).toBeNull();
    expect(r.basis).toBe('CASH');
  });

  it('collapses a snapshot report (AR aging) to a single as-of-today section', () => {
    const spec: ReportSpec = { report: 'AR_AGING', basis: 'ACCRUAL', periods: [{ type: 'LAST_N_FISCAL_YEARS', n: 3 }] };
    const r = expandSpec(spec, 1, REF);
    expect(r.periods).toHaveLength(1);
    expect(r.periods[0].label).toContain('As of');
  });

  it('de-dupes overlapping period descriptors', () => {
    const spec: ReportSpec = {
      report: 'INCOME_STATEMENT',
      basis: 'ACCRUAL',
      periods: [{ type: 'FISCAL_YEAR', offset: -1 }, { type: 'CALENDAR_YEAR', year: 2025 }],
    };
    const r = expandSpec(spec, 1, REF);
    expect(r.periods).toHaveLength(1); // both resolve to 2025-01-01..2025-12-31
  });
});
