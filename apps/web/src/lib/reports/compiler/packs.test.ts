import { describe, it, expect } from 'vitest';
import {
  nextOccurrence,
  resolveSavedPack,
  parseStoredSpecs,
  recipientsSchema,
  createPackSchema,
  updatePackSchema,
} from './packs';
import type { ReportSpec } from './spec';

describe('nextOccurrence — deterministic schedule math', () => {
  it('MONTHLY returns the first of the next month', () => {
    expect(nextOccurrence('MONTHLY', '2026-08-07')).toBe('2026-09-01');
    expect(nextOccurrence('MONTHLY', '2026-12-15')).toBe('2027-01-01');
    // Strictly after: a run landing exactly on the 1st advances to next month.
    expect(nextOccurrence('MONTHLY', '2026-10-01')).toBe('2026-11-01');
  });

  it('QUARTERLY returns the first day of the next calendar quarter', () => {
    expect(nextOccurrence('QUARTERLY', '2026-08-07')).toBe('2026-10-01'); // Q3 -> Q4
    expect(nextOccurrence('QUARTERLY', '2026-02-01')).toBe('2026-04-01'); // Q1 -> Q2
    expect(nextOccurrence('QUARTERLY', '2026-11-30')).toBe('2027-01-01'); // Q4 -> Q1 next yr
    expect(nextOccurrence('QUARTERLY', '2026-10-01')).toBe('2027-01-01'); // on a boundary -> next
  });

  it('NONE has no next occurrence', () => {
    expect(nextOccurrence('NONE', '2026-08-07')).toBeNull();
  });
});

describe('resolveSavedPack — descriptors re-resolve to CURRENT dates', () => {
  const specs: ReportSpec[] = [
    { report: 'INCOME_STATEMENT', basis: 'ACCRUAL', periods: [{ type: 'LAST_N_FISCAL_YEARS', n: 2 }] },
    { report: 'BALANCE_SHEET', basis: 'ACCRUAL', periods: [{ type: 'FISCAL_YEAR', offset: -1 }] },
  ];

  it('expands the same descriptors to different concrete dates in different years', () => {
    const in2026 = resolveSavedPack(specs, 'Acme', [], 1, '2026-08-07');
    const in2027 = resolveSavedPack(specs, 'Acme', [], 1, '2027-08-07');

    const is2026 = in2026.specs.find((s) => s.report === 'INCOME_STATEMENT')!;
    const is2027 = in2027.specs.find((s) => s.report === 'INCOME_STATEMENT')!;

    // Two prior fiscal years, calendar filer.
    expect(is2026.periods.map((p) => p.startDate)).toEqual(['2024-01-01', '2025-01-01']);
    expect(is2027.periods.map((p) => p.startDate)).toEqual(['2025-01-01', '2026-01-01']);
    expect(in2026.entityLabel).toBe('Acme');
  });

  it('respects a non-calendar fiscal year start month', () => {
    const julyFiler = resolveSavedPack(specs, 'FY Co', [], 7, '2026-08-07');
    const bs = julyFiler.specs.find((s) => s.report === 'BALANCE_SHEET')!;
    // Current FY (July filer) as of Aug 2026 is FY2026 (Jul 2026–Jun 2027); prior = FY2025.
    expect(bs.periods[0].asOfDate).toBe('2026-06-30');
  });
});

describe('validation guards', () => {
  it('recipients are deduped + lowercased', () => {
    const out = recipientsSchema.parse(['A@x.com', 'a@x.com', 'b@x.com']);
    expect(out).toEqual(['a@x.com', 'b@x.com']);
  });

  it('createPackSchema requires a name and at least one spec', () => {
    expect(createPackSchema.safeParse({ name: '', specs: [] }).success).toBe(false);
    expect(
      createPackSchema.safeParse({
        name: 'Quarterly board pack',
        specs: [{ report: 'TRIAL_BALANCE', basis: 'ACCRUAL', periods: [{ type: 'FISCAL_YTD' }] }],
      }).success,
    ).toBe(true);
  });

  it('updatePackSchema rejects an empty update', () => {
    expect(updatePackSchema.safeParse({}).success).toBe(false);
    expect(updatePackSchema.safeParse({ cadence: 'MONTHLY' }).success).toBe(true);
  });

  it('parseStoredSpecs rejects a spec off the grammar', () => {
    expect(parseStoredSpecs([{ report: 'NOT_A_REPORT', basis: 'ACCRUAL', periods: [] }])).toBeNull();
    expect(
      parseStoredSpecs([{ report: 'CASH_FLOW', basis: 'ACCRUAL', periods: [{ type: 'LAST_N_MONTHS', n: 12 }] }]),
    ).not.toBeNull();
  });
});
