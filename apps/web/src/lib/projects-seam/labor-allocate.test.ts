/**
 * Labor allocation math (migration 194) — pure, integer cents. Job labor = ACTUAL payroll cost
 * (gross + employer tax + employer benefits) split over the jobs worked by hours; every cent is
 * accounted for (jobs + "not on a job" = payroll cost), and nothing is costed at a guessed rate.
 */
import { describe, it, expect } from 'vitest';
import { allocateLabor, splitLargestRemainder, standardCostCents, type JobHourRow } from './labor-allocate';

const row = (id: string, employeeId: string | null, jobId: string, hours: number, accruedCents = 0): JobHourRow => ({
  id, employeeId, jobId, costCodeId: null, costCode: null, departmentId: null, hours, accruedCents,
});

describe('splitLargestRemainder', () => {
  it('sums exactly to the total and breaks ties toward the earlier weight', () => {
    expect(splitLargestRemainder(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(splitLargestRemainder(15_300, [3000, 5000, 0])).toEqual([5738, 9562, 0]);
    expect(splitLargestRemainder(0, [1, 2])).toEqual([0, 0]);
    expect(splitLargestRemainder(5, [0, 0])).toEqual([0, 0]);
    for (const total of [1, 7, 99_999, 123_457]) {
      const w = [333, 17, 4_000, 1];
      expect(splitLargestRemainder(total, w).reduce((s, x) => s + x, 0)).toBe(total);
    }
  });
});

describe('allocateLabor', () => {
  it('all paid hours on jobs → the whole cost goes to the jobs (wages, tax and benefits each split by hours)', () => {
    const a = allocateLabor(
      [{ employeeId: 'ann', grossCents: 200_000, employerTaxCents: 15_300, benefitsCents: 10_000, paidHours: 80 }],
      [row('h1', 'ann', 'job1', 30), row('h2', 'ann', 'job2', 50)],
    );
    expect(a.totals).toMatchObject({ payrollCostCents: 225_300, allocatedCents: 225_300, unallocatedCostCents: 0, allocatedHours: 80 });
    const j1 = a.rows.find((r) => r.jobId === 'job1')!;
    expect(j1).toMatchObject({ wagesCents: 75_000, employerTaxCents: 5_738, benefitsCents: 3_750, amountCents: 84_488 });
  });

  it('paid time not on a job stays in payroll expense (the remainder bucket), to the cent', () => {
    const a = allocateLabor([{ employeeId: 'bo', grossCents: 100_000, employerTaxCents: 7_650, benefitsCents: 0, paidHours: 40 }], [row('h', 'bo', 'job1', 10)]);
    expect(a.rows[0]).toMatchObject({ wagesCents: 25_000, employerTaxCents: 1_913, amountCents: 26_913 });
    expect(a.remainders[0]).toMatchObject({ wagesCents: 75_000, employerTaxCents: 5_737, hours: 30 });
    expect(a.totals.allocatedCents + a.totals.unallocatedCostCents).toBe(a.totals.payrollCostCents);
  });

  it('more job hours than paid hours (or paid hours unknown) → all of the pay goes to the jobs, never more', () => {
    const over = allocateLabor([{ employeeId: 'x', grossCents: 50_000, employerTaxCents: 0, benefitsCents: 0, paidHours: 20 }], [row('a', 'x', 'j', 15), row('b', 'x', 'k', 15)]);
    expect(over.totals.allocatedCents).toBe(50_000);
    const unknown = allocateLabor([{ employeeId: 'x', grossCents: 50_001, employerTaxCents: 0, benefitsCents: 0, paidHours: null }], [row('a', 'x', 'j', 1), row('b', 'x', 'k', 1)]);
    expect(unknown.rows.map((r) => r.amountCents).sort()).toEqual([25_000, 25_001]);
  });

  it('hours with no payroll line (or no Books employee) are unallocated hours — never costed at a guessed rate', () => {
    const a = allocateLabor([], [row('a', 'cy', 'j', 8), row('b', null, 'j', 2)]);
    expect(a.rows).toHaveLength(0);
    expect(a.totals.unallocatedHours).toBe(10);
  });

  it('an employee on payroll with no job hours keeps their whole cost in payroll expense', () => {
    const a = allocateLabor([{ employeeId: 'z', grossCents: 10_000, employerTaxCents: 765, benefitsCents: 0, paidHours: 40 }], []);
    expect(a.totals).toMatchObject({ allocatedCents: 0, unallocatedCostCents: 10_765 });
  });

  it('reports the standard-rate accrual being trued up', () => {
    const a = allocateLabor([{ employeeId: 'd', grossCents: 60_000, employerTaxCents: 4_590, benefitsCents: 0, paidHours: 10 }], [row('h', 'd', 'j', 10, 50_000)]);
    expect(a.totals).toMatchObject({ allocatedCents: 64_590, accrualReversedCents: 50_000 });
  });

  it('standardCostCents = round(hours × rate)', () => {
    expect(standardCostCents(7.5, 4_313)).toBe(32_348);
    expect(standardCostCents(10, null)).toBe(0);
    expect(standardCostCents(10, 0)).toBe(0);
  });
});
