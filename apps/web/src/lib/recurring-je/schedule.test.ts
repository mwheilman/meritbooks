import { describe, it, expect } from 'vitest';
import {
  validateBalance,
  cadenceStepMonths,
  enumerateOccurrences,
  nextDuePeriods,
  nextOccurrence,
  buildEntryLines,
  allocateEvenly,
  buildAllocatedAccrualLines,
  RecurringJeError,
  type RecurringJeLine,
  type RecurringJeTemplate,
} from './schedule';

const line = (partial: Partial<RecurringJeLine>): RecurringJeLine => ({
  account_id: 'acct',
  debit_cents: 0,
  credit_cents: 0,
  ...partial,
});

const sum = (ns: number[]) => ns.reduce((s, n) => s + n, 0);

// ─── validateBalance (the double-entry gate) ────────────────────────────────

describe('validateBalance', () => {
  it('accepts a balanced two-line entry and reports the total + line count', () => {
    const res = validateBalance([
      line({ account_id: 'a', debit_cents: 50_000 }),
      line({ account_id: 'b', credit_cents: 50_000 }),
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.totalCents).toBe(50_000);
      expect(res.lineCount).toBe(2);
    }
  });

  it('accepts a balanced multi-line allocation (debits split across buckets)', () => {
    const res = validateBalance([
      line({ account_id: 'e', debit_cents: 33_333 }),
      line({ account_id: 'e', debit_cents: 33_333 }),
      line({ account_id: 'e', debit_cents: 33_334 }),
      line({ account_id: 'l', credit_cents: 100_000 }),
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.totalCents).toBe(100_000);
  });

  it('rejects fewer than two lines', () => {
    const res = validateBalance([line({ account_id: 'a', debit_cents: 100 })]);
    expect(res).toEqual({ ok: false, error: 'A journal entry needs at least two lines' });
  });

  it('rejects a missing account on a line', () => {
    const res = validateBalance([
      line({ account_id: '', debit_cents: 100 }),
      line({ account_id: 'b', credit_cents: 100 }),
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Line 1: choose an account/);
  });

  it('rejects non-integer cents', () => {
    const res = validateBalance([
      line({ account_id: 'a', debit_cents: 100.5 }),
      line({ account_id: 'b', credit_cents: 100.5 }),
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/whole cents/);
  });

  it('rejects negative amounts', () => {
    const res = validateBalance([
      line({ account_id: 'a', debit_cents: -100 }),
      line({ account_id: 'b', credit_cents: -100 }),
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/cannot be negative/);
  });

  it('rejects a line that is both a debit and a credit', () => {
    const res = validateBalance([
      line({ account_id: 'a', debit_cents: 100, credit_cents: 100 }),
      line({ account_id: 'b', credit_cents: 100 }),
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/a debit or a credit, not both/);
  });

  it('rejects a line with neither a debit nor a credit', () => {
    const res = validateBalance([
      line({ account_id: 'a' }),
      line({ account_id: 'b', credit_cents: 100 }),
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/enter a debit or a credit/);
  });

  it('rejects debits != credits', () => {
    const res = validateBalance([
      line({ account_id: 'a', debit_cents: 60_000 }),
      line({ account_id: 'b', credit_cents: 50_000 }),
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Unbalanced/);
  });

  it('rejects a zero-amount balanced entry', () => {
    const res = validateBalance([
      line({ account_id: 'a', debit_cents: 0, credit_cents: 0 }),
      line({ account_id: 'b', debit_cents: 0, credit_cents: 0 }),
    ]);
    // caught earlier as "enter a debit or a credit"
    expect(res.ok).toBe(false);
  });
});

// ─── cadence ────────────────────────────────────────────────────────────────

describe('cadenceStepMonths', () => {
  it('monthly steps 1, quarterly steps 3', () => {
    expect(cadenceStepMonths('MONTHLY')).toBe(1);
    expect(cadenceStepMonths('QUARTERLY')).toBe(3);
  });
});

// ─── occurrence enumeration ─────────────────────────────────────────────────

describe('enumerateOccurrences — monthly', () => {
  const occ = enumerateOccurrences('2026-01-15', 'MONTHLY', { throughAsOf: '2026-06-30' });

  it('produces one occurrence per month from the start month through asOf', () => {
    expect(occ.map((o) => o.period)).toEqual([
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
    ]);
  });

  it('posts on the last calendar day of each occurrence month', () => {
    expect(occ[0].postDate).toBe('2026-01-31');
    expect(occ[1].postDate).toBe('2026-02-28');
    expect(occ[occ.length - 1].postDate).toBe('2026-06-30');
  });

  it('indexes occurrences from 0', () => {
    expect(occ[0].index).toBe(0);
    expect(occ[5].index).toBe(5);
  });
});

describe('enumerateOccurrences — quarterly', () => {
  it('steps three months at a time', () => {
    const occ = enumerateOccurrences('2026-01-01', 'QUARTERLY', { throughAsOf: '2026-12-31' });
    expect(occ.map((o) => o.period)).toEqual(['2026-01', '2026-04', '2026-07', '2026-10']);
  });
});

describe('enumerateOccurrences — bounds', () => {
  it('respects an inclusive end date', () => {
    const occ = enumerateOccurrences('2026-01-01', 'MONTHLY', { endDate: '2026-03-31' });
    expect(occ.map((o) => o.period)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('returns empty when the end date precedes the start month', () => {
    const occ = enumerateOccurrences('2026-06-01', 'MONTHLY', { endDate: '2026-03-31' });
    expect(occ).toEqual([]);
  });

  it('is never unbounded — caps when neither end nor asOf is given', () => {
    const occ = enumerateOccurrences('2026-01-01', 'MONTHLY', { maxOccurrences: 5 });
    expect(occ).toHaveLength(5);
  });

  it('crosses a year boundary correctly', () => {
    const occ = enumerateOccurrences('2026-11-01', 'MONTHLY', { throughAsOf: '2027-02-28' });
    expect(occ.map((o) => o.period)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });

  it('throws on an impossible calendar date', () => {
    expect(() => enumerateOccurrences('2026-02-30', 'MONTHLY', { maxOccurrences: 1 })).toThrow(
      RecurringJeError,
    );
  });
});

// ─── nextDuePeriods (the double-generate guard) ─────────────────────────────

describe('nextDuePeriods', () => {
  const template: RecurringJeTemplate = {
    cadence: 'MONTHLY',
    startDate: '2026-01-01',
    endDate: null,
    lines: [
      line({ account_id: 'a', debit_cents: 100 }),
      line({ account_id: 'b', credit_cents: 100 }),
    ],
  };

  it('returns all due periods when none have been generated', () => {
    const due = nextDuePeriods(template, { asOf: '2026-03-31' });
    expect(due.map((d) => d.period)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('excludes periods already generated (the double-post guard mirror)', () => {
    const generated = new Set(['2026-01', '2026-02']);
    const due = nextDuePeriods(template, { asOf: '2026-03-31', generated });
    expect(due.map((d) => d.period)).toEqual(['2026-03']);
  });

  it('returns nothing when every due period is already generated (idempotent)', () => {
    const generated = new Set(['2026-01', '2026-02', '2026-03']);
    const due = nextDuePeriods(template, { asOf: '2026-03-31', generated });
    expect(due).toEqual([]);
  });

  it('does not propose a period beyond asOf', () => {
    const due = nextDuePeriods(template, { asOf: '2026-02-15' });
    expect(due.map((d) => d.period)).toEqual(['2026-01', '2026-02']);
  });
});

describe('nextOccurrence', () => {
  const template: RecurringJeTemplate = {
    cadence: 'QUARTERLY',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    lines: [],
  };

  it('returns the first occurrence at or after a date', () => {
    const next = nextOccurrence(template, '2026-05-01');
    expect(next?.period).toBe('2026-07');
  });

  it('returns the start occurrence when asked from before the start', () => {
    const next = nextOccurrence(template, '2025-12-01');
    expect(next?.period).toBe('2026-01');
  });

  it('returns null once past the end date', () => {
    const next = nextOccurrence(template, '2027-01-01');
    expect(next).toBeNull();
  });
});

// ─── line projection ────────────────────────────────────────────────────────

describe('buildEntryLines', () => {
  it('defaults each line location to the template location and preserves amounts', () => {
    const out = buildEntryLines(
      [
        line({ account_id: 'a', debit_cents: 100 }),
        line({ account_id: 'b', credit_cents: 100, location_id: 'other-loc' }),
      ],
      { locationId: 'tmpl-loc' },
    );
    expect(out[0].location_id).toBe('tmpl-loc');
    expect(out[1].location_id).toBe('other-loc');
    expect(validateBalance(out).ok).toBe(true);
  });
});

// ─── allocation ─────────────────────────────────────────────────────────────

describe('allocateEvenly', () => {
  it('splits evenly when divisible', () => {
    expect(allocateEvenly(90_000, 3)).toEqual([30_000, 30_000, 30_000]);
  });

  it('puts the rounding remainder on the last bucket and sums to the total', () => {
    const parts = allocateEvenly(100_000, 3);
    expect(parts).toEqual([33_333, 33_333, 33_334]);
    expect(sum(parts)).toBe(100_000);
  });

  it('handles a single bucket', () => {
    expect(allocateEvenly(12_345, 1)).toEqual([12_345]);
  });

  it('throws on a non-positive total or a zero bucket count', () => {
    expect(() => allocateEvenly(0, 3)).toThrow(RecurringJeError);
    expect(() => allocateEvenly(100, 0)).toThrow(RecurringJeError);
  });
});

describe('buildAllocatedAccrualLines', () => {
  it('builds a balanced expense accrual split across departments (debit side)', () => {
    const lines = buildAllocatedAccrualLines({
      totalCents: 100_000,
      allocatedSide: 'debit',
      offsetAccountId: 'accrued-liability',
      buckets: [
        { account_id: 'opex', department_id: 'd1' },
        { account_id: 'opex', department_id: 'd2' },
        { account_id: 'opex', department_id: 'd3' },
      ],
    });
    expect(lines).toHaveLength(4);
    const debits = lines.filter((l) => l.debit_cents > 0);
    expect(sum(debits.map((l) => l.debit_cents))).toBe(100_000);
    expect(lines[lines.length - 1].account_id).toBe('accrued-liability');
    expect(lines[lines.length - 1].credit_cents).toBe(100_000);
    expect(validateBalance(lines).ok).toBe(true);
  });

  it('a single bucket is a plain fixed accrual that still balances', () => {
    const lines = buildAllocatedAccrualLines({
      totalCents: 50_000,
      allocatedSide: 'debit',
      offsetAccountId: 'accrued',
      buckets: [{ account_id: 'rent-expense' }],
    });
    expect(lines).toHaveLength(2);
    expect(validateBalance(lines).ok).toBe(true);
  });

  it('honors weights and keeps the result balanced with the remainder on the last bucket', () => {
    const lines = buildAllocatedAccrualLines({
      totalCents: 100_000,
      allocatedSide: 'debit',
      offsetAccountId: 'accrued',
      buckets: [
        { account_id: 'opex', department_id: 'd1', weight: 1 },
        { account_id: 'opex', department_id: 'd2', weight: 3 },
      ],
    });
    const debits = lines.filter((l) => l.debit_cents > 0).map((l) => l.debit_cents);
    expect(debits).toEqual([25_000, 75_000]);
    expect(validateBalance(lines).ok).toBe(true);
  });

  it('builds a credit-side allocation (offset on the debit side) that balances', () => {
    const lines = buildAllocatedAccrualLines({
      totalCents: 60_000,
      allocatedSide: 'credit',
      offsetAccountId: 'prepaid-asset',
      buckets: [
        { account_id: 'rev', department_id: 'd1' },
        { account_id: 'rev', department_id: 'd2' },
      ],
    });
    expect(lines[0].account_id).toBe('prepaid-asset');
    expect(lines[0].debit_cents).toBe(60_000);
    expect(validateBalance(lines).ok).toBe(true);
  });

  it('throws on no buckets or a non-positive total', () => {
    expect(() =>
      buildAllocatedAccrualLines({ totalCents: 100, allocatedSide: 'debit', offsetAccountId: 'x', buckets: [] }),
    ).toThrow(RecurringJeError);
    expect(() =>
      buildAllocatedAccrualLines({
        totalCents: 0,
        allocatedSide: 'debit',
        offsetAccountId: 'x',
        buckets: [{ account_id: 'a' }],
      }),
    ).toThrow(RecurringJeError);
  });
});
