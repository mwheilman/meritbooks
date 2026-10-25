/**
 * Development returns (RED-07) — the mirror of migration 1122's pm.dev_irr / pm.dev_compute_pro_forma,
 * used for the live preview while an analyst types. The stored figures are always the database's
 * (deterministic, versioned); this file only shows the same number before saving. Pure.
 *
 *   yield on cost = NOI ÷ total cost        LTC = loan ÷ total cost
 *   DSCR = NOI ÷ annual debt service        (interest only when no amortization)
 *   equity multiple = Σ inflows ÷ Σ contributions
 *   IRR: bisection on [-0.99, 10], 200 iterations, |NPV| < 1e-10 — rounded to 6 places
 */

import { monthlyPayment as fsMonthlyPayment } from '../fieldservice/pricing';

export interface ProFormaInputs {
  totalCostCents: number;
  loanCents?: number | null;
  interestRate?: number | null;
  /** Amortization in years; null / 0 = interest only. */
  amortYears?: number | null;
  noiAnnualCents?: number | null;
  /** Equity cash flows by period: contributions negative, distributions positive. */
  equityCashFlowsCents: number[];
  /** 1 = annual periods, 12 = monthly. */
  periodsPerYear?: number;
}

export interface ProFormaResults {
  yieldOnCost: number | null;
  ltc: number | null;
  annualDebtServiceCents: number;
  dscr: number | null;
  equityMultiple: number | null;
  irrPeriod: number | null;
  irrAnnual: number | null;
  equityInCents: number;
  equityOutCents: number;
}

const round = (v: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

function npv(flows: number[], rate: number): number {
  let s = 0;
  for (let k = 0; k < flows.length; k++) s += (flows[k] ?? 0) / (1 + rate) ** k;
  return s;
}

export function irr(flows: number[]): number | null {
  if (flows.length < 2) return null;
  let lo = -0.99;
  let hi = 10;
  let fLo = npv(flows, lo);
  const fHi = npv(flows, hi);
  if (Math.sign(fLo) === Math.sign(fHi)) return null;
  let mid = lo;
  for (let i = 0; i < 200; i++) {
    mid = (lo + hi) / 2;
    const fMid = npv(flows, mid);
    if (Math.abs(fMid) < 1e-10 || (hi - lo) / 2 < 1e-12) break;
    if (Math.sign(fMid) === Math.sign(fLo)) {
      lo = mid;
      fLo = fMid;
    } else {
      hi = mid;
    }
  }
  return round(mid, 6);
}

/** Level monthly payment (cents) — the exact pm.fs_monthly_payment mirror (fixed point, half-up). */
export const monthlyPayment = fsMonthlyPayment;

export function computeProForma(i: ProFormaInputs): ProFormaResults {
  const cost = i.totalCostCents;
  const loan = i.loanCents ?? 0;
  const rate = i.interestRate ?? 0;
  const noi = i.noiAnnualCents ?? null;
  const ds = loan <= 0 ? 0 : !i.amortYears || i.amortYears <= 0 ? Math.round(loan * rate) : monthlyPayment(loan, rate, Math.round(i.amortYears * 12)) * 12;
  const flows = i.equityCashFlowsCents;
  const inflow = flows.filter((x) => x < 0).reduce((s, x) => s - x, 0);
  const outflow = flows.filter((x) => x > 0).reduce((s, x) => s + x, 0);
  const ip = irr(flows);
  const ppy = i.periodsPerYear ?? 1;
  return {
    yieldOnCost: cost > 0 && noi != null ? round(noi / cost, 5) : null,
    ltc: cost > 0 ? round(loan / cost, 5) : null,
    annualDebtServiceCents: ds,
    dscr: ds > 0 && noi != null ? round(noi / ds, 3) : null,
    equityMultiple: inflow > 0 ? round(outflow / inflow, 3) : null,
    irrPeriod: ip,
    irrAnnual: ip == null ? null : ppy === 1 ? ip : round((1 + ip) ** ppy - 1, 6),
    equityInCents: inflow,
    equityOutCents: outflow,
  };
}

/** In-balance arithmetic (RED-14), mirror of pm._dev_in_balance: gap > 0 = out of balance. */
export function inBalance(ecacCents: number, paidCents: number, remainingSourcesCents: number): { costToCompleteCents: number; gapCents: number; inBalance: boolean } {
  const ctc = ecacCents - paidCents;
  const gap = ctc - remainingSourcesCents;
  return { costToCompleteCents: ctc, gapCents: gap, inBalance: gap <= 0 };
}
