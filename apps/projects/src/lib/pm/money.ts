/**
 * Job money math on integer cents, formatted only through @meritbooks/merit-ui.
 * Projected margin = revised contract − cost estimate (pm.v_job_money's one
 * computation: latest approved revised budget, else original + approved CO cost).
 */
import { money, pct, ratio } from '@meritbooks/merit-ui';

export interface JobMoney {
  contract_revised_cents: number;
  cost_estimate_cents: number;
  budget_total_cents: number | null;
}

export function marginCents(m: JobMoney): number {
  return m.contract_revised_cents - m.cost_estimate_cents;
}

/** Margin as a fraction of revised contract; NaN when there is no contract. */
export function marginFraction(m: JobMoney): number {
  return ratio(marginCents(m), m.contract_revised_cents);
}

/** "18.4%" or "—" when there is no contract to divide by. */
export function marginPctText(m: JobMoney): string {
  const f = marginFraction(m);
  return Number.isFinite(f) ? pct(f) : '—';
}

/** Table money: "3,184.62" / "(4,454.42)"; null → em dash. */
export function cents(v: number | null | undefined, decimals: 0 | 2 = 2): string {
  return v == null ? '—' : money(v, { decimals });
}

/** Whole-dollar money for dense comparisons ("vs original 412,000"). */
export function dollars(v: number | null | undefined): string {
  return cents(v, 0);
}

/** A job is at risk when its cost estimate exceeds its contract, or the budget is over contract. */
export function isOverBudget(m: JobMoney): boolean {
  if (m.contract_revised_cents <= 0) return false;
  return m.cost_estimate_cents > m.contract_revised_cents || (m.budget_total_cents ?? 0) > m.contract_revised_cents;
}

export function sumBy<T>(rows: ReadonlyArray<T>, f: (r: T) => number | null | undefined): number {
  let s = 0;
  for (const r of rows) s += f(r) ?? 0;
  return s;
}
