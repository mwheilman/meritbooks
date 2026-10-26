/**
 * Labor allocation math — PURE, integer cents (migration 194; owner decision 2026-10-21).
 *
 * Job labor cost = ACTUAL payroll cost from the posted run — gross wages + employer payroll
 * taxes + employer-paid benefits — allocated to jobs by the hours each employee worked on them
 * (Projects time). This is NOT the retired overhead / burden-rate engine: no shared pool, no plug
 * rate; every cent comes from the employee's own payroll line.
 *
 * Per employee:
 *   denominator D = max(paid hours on the payroll line, Σ approved job hours in the pay period)
 *     (paid hours unknown → Σ job hours, i.e. all of the pay goes to the jobs worked);
 *   each cost component C (wages / employer tax / benefits) is split over the job-hour rows by
 *   h / D with the LARGEST-REMAINDER method across the rows PLUS an implicit "not on a job" bucket
 *   (D − Σ job hours), so Σ job shares + unallocated = C exactly, to the cent.
 * Hours are counted in hundredths (numeric(8,2)), so the weights are exact integers.
 *
 * Job hours whose employee is not on the payroll run (or has no Books employee) are returned as
 * UNALLOCATED HOURS — never costed at a guessed rate.
 */

export interface PayrollEmployeeCost {
  employeeId: string;
  grossCents: number;
  employerTaxCents: number;
  benefitsCents: number;
  /** Hours paid on the payroll line; null/0 = unknown. */
  paidHours: number | null;
}

export interface JobHourRow {
  id: string;
  employeeId: string | null;
  jobId: string;
  costCodeId: string | null;
  costCode: string | null;
  departmentId: string | null;
  hours: number;
  /** Standard-rate accrual already booked for this row (trued up by this allocation). */
  accruedCents: number;
}

export interface AllocatedRow {
  hoursRowId: string;
  employeeId: string;
  jobId: string;
  costCodeId: string | null;
  costCode: string | null;
  departmentId: string | null;
  hours: number;
  wagesCents: number;
  employerTaxCents: number;
  benefitsCents: number;
  amountCents: number;
  accrualReversedCents: number;
}

export interface EmployeeRemainder {
  employeeId: string;
  wagesCents: number;
  employerTaxCents: number;
  benefitsCents: number;
  amountCents: number;
  /** Paid hours not on any job (D − Σ job hours). */
  hours: number;
}

export interface LaborAllocation {
  rows: AllocatedRow[];
  /** Cost that stays in payroll expense (paid time not on a job). */
  remainders: EmployeeRemainder[];
  /** Approved job hours with no payroll line in this run. */
  unallocatedHours: JobHourRow[];
  totals: {
    payrollCostCents: number;
    allocatedCents: number;
    unallocatedCostCents: number;
    allocatedHours: number;
    unallocatedHours: number;
    accrualReversedCents: number;
  };
}

const toHundredths = (h: number) => Math.round(Number(h) * 100);
const cents = (v: number) => Math.max(0, Math.round(Number(v) || 0));

/**
 * Largest-remainder split of `total` over integer `weights` plus an optional trailing bucket
 * weight. Returns one share per weight (the bucket's share last). Deterministic: ties go to the
 * earlier index. Σ shares = total exactly.
 */
export function splitLargestRemainder(total: number, weights: number[]): number[] {
  const W = weights.reduce((s, w) => s + w, 0);
  if (W <= 0 || total === 0) return weights.map(() => 0);
  const base = weights.map((w) => Math.floor((total * w) / W));
  let left = total - base.reduce((s, x) => s + x, 0);
  const order = weights
    .map((w, i) => ({ i, frac: (total * w) % W }))
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
  for (let k = 0; left > 0 && k < order.length; k++, left--) base[order[k].i] += 1;
  return base;
}

export function allocateLabor(employees: PayrollEmployeeCost[], hours: JobHourRow[]): LaborAllocation {
  const byEmp = new Map<string, JobHourRow[]>();
  const unallocated: JobHourRow[] = [];
  const paidIds = new Set(employees.map((e) => e.employeeId));
  for (const h of hours) {
    if (!h.employeeId || !paidIds.has(h.employeeId) || toHundredths(h.hours) <= 0) { unallocated.push(h); continue; }
    const list = byEmp.get(h.employeeId) ?? [];
    list.push(h);
    byEmp.set(h.employeeId, list);
  }

  const rows: AllocatedRow[] = [];
  const remainders: EmployeeRemainder[] = [];
  let payrollCost = 0;
  for (const e of employees) {
    const comp = { wages: cents(e.grossCents), tax: cents(e.employerTaxCents), ben: cents(e.benefitsCents) };
    const total = comp.wages + comp.tax + comp.ben;
    payrollCost += total;
    const list = (byEmp.get(e.employeeId) ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const jobH = list.map((r) => toHundredths(r.hours));
    const jobSum = jobH.reduce((s, x) => s + x, 0);
    const paid = e.paidHours != null && e.paidHours > 0 ? toHundredths(e.paidHours) : 0;
    const D = Math.max(paid, jobSum);
    if (D === 0 || list.length === 0) {
      remainders.push({ employeeId: e.employeeId, wagesCents: comp.wages, employerTaxCents: comp.tax, benefitsCents: comp.ben, amountCents: total, hours: paid / 100 });
      continue;
    }
    const weights = [...jobH, D - jobSum];
    const w = splitLargestRemainder(comp.wages, weights);
    const t = splitLargestRemainder(comp.tax, weights);
    const b = splitLargestRemainder(comp.ben, weights);
    list.forEach((r, i) => {
      rows.push({
        hoursRowId: r.id,
        employeeId: e.employeeId,
        jobId: r.jobId,
        costCodeId: r.costCodeId,
        costCode: r.costCode,
        departmentId: r.departmentId,
        hours: jobH[i] / 100,
        wagesCents: w[i],
        employerTaxCents: t[i],
        benefitsCents: b[i],
        amountCents: w[i] + t[i] + b[i],
        accrualReversedCents: cents(r.accruedCents),
      });
    });
    const k = list.length;
    remainders.push({
      employeeId: e.employeeId, wagesCents: w[k], employerTaxCents: t[k], benefitsCents: b[k], amountCents: w[k] + t[k] + b[k],
      hours: (D - jobSum) / 100,
    });
  }

  const allocated = rows.reduce((s, r) => s + r.amountCents, 0);
  return {
    rows,
    remainders,
    unallocatedHours: unallocated,
    totals: {
      payrollCostCents: payrollCost,
      allocatedCents: allocated,
      unallocatedCostCents: payrollCost - allocated,
      allocatedHours: Math.round(rows.reduce((s, r) => s + toHundredths(r.hours), 0)) / 100,
      unallocatedHours: Math.round(unallocated.reduce((s, r) => s + toHundredths(r.hours), 0)) / 100,
      accrualReversedCents: rows.reduce((s, r) => s + r.accrualReversedCents, 0),
    },
  };
}

/** Standard-rate estimate for one hours row (accrual): round(hours × rate). */
export function standardCostCents(hours: number, rateCents: number | null | undefined): number {
  if (rateCents == null || !Number.isFinite(Number(rateCents)) || Number(rateCents) <= 0) return 0;
  return Math.round((toHundredths(hours) * Math.round(Number(rateCents))) / 100);
}
